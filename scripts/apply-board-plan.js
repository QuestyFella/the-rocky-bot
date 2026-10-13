// Reorganizes a server's tasks from a JSON plan: new titles (and so categories),
// which board each task is on, and which same-category tasks block it.
//
//   node scripts/apply-board-plan.js --guild ID --plan plan.json          (preview)
//   node scripts/apply-board-plan.js --guild ID --plan plan.json --apply  (save, with a backup)
//
// Plan rows: { "key": "URC-14", "title": "[FIRMWARE] ...", "board": "exec", "blockedBy": ["URC-13"] }
// "title", "board" and "blockedBy" are optional. Tasks not in the plan keep their title and board.
// Stop the bot first: it caches tasks in memory and would overwrite the change.
const fs = require('fs');
const path = require('path');
const { dataPath } = require('../utils/dataPaths');
const { getTaskTag } = require('../utils/taskTags');
const { getIssueKey, getTaskStatus } = require('../utils/kanban');

const oldDependencyFields = ['dependsOn', 'dependsOnTags', 'hardDependsOn', 'hardDependsOnTags'];

function applyPlan(tasks, plan) {
    const errors = [];
    const byKey = new Map(tasks.map(task => [getIssueKey(task).toUpperCase(), task]));
    const next = tasks.map(task => {
        const copy = { ...task };
        for (const field of oldDependencyFields) delete copy[field];
        return copy;
    });
    const nextById = new Map(next.map(task => [task.id, task]));
    const seen = new Set();
    for (const row of plan) {
        const key = String(row.key || '').toUpperCase();
        const task = byKey.get(key);
        if (!task) { errors.push(`${row.key}: no task with this key.`); continue; }
        if (seen.has(key)) { errors.push(`${row.key}: listed twice.`); continue; }
        seen.add(key);
        const target = nextById.get(task.id);
        if (row.title !== undefined) {
            if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200) errors.push(`${row.key}: title must have 1–200 characters.`);
            else target.title = row.title.trim();
        }
        if (row.board !== undefined) {
            if (!['main', 'exec'].includes(row.board)) errors.push(`${row.key}: board must be "main" or "exec".`);
            else if (row.board === 'exec') target.board = 'exec';
            else delete target.board;
        }
    }
    // Resolve blockers after every title and board is set, so category checks use the new tags.
    for (const row of plan) {
        const task = byKey.get(String(row.key || '').toUpperCase());
        if (!task || row.blockedBy === undefined) continue;
        const target = nextById.get(task.id);
        target.blockedBy = [];
        for (const blockerKey of row.blockedBy) {
            const blocker = byKey.get(String(blockerKey).toUpperCase());
            if (!blocker) { errors.push(`${row.key}: blocker ${blockerKey} does not exist.`); continue; }
            const other = nextById.get(blocker.id);
            if (other.id === target.id) errors.push(`${row.key}: a task cannot block itself.`);
            else if (getTaskTag(other).id !== getTaskTag(target).id) errors.push(`${row.key}: blocker ${blockerKey} is in ${getTaskTag(other).name}, not ${getTaskTag(target).name}.`);
            else if ((other.board || 'main') !== (target.board || 'main')) errors.push(`${row.key}: blocker ${blockerKey} is on a different board.`);
            else if (!target.blockedBy.includes(other.id)) target.blockedBy.push(other.id);
        }
    }
    const visiting = new Set();
    const done = new Set();
    const visit = task => {
        if (done.has(task.id)) return false;
        if (visiting.has(task.id)) return true;
        visiting.add(task.id);
        const loop = (task.blockedBy || []).some(id => nextById.has(id) && visit(nextById.get(id)));
        visiting.delete(task.id);
        done.add(task.id);
        return loop;
    };
    for (const task of next) if (visit(task)) errors.push(`${getIssueKey(task)}: its blockers form a loop.`);
    return { tasks: next, errors };
}

function summarize(tasks) {
    const lines = [];
    for (const board of ['main', 'exec']) {
        const onBoard = tasks.filter(task => (task.board || 'main') === board);
        lines.push(`\n=== ${board} board (${onBoard.length} tasks)`);
        const tags = [...new Set(onBoard.map(task => getTaskTag(task).name))].sort();
        for (const tag of tags) {
            const inTag = onBoard.filter(task => getTaskTag(task).name === tag);
            lines.push(`\n[${tag}]`);
            for (const task of inTag) {
                const blockers = (task.blockedBy || []).map(id => tasks.find(other => other.id === id)).filter(other => other && getTaskStatus(other) !== 'done');
                lines.push(`  ${blockers.length ? '🔒' : '  '} ${getIssueKey(task)} ${getTaskTag(task).title}${blockers.length ? `  ← ${blockers.map(getIssueKey).join(', ')}` : ''}`);
            }
        }
    }
    return lines.join('\n');
}

function main() {
    const args = process.argv.slice(2);
    const option = name => args[args.indexOf(name) + 1];
    const guildId = args.includes('--guild') && option('--guild');
    const planFile = args.includes('--plan') && option('--plan');
    if (!guildId || !planFile) {
        console.error('Usage: node scripts/apply-board-plan.js --guild ID --plan plan.json [--apply]');
        process.exit(1);
    }
    const file = dataPath('server-tasks', `${guildId}.json`);
    const tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { tasks: next, errors } = applyPlan(tasks, JSON.parse(fs.readFileSync(planFile, 'utf8')));
    console.log(summarize(next));
    if (errors.length) {
        console.error(`\n${errors.length} problem(s); nothing was saved:\n${errors.map(error => `  - ${error}`).join('\n')}`);
        process.exit(1);
    }
    if (!args.includes('--apply')) {
        console.log('\nPreview only. Stop the bot, rerun with --apply, then start the bot.');
        return;
    }
    const backup = `${file}.before-plan-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    console.log(`\nSaved ${path.basename(file)}. Backup: ${backup}`);
}

if (require.main === module) main();

module.exports = { applyPlan, summarize };
