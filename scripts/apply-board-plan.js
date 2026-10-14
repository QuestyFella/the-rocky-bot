// Reorganizes a server's tasks from a JSON plan: titles (and so categories), boards,
// same-category blockers, due dates and descriptions; it can also add and delete tasks.
//
//   node scripts/apply-board-plan.js --guild ID --plan plan.json          (preview)
//   node scripts/apply-board-plan.js --guild ID --plan plan.json --apply  (save, with backups)
//
// Plan rows change an existing task by key, add a task, or delete one:
//   { "key": "URC-14", "title": "[FIRMWARE] ...", "board": "exec", "blockedBy": ["URC-13"],
//     "dueDate": "2026-10-18", "description": "..." }
//   { "new": "gps-fallback", "title": "[FIRMWARE] ...", "blockedBy": ["URC-24", "gps-fallback-other"] }
//   { "key": "URC-1", "delete": true }
// Every field except key/new is optional; blockedBy may name keys or the "new" names of added tasks.
// New tasks get the next issue keys from kanbanBoards.json.
// Stop the bot first: it caches tasks and board settings in memory and would overwrite the change.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { dataPath } = require('../utils/dataPaths');
const { getTaskTag } = require('../utils/taskTags');
const { getIssueKey, getTaskStatus, parseDueDate } = require('../utils/kanban');

const oldDependencyFields = ['dependsOn', 'dependsOnTags', 'hardDependsOn', 'hardDependsOnTags'];

function applyPlan(tasks, plan, { projectKey = 'TASK', nextIssueNumber = 1, now = new Date().toISOString() } = {}) {
    const errors = [];
    const next = tasks.map(task => {
        const copy = { ...task };
        for (const field of oldDependencyFields) delete copy[field];
        return copy;
    });
    const byRef = new Map(next.map(task => [getIssueKey(task).toUpperCase(), task]));
    const seen = new Set();
    const created = [];
    const deleted = new Set();

    // First pass: find or create each row's task and apply its plain fields.
    const rows = [];
    for (const row of plan) {
        const label = row.key || row.new || '(row without key)';
        let task;
        if (row.new) {
            const ref = String(row.new).toUpperCase();
            if (row.key) { errors.push(`${label}: use either "key" or "new", not both.`); continue; }
            if (byRef.has(ref)) { errors.push(`${label}: this name is already used.`); continue; }
            task = {
                id: randomUUID(), issueKey: `${projectKey}-${nextIssueNumber++}`, title: '', description: '', dueDate: null,
                status: 'todo', completed: false, createdAt: now, updatedAt: now, userIds: [], createdBy: null
            };
            byRef.set(ref, task);
            next.push(task);
            created.push(task);
            if (!row.title) errors.push(`${label}: a new task needs a title.`);
        } else {
            task = byRef.get(String(row.key || '').toUpperCase());
            if (!task) { errors.push(`${label}: no task with this key.`); continue; }
            if (seen.has(task.id)) { errors.push(`${label}: listed twice.`); continue; }
        }
        seen.add(task.id);
        if (row.delete) {
            if (row.new) errors.push(`${label}: a new task cannot be deleted.`);
            deleted.add(task.id);
            continue;
        }
        if (row.title !== undefined) {
            if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200) errors.push(`${label}: title must have 1–200 characters.`);
            else task.title = row.title.trim();
        }
        if (row.description !== undefined) {
            if (typeof row.description !== 'string' || row.description.length > 2000) errors.push(`${label}: description must be text of at most 2,000 characters.`);
            else task.description = row.description.trim();
        }
        if (row.dueDate !== undefined) {
            const due = parseDueDate(row.dueDate ?? '');
            if (!due.ok) errors.push(`${label}: dueDate must be YYYY-MM-DD or null.`);
            else task.dueDate = due.dueDate;
        }
        if (row.board !== undefined) {
            if (!['main', 'exec'].includes(row.board)) errors.push(`${label}: board must be "main" or "exec".`);
            else if (row.board === 'exec') task.board = 'exec';
            else delete task.board;
        }
        if (row.title !== undefined || row.description !== undefined || row.dueDate !== undefined || row.board !== undefined) task.updatedAt = now;
        rows.push({ row, task, label });
    }

    // Second pass: blockers, once every title and board is final, so category checks use the new tags.
    for (const { row, task, label } of rows) {
        if (row.blockedBy === undefined) continue;
        task.blockedBy = [];
        for (const ref of row.blockedBy) {
            const other = byRef.get(String(ref).toUpperCase());
            if (!other) errors.push(`${label}: blocker ${ref} does not exist.`);
            else if (deleted.has(other.id)) errors.push(`${label}: blocker ${ref} is being deleted.`);
            else if (other.id === task.id) errors.push(`${label}: a task cannot block itself.`);
            else if (getTaskTag(other).id !== getTaskTag(task).id) errors.push(`${label}: blocker ${ref} is in ${getTaskTag(other).name}, not ${getTaskTag(task).name}.`);
            else if ((other.board || 'main') !== (task.board || 'main')) errors.push(`${label}: blocker ${ref} is on a different board.`);
            else if (!task.blockedBy.includes(other.id)) task.blockedBy.push(other.id);
        }
    }

    const kept = next.filter(task => !deleted.has(task.id));
    for (const task of kept) if (task.blockedBy) task.blockedBy = task.blockedBy.filter(id => !deleted.has(id));
    const byId = new Map(kept.map(task => [task.id, task]));
    const visiting = new Set();
    const done = new Set();
    const visit = task => {
        if (done.has(task.id)) return false;
        if (visiting.has(task.id)) return true;
        visiting.add(task.id);
        const loop = (task.blockedBy || []).some(id => byId.has(id) && visit(byId.get(id)));
        visiting.delete(task.id);
        done.add(task.id);
        return loop;
    };
    for (const task of kept) if (visit(task)) errors.push(`${getIssueKey(task)}: its blockers form a loop.`);
    for (const task of kept) {
        const late = (task.blockedBy || []).map(id => byId.get(id)).filter(other => other?.dueDate && task.dueDate && other.dueDate > task.dueDate);
        if (late.length) errors.push(`${getIssueKey(task)}: due ${task.dueDate}, before its blocker ${late.map(other => `${getIssueKey(other)} (${other.dueDate})`).join(', ')}.`);
    }
    return { tasks: kept, errors, created, deleted: tasks.filter(task => deleted.has(task.id)), nextIssueNumber };
}

