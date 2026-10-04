const { randomUUID } = require('crypto');
const { normalizePriority } = require('./kanban');
const { getConfiguredTeams, getTaskTeam } = require('./teams');

const maxImportTasks = 250;
const maxImportBytes = 256 * 1024;
const previewLifetimeMs = 15 * 60 * 1000;
const fieldNames = { title: 'title', description: 'description', priority: 'priority', 'due date': 'dueDate', team: 'teamName' };

function parseTaskList(input) {
    const errors = [];
    const tasks = [];
    if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maxImportBytes) {
        return { tasks, errors: ['Use a text file of at most 256 KiB.'] };
    }
    if (input.includes('\0')) return { tasks, errors: ['Use a UTF-8 text file. Binary files cannot be imported.'] };
    const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const declaredCount = text.match(/^.*\bTASKS\s*\((\d+)\)\s*$/im)?.[1];
    // Remove section headings without changing line numbers used in errors.
    const lines = text.replace(/^[ \t]*={3,}[ \t]*\n[^\n]*\n[ \t]*={3,}[ \t]*$/gm, match => '\n'.repeat(match.split('\n').length - 1)).split('\n');
    let current = null;
    let lastField = null;
    let number = null;
    function finish() {
        if (!current) return;
        const label = `Task ${current.number}`;
        const title = current.title.trim();
        const description = (current.description || '').trim();
        const priority = current.priority?.trim() ? normalizePriority(current.priority) : 'medium';
        const dueDate = current.dueDate?.trim() || null;
        const teamName = current.teamName?.trim() || null;
        if (!title || title.length > 200) errors.push(`${label}: title must have 1–200 characters.`);
        if (description.length > 2000) errors.push(`${label}: description exceeds 2,000 characters.`);
        if (!priority) errors.push(`${label}: priority must be low, medium, high, or urgent.`);
        const noDue = !dueDate || dueDate.toLowerCase() === 'none';
        if (!noDue && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)) || new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate)) {
            errors.push(`${label}: enter a real due date in YYYY-MM-DD format.`);
        }
        if (teamName && teamName.length > 50) errors.push(`${label}: team name exceeds 50 characters.`);
        tasks.push({ number: current.number, title, description, priority, dueDate: noDue ? null : dueDate, teamName: teamName?.toLowerCase() === 'none' ? null : teamName });
        current = null;
        lastField = null;
    }
    for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        if (/^```(?:text|txt)?\s*$/i.test(trimmed) || /^={3,}$/.test(trimmed)) continue;
        if (/^.*\bTASKS\s*\(\d+\)\s*$/i.test(trimmed) || /^Fields per task\s*:/i.test(trimmed)) continue;
        if (/^\d+\.\s*$/.test(trimmed)) {
            finish();
            number = Number.parseInt(trimmed, 10);
            continue;
        }
        const field = line.match(/^\s*(Title|Description|Priority|Due date|Team)\s*:\s?(.*)$/i);
        if (field) {
            const name = fieldNames[field[1].toLowerCase()];
            if (name === 'title') {
                finish();
                current = { number: number || tasks.length + 1, title: field[2] };
                number = null;
            } else if (!current) errors.push(`Line ${index + 1}: put Title before ${field[1]}.`);
            else if (Object.hasOwn(current, name)) errors.push(`Task ${current.number}: ${field[1]} appears twice.`);
            else current[name] = field[2];
            lastField = name;
        } else if (current && lastField === 'description') current.description += `\n${line}`;
        else if (trimmed) errors.push(`Line ${index + 1}: unexpected text. Use Title, Description, Priority, Due date, and Team fields.`);
    }
    finish();
    if (!tasks.length) errors.push('No tasks found. Start each task with Title: followed by its fields.');
    if (tasks.length > maxImportTasks) errors.push(`Import up to ${maxImportTasks} tasks at a time.`);
    if (declaredCount && Number(declaredCount) !== tasks.length) errors.push(`The heading says ${declaredCount} tasks, but the list contains ${tasks.length}.`);
    return { tasks, errors };
}

async function readImportInput(text, attachments = [], fetchFile = globalThis.fetch) {
    if (text?.trim() && attachments.length) throw new Error('Paste a list or upload a file, using one input at a time.');
    if (!attachments.length) {
        if (!text?.trim()) throw new Error('Paste your task list or upload a .txt file.');
        return text;
    }
    if (attachments.length !== 1) throw new Error('Upload one .txt or .md file at a time.');
    const file = attachments[0];
    if (!/\.(txt|md)$/i.test(file.name || '')) throw new Error('Upload a .txt or .md file containing your task list.');
    if (file.size > maxImportBytes) throw new Error('Use a text file of at most 256 KiB.');
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.port || url.username || url.password || !/^\/(?:ephemeral-)?attachments\//.test(url.pathname)) {
        throw new Error('Upload the file directly to Discord. External download links cannot be imported.');
    }
    try {
        const response = await fetchFile(url.href, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('Download failed');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > maxImportBytes) throw new Error('File too large');
            chunks.push(Buffer.from(chunk));
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
        throw new Error('Could not read the file. Upload a fresh UTF-8 .txt file of at most 256 KiB and try again.');
    }
}

function taskIdentity(title, teamId) {
    return JSON.stringify([title.trim().toLowerCase(), teamId || null]);
}

function prepareImport(actor, text) {
    const { tasks, errors } = parseTaskList(text);
    const teams = getConfiguredTeams(actor);
    const existing = new Set(actor.client.taskStorage.getAllTasks(actor.guild.id).map(task => taskIdentity(task.title, getTaskTeam(task, actor)?.id)));
    const seen = new Map();
    const rows = tasks.map(task => {
        const team = task.teamName ? teams.find(team => team.name.toLowerCase() === task.teamName.toLowerCase()) : null;
        if (task.teamName && !team) errors.push(`Task ${task.number}: team "${task.teamName}" is not configured. Add it using Setup Teams, then try again.`);
        const key = taskIdentity(task.title, team?.id);
        const previous = seen.get(key);
        if (previous && ['description', 'priority', 'dueDate'].some(field => previous[field] !== task[field])) {
            errors.push(`Task ${task.number}: its title and team repeat task ${previous.number} with different details. Give them distinct titles.`);
        }
        const duplicate = existing.has(key) || Boolean(previous);
        seen.set(key, task);
        return { ...task, team: team || null, duplicate };
    });
    if (errors.length) return { errors };
    const drafts = actor.client.taskImports ||= new Map();
    for (const [id, draft] of drafts) {
        if (draft.expiresAt <= Date.now() || (draft.guildId === actor.guild.id && draft.userId === actor.author.id)) drafts.delete(id);
    }
    if (drafts.size >= 100) drafts.delete(drafts.keys().next().value);
    const draft = { id: randomUUID(), guildId: actor.guild.id, userId: actor.author.id, channelId: actor.channelId, expiresAt: Date.now() + previewLifetimeMs, rows };
    drafts.set(draft.id, draft);
    return { draft };
}

function getImportDraft(actor, id) {
    const drafts = actor.client.taskImports;
    const draft = drafts?.get(id);
    if (!draft || draft.expiresAt <= Date.now()) {
        if (draft) drafts.delete(id);
        return { error: 'This import preview expired or was already used. Upload or paste the list again.' };
    }
    if (draft.userId !== actor.author.id || draft.guildId !== actor.guild.id || draft.channelId !== actor.channelId) {
        return { error: 'Only the person who submitted this list can use its preview, in the original server and channel.' };
    }
    return { draft };
}

function commitImport(actor, draft) {
    const existing = actor.client.taskStorage.getAllTasks(actor.guild.id);
    const identities = new Set(existing.map(task => taskIdentity(task.title, getTaskTeam(task, actor)?.id)));
    const configured = getConfiguredTeams(actor);
    const toImport = [];
    for (const row of draft.rows) {
        const identity = taskIdentity(row.title, row.team?.id);
        if (row.duplicate || identities.has(identity)) continue;
        if (row.team && !configured.some(team => team.id === row.team.id)) return { error: `Team "${row.team.name}" was removed. Preview the list again before importing.` };
        identities.add(identity);
        toImport.push({ ...row, team: configured.find(team => team.id === row.team?.id) || null });
    }
    const board = require('../commands/board');
    const created = toImport.map(row => board.createIssue(actor, { ...row, status: 'todo' }));
    // Save the whole batch once, without yielding between duplicate checks and storage.
    if (created.length && !actor.client.taskStorage.saveTasks(actor.guild.id, [...existing, ...created])) return { error: 'Failed to save tasks. No tasks from this import were added. You can retry Import Tasks.' };
    actor.client.taskImports.delete(draft.id);
    return { created, skipped: draft.rows.length - created.length };
}

module.exports = { parseTaskList, readImportInput, prepareImport, getImportDraft, commitImport, maxImportTasks, maxImportBytes };
