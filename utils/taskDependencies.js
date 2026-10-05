const { getTaskStatus, getIssueKey } = require('./kanban');
const { getTaskTag, normalizeTagName } = require('./taskTags');

const maxDependencies = 20;

function dependencyIds(task) {
    return [...new Set([...(Array.isArray(task.dependsOn) ? task.dependsOn : []), ...hardDependencyIds(task)].map(String))];
}

function dependencyTags(task) {
    return [...new Set([...(Array.isArray(task.dependsOnTags) ? task.dependsOnTags : []), ...hardDependencyTags(task)].map(normalizeTagName))];
}

const hardDependencyIds = task => [...new Set((Array.isArray(task.hardDependsOn) ? task.hardDependsOn : []).map(String))];
const hardDependencyTags = task => [...new Set((Array.isArray(task.hardDependsOnTags) ? task.hardDependsOnTags : []).map(normalizeTagName))];

function taskReference(task) {
    return String(getIssueKey(task) || task.id).replace(/`/g, '').slice(0, 80);
}

function prerequisites(task, tasks, hardOnly = false) {
    const hardIds = hardDependencyIds(task), hardTags = hardDependencyTags(task);
    const ids = hardOnly ? hardIds : dependencyIds(task);
    const tags = hardOnly ? hardTags : dependencyTags(task);
    if (!ids.length && !tags.length) return [];
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    return [
        ...ids.map(id => ({ id, task: byId.get(id), hard: hardIds.includes(id) })),
        ...tags.map(name => ({ tag: { name, tasks: tasks.filter(candidate => getTaskTag(candidate).name === name) }, hard: hardTags.includes(name) }))
    ];
}

function prerequisiteDone(dependency) {
    return dependency.tag ? dependency.tag.tasks.length > 0 && dependency.tag.tasks.every(task => getTaskStatus(task) === 'done') : Boolean(dependency.task && getTaskStatus(dependency.task) === 'done');
}

function prerequisiteLine(dependency) {
    if (dependency.tag) {
        const { name, tasks } = dependency.tag;
        const done = tasks.filter(task => getTaskStatus(task) === 'done').length;
        return `${tasks.length ? prerequisiteDone(dependency) ? '✅' : '⏳' : '⚠️'} \`[${name.replace(/`/g, '')}]\` · ${tasks.length ? `${done}/${tasks.length} Done` : 'No tasks found; add tasks or remove this tag'}${dependency.hard ? ' · Hard gate' : ''}`;
    }
    return dependency.task ? `${prerequisiteDone(dependency) ? '✅' : '⏳'} \`${taskReference(dependency.task)}\` · ${prerequisiteDone(dependency) ? 'Done' : 'Waiting'}${dependency.hard ? ' · Hard gate' : ''}` : `⚠️ Deleted task \`${dependency.id.slice(0, 80).replace(/`/g, '')}\` · Remove in Edit Task${dependency.hard ? ' · Hard gate' : ''}`;
}

function unfinishedPrerequisites(task, tasks) {
    return prerequisites(task, tasks).filter(dependency => !prerequisiteDone(dependency));
}

function isWaiting(task, tasks) {
    return getTaskStatus(task) !== 'done' && unfinishedPrerequisites(task, tasks).length > 0;
}

// Waiting is a readiness indicator. It never hides a task or prevents a claim.
const canViewTask = () => true;
const isHardBlocked = (task, tasks) => getTaskStatus(task) !== 'done' && prerequisites(task, tasks, true).some(dependency => !prerequisiteDone(dependency));

function blockingSummary(task, tasks, limit = 800, hardOnly = false) {
    const references = prerequisites(task, tasks, hardOnly).filter(dependency => !prerequisiteDone(dependency)).map(dependency => {
        if (dependency.tag) return `[${dependency.tag.name.replace(/`/g, '')}] (${dependency.tag.tasks.filter(task => getTaskStatus(task) === 'done').length}/${dependency.tag.tasks.length} Done)`;
        return dependency.task ? taskReference(dependency.task) : `Deleted task ${dependency.id.slice(0, 40).replace(/`/g, '')}`;
    });
    let text = '';
    for (const [index, reference] of references.entries()) {
        const next = `${text ? ', ' : ''}\`${reference}\``;
        if (text.length + next.length > limit) return `${text} (and ${references.length - index} more)`;
        text += next;
    }
    return text;
}

function blockingError(task, tasks) {
    const waiting = blockingSummary(task, tasks, 800, true);
    const missing = prerequisites(task, tasks, true).some(dependency => dependency.tag ? !dependency.tag.tasks.length : !dependency.task);
    return waiting ? `Hard gate: waiting on ${waiting}. You can claim this task now; Start Work and completion wait until these prerequisites are Done.${missing ? ' A prerequisite is missing. Ask a server manager to update the gate.' : ''}` : null;
}

