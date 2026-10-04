const { getTaskStatus, getIssueKey, isManager } = require('./kanban');

const maxDependencies = 20;

function dependencyIds(task) {
    return [...new Set((Array.isArray(task.dependsOn) ? task.dependsOn : []).map(String))];
}

function taskReference(task) {
    return String(getIssueKey(task) || task.id).replace(/`/g, '').slice(0, 80);
}

function prerequisites(task, tasks) {
    const ids = dependencyIds(task);
    if (!ids.length) return [];
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    return ids.map(id => ({ id, task: byId.get(id) }));
}

function unfinishedPrerequisites(task, tasks) {
    return prerequisites(task, tasks).filter(dependency => !dependency.task || getTaskStatus(dependency.task) !== 'done');
}

function isBlocked(task, tasks) {
    return getTaskStatus(task) !== 'done' && unfinishedPrerequisites(task, tasks).length > 0;
}

function canViewTask(task, tasks, actor) {
    return !isBlocked(task, tasks) || Boolean(actor?.member && !actor.publicList && isManager(actor));
}

function blockingSummary(task, tasks, limit = 800) {
    const references = unfinishedPrerequisites(task, tasks).map(dependency => dependency.task ? taskReference(dependency.task) : `Deleted task ${dependency.id.slice(0, 40).replace(/`/g, '')}`);
    let text = '';
    for (const [index, reference] of references.entries()) {
        const next = `${text ? ', ' : ''}\`${reference}\``;
        if (text.length + next.length > limit) return `${text} (and ${references.length - index} more)`;
        text += next;
    }
    return text;
}

function blockingError(task, tasks) {
    const waiting = blockingSummary(task, tasks);
    const missing = unfinishedPrerequisites(task, tasks).some(dependency => !dependency.task);
    return waiting ? `This task is blocked by ${waiting}. ${missing ? 'Remove deleted prerequisites through Edit Task.' : 'Finish every prerequisite first.'}` : null;
}

function dependencyInput(task, tasks) {
    return prerequisites(task, tasks).map(dependency => dependency.task ? taskReference(dependency.task) : dependency.id).join(', ');
}

function resolveDependencies(task, input, tasks) {
    const tokens = [...new Set(String(input || '').trim().split(/[\s,]+/).filter(Boolean))];
    if (!tokens.length || (tokens.length === 1 && ['none', 'clear'].includes(tokens[0].toLowerCase()))) return { ids: [] };
    const ids = [];
    for (const token of tokens) {
        const matches = tasks.filter(candidate => String(candidate.id).toLowerCase() === token.toLowerCase() || String(getIssueKey(candidate) || '').toLowerCase() === token.toLowerCase());
        if (matches.length !== 1) return { error: `Could not identify task \`${token.replace(/`/g, '').slice(0, 80)}\` in this server. Use a task key from Browse Tasks.` };
        const id = String(matches[0].id);
        if (id === String(task.id)) return { error: 'A task cannot block itself.' };
        if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > maxDependencies) return { error: `Use at most ${maxDependencies} prerequisite tasks.` };
    const byId = new Map(tasks.map(candidate => [String(candidate.id), candidate]));
    const visited = new Set();
    const pending = [...ids];
    while (pending.length) {
        const id = pending.pop();
        if (id === String(task.id)) return { error: 'These prerequisites would create a circular dependency. Each task must be able to finish before the tasks it unlocks.' };
        if (visited.has(id)) continue;
        visited.add(id);
        const candidate = byId.get(id);
        if (candidate) pending.push(...dependencyIds(candidate));
    }
    const changed = JSON.stringify([...ids].sort()) !== JSON.stringify(dependencyIds(task).sort());
    if (changed && getTaskStatus(task) === 'done' && unfinishedPrerequisites({ dependsOn: ids }, tasks).length) {
        return { error: 'Reopen this task before adding unfinished prerequisites.' };
    }
    return { ids };
}

module.exports = { maxDependencies, dependencyIds, taskReference, prerequisites, unfinishedPrerequisites, isBlocked, canViewTask, blockingSummary, blockingError, dependencyInput, resolveDependencies };