function summarize({ tasks, created, deleted }) {
    const lines = [];
    const createdIds = new Set(created.map(task => task.id));
    for (const board of ['main', 'exec']) {
        const onBoard = tasks.filter(task => (task.board || 'main') === board);
        lines.push(`\n=== ${board} board (${onBoard.length} tasks)`);
        const tags = [...new Set(onBoard.map(task => getTaskTag(task).name))].sort();
        for (const tag of tags) {
            lines.push(`\n[${tag}]`);
            const inTag = onBoard.filter(task => getTaskTag(task).name === tag).sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9'));
            for (const task of inTag) {
                const blockers = (task.blockedBy || []).map(id => tasks.find(other => other.id === id)).filter(other => other && getTaskStatus(other) !== 'done');
                lines.push(`  ${blockers.length ? '🔒' : '  '} ${task.dueDate || '----------'} ${getIssueKey(task)}${createdIds.has(task.id) ? ' (new)' : ''} ${getTaskTag(task).title}${blockers.length ? `  ← ${blockers.map(getIssueKey).join(', ')}` : ''}`);
            }
        }
    }
    if (deleted.length) lines.push(`\nDeleted: ${deleted.map(task => `${getIssueKey(task)} "${task.title}"`).join(', ')}`);
    return lines.join('\n');
}

function writeWithBackup(file, data, stamp) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.before-plan-${stamp}`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
}

function main() {
    const args = process.argv.slice(2);
    const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
    const guildId = option('--guild');
    const planFile = option('--plan');
    if (!guildId || !planFile) {
        console.error('Usage: node scripts/apply-board-plan.js --guild ID --plan plan.json [--apply]');
        process.exit(1);
    }
    const tasksFile = dataPath('server-tasks', `${guildId}.json`);
    const boardsFile = dataPath('kanbanBoards.json');
    const boards = fs.existsSync(boardsFile) ? JSON.parse(fs.readFileSync(boardsFile, 'utf8') || '{}') : {};
    const boardConfig = boards[guildId] || {};
    const result = applyPlan(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), JSON.parse(fs.readFileSync(planFile, 'utf8')), {
        projectKey: boardConfig.projectKey || 'TASK', nextIssueNumber: boardConfig.nextIssueNumber || 1
    });
    console.log(summarize(result));
    if (result.errors.length) {
        console.error(`\n${result.errors.length} problem(s); nothing was saved:\n${result.errors.map(error => `  - ${error}`).join('\n')}`);
        process.exit(1);
    }
    if (!args.includes('--apply')) {
        console.log('\nPreview only. Stop the bot, rerun with --apply, then start the bot.');
        return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (result.created.length) {
        boards[guildId] = { ...boardConfig, nextIssueNumber: result.nextIssueNumber };
        writeWithBackup(boardsFile, boards, stamp);
    }
    writeWithBackup(tasksFile, result.tasks, stamp);
    console.log(`\nSaved ${path.basename(tasksFile)}${result.created.length ? ' and kanbanBoards.json' : ''}. Backups end in .before-plan-${stamp}`);
}

if (require.main === module) main();

module.exports = { applyPlan, summarize };