function dependencyInput(task, tasks) {
    return prerequisites(task, tasks).map(dependency => `${dependency.hard ? '!' : ''}${dependency.tag ? `[${dependency.tag.name}]` : dependency.task ? taskReference(dependency.task) : dependency.id}`).join(', ');
}

function validateDependencyGraph(task, tasks) {
    const current = tasks.map(candidate => String(candidate.id) === String(task.id) ? task : candidate);
    const byId = new Map(current.map(candidate => [String(candidate.id), candidate]));
    const tags = new Map();
    for (const candidate of current) {
        const name = getTaskTag(candidate).name;
        if (!tags.has(name)) tags.set(name, []);
        tags.get(name).push(String(candidate.id));
    }
    if (dependencyTags(task).includes(getTaskTag(task).name)) return 'A task cannot depend on its own tag, because that tag includes the task itself.';
    const expanded = candidate => [...dependencyIds(candidate), ...dependencyTags(candidate).flatMap(name => tags.get(name) || [])];
    const visited = new Set();
    const pending = expanded(task);
    while (pending.length) {
        const id = pending.pop();
        if (id === String(task.id)) return 'These prerequisites would create a circular dependency. Each task must be able to finish before the tasks it unlocks.';
        if (visited.has(id)) continue;
        visited.add(id);
        const candidate = byId.get(id);
        if (candidate) pending.push(...expanded(candidate));
    }
    return null;
}

function resolveDependencies(task, input, tasks) {
    let remaining = String(input || '').trim().replace(/^[\s,]+/, '');
    if (!remaining || ['none', 'clear'].includes(remaining.toLowerCase())) return { ids: [], tags: [], hardIds: [], hardTags: [] };
    const current = tasks.map(candidate => String(candidate.id) === String(task.id) ? task : candidate);
    const ids = [], tags = [], hardIds = [], hardTags = [];
    while (remaining) {
        // A 50-character title tag can grow when converted to uppercase (for example, ß → SS).
        const match = remaining.match(/^(!?)(?:\[([^\[\]\r\n]{1,100})\]|([^!\s,\[\]]+))(?=[\s,]|$)/);
        const hard = Boolean(match?.[1]);
        if (!match || (match[2] && !match[2].trim())) return { error: 'Use task keys or tags in brackets, separated by commas. Example: URC-12, [POWER], !URC-3. Prefix ! for a hard gate.' };
        if (match[2]) {
            const name = normalizeTagName(match[2]);
            if (!current.some(candidate => getTaskTag(candidate).name === name)) return { error: `Could not find tag \`[${name.replace(/`/g, '')}]\` in this server. Use a tag that has tasks.` };
            if (!tags.includes(name)) tags.push(name);
            if (hard && !hardTags.includes(name)) hardTags.push(name);
        } else {
            const token = match[3];
            const matches = current.filter(candidate => String(candidate.id).toLowerCase() === token.toLowerCase() || String(getIssueKey(candidate) || '').toLowerCase() === token.toLowerCase());
            if (matches.length !== 1) return { error: `Could not identify task \`${token.replace(/`/g, '').slice(0, 80)}\` in this server. Use a task key from Browse Tasks.` };
            const id = String(matches[0].id);
            if (id === String(task.id)) return { error: 'A task cannot block itself.' };
            if (!ids.includes(id)) ids.push(id);
            if (hard && !hardIds.includes(id)) hardIds.push(id);
        }
        remaining = remaining.slice(match[0].length).replace(/^[\s,]+/, '');
    }
    if (ids.length + tags.length > maxDependencies) return { error: `Use at most ${maxDependencies} prerequisites (tasks or tags).` };
    const proposed = { ...task, dependsOn: ids, dependsOnTags: tags, hardDependsOn: hardIds, hardDependsOnTags: hardTags };
    const cycle = validateDependencyGraph(proposed, current);
    if (cycle) return { error: cycle };
    const changed = JSON.stringify([[...hardIds].sort(), [...hardTags].sort()]) !== JSON.stringify([hardDependencyIds(task).sort(), hardDependencyTags(task).sort()]);
    if (changed && getTaskStatus(task) === 'done' && prerequisites(proposed, current, true).some(dependency => !prerequisiteDone(dependency))) {
        return { error: 'Reopen this task before adding unfinished hard gates.' };
    }
    return { ids, tags, hardIds, hardTags };
}

module.exports = { maxDependencies, dependencyIds, dependencyTags, hardDependencyIds, hardDependencyTags, taskReference, prerequisites, prerequisiteDone, prerequisiteLine, unfinishedPrerequisites, isWaiting, isHardBlocked, canViewTask, blockingSummary, blockingError, dependencyInput, resolveDependencies, validateDependencyGraph };
