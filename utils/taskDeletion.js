const { randomUUID } = require('crypto');
const { isManager, userCanManageIssue, sortBoardTasks } = require('./kanban');
const { getTaskTag, groupTasksByTag } = require('./taskTags');
const { dependencyIds, dependencyTags } = require('./taskDependencies');

const lifetimeMs = 15 * 60 * 1000;
const snapshot = tasks => JSON.stringify(tasks.map(task => [String(task.id), JSON.stringify(task)]).sort(([a], [b]) => a.localeCompare(b)));

function deletionCandidates(actor, selection, tasks) {
    if (Object.hasOwn(selection, 'tagId')) {
        if (!isManager(actor)) return { error: 'You need Manage Server permission to delete tasks by tag.' };
        const tag = groupTasksByTag(tasks).find(tag => tag.id === selection.tagId);
        return tag ? { tasks: tag.tasks, tag: { id: tag.id, name: tag.name } } : { error: 'This tag no longer has tasks. Open Delete Tag Tasks to choose a current tag.' };
    }
    const task = tasks.find(task => String(task.id) === selection.taskId);
    if (!task) return { error: 'This task no longer exists. Open Browse Tasks to choose another.' };
    if (!userCanManageIssue(actor, task)) return { error: 'You do not have permission to delete this task.' };
    return { tasks: [task] };
}

function prepareDeletion(actor, selection) {
    const allTasks = actor.client.taskStorage.getAllTasks(actor.guild.id);
    const result = deletionCandidates(actor, selection, allTasks);
    if (result.error) return result;
    const tasks = structuredClone(sortBoardTasks(result.tasks));
    const ids = new Set(tasks.map(task => String(task.id)));
    const tags = new Set(tasks.map(task => getTaskTag(task).name));
    const references = allTasks.filter(task => !ids.has(String(task.id)) && (dependencyIds(task).some(id => ids.has(id)) || dependencyTags(task).some(tag => tags.has(tag)))).length;
    const drafts = actor.client.taskDeletes ||= new Map();
    for (const [id, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(id);
    if (drafts.size >= 100) drafts.delete(drafts.keys().next().value);
    const draft = {
        id: randomUUID(), guildId: actor.guild.id, channelId: actor.channelId, userId: actor.author.id,
        expiresAt: Date.now() + lifetimeMs, selection, tag: result.tag, tasks, references, snapshot: snapshot(tasks)
    };
    drafts.set(draft.id, draft);
    return { draft };
}

function getDeletionDraft(actor, id) {
    const draft = actor.client.taskDeletes?.get(id);
    if (!draft || draft.expiresAt <= Date.now()) {
        if (draft) actor.client.taskDeletes.delete(id);
        return { error: 'This deletion preview expired or was already used. Open the deletion controls again.' };
    }
    if (draft.userId !== actor.author.id || draft.guildId !== actor.guild.id || draft.channelId !== actor.channelId) {
        return { error: 'Only the person who opened this deletion preview can use it, in the original server and channel.' };
    }
    return { draft };
}

function reviewDeletion(actor, id) {
    const result = getDeletionDraft(actor, id);
    if (result.error) return result;
    const { draft } = result;
    const allTasks = actor.client.taskStorage.getAllTasks(actor.guild.id);
    const current = deletionCandidates(actor, draft.selection, allTasks);
    if (current.error) return current;
    if (snapshot(current.tasks) !== draft.snapshot) {
        actor.client.taskDeletes.delete(id);
        return { error: 'Tasks changed since this deletion preview. No tasks were deleted. Open the deletion controls again to review the current tasks.' };
    }
    return { draft, allTasks };
}

function commitDeletion(actor, id) {
    const result = reviewDeletion(actor, id);
    if (result.error) return result;
    const { draft, allTasks } = result;
    const ids = new Set(draft.tasks.map(task => String(task.id)));
    // One synchronous, atomic save removes exactly the reviewed tasks and updates the board once.
    if (!actor.client.taskStorage.saveTasks(actor.guild.id, allTasks.filter(task => !ids.has(String(task.id))))) {
        return { error: 'Failed to delete tasks. No tasks were deleted. You can retry this preview.', draft };
    }
    actor.client.taskDeletes.delete(id);
    return { deleted: draft.tasks.length, tag: draft.tag };
}

module.exports = { prepareDeletion, getDeletionDraft, reviewDeletion, commitDeletion };
