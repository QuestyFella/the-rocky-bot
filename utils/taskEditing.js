const { randomUUID } = require('crypto');
const { normalizePriority, getTaskPriority, userCanManageIssue } = require('./kanban');
const { dependencyIds, dependencyTags, resolveDependencies, validateDependencyGraph, canViewTask } = require('./taskDependencies');

const editLifetimeMs = 15 * 60 * 1000;
const editableDetails = task => [task.title || '', task.description || '', getTaskPriority(task), task.dueDate || '', JSON.stringify([dependencyIds(task).sort(), dependencyTags(task).sort()])];

function prepareEdit(actor, task) {
    const drafts = actor.client.taskEdits ||= new Map();
    for (const [id, draft] of drafts) {
        if (draft.expiresAt <= Date.now() || (draft.guildId === actor.guild.id && draft.userId === actor.author.id && draft.taskId === task.id)) drafts.delete(id);
    }
    if (drafts.size >= 100) drafts.delete(drafts.keys().next().value);
    const draft = { id: randomUUID(), taskId: task.id, guildId: actor.guild.id, channelId: actor.channelId, userId: actor.author.id, expiresAt: Date.now() + editLifetimeMs, details: editableDetails(task) };
    drafts.set(draft.id, draft);
    return draft;
}

function saveEdit(actor, id, fields) {
    const draft = actor.client.taskEdits?.get(id);
    if (!draft || draft.expiresAt <= Date.now()) {
        if (draft) actor.client.taskEdits.delete(id);
        return { error: 'This edit form expired or was already saved. Open the task and click Edit Task again.' };
    }
    if (draft.userId !== actor.author.id || draft.guildId !== actor.guild.id || draft.channelId !== actor.channelId) {
        return { error: 'Only the person who opened this edit form can save it, in the original server and channel.' };
    }
    const tasks = actor.client.taskStorage.getAllTasks(actor.guild.id);
    const task = tasks.find(task => task.id === draft.taskId);
    if (!task) return { error: 'This task no longer exists. Open Browse Tasks to choose another.' };
    if (!canViewTask(task, tasks, actor)) return { error: 'This task is blocked. Only server managers can edit it until its prerequisites are Done.' };
    if (!userCanManageIssue(actor, task)) return { error: 'You no longer have permission to edit this task.' };
    if (editableDetails(task).some((value, i) => value !== draft.details[i])) {
        actor.client.taskEdits.delete(id);
        return { task, error: 'Task details changed while this form was open. Click Edit Task again to review the latest version.' };
    }
    const title = fields.getTextInputValue('title').trim();
    const description = fields.getTextInputValue('description').trim();
    const priorityInput = fields.getTextInputValue('priority').trim();
    const dueInput = fields.getTextInputValue('due').trim();
    const priority = priorityInput ? normalizePriority(priorityInput) : 'medium';
    const due = require('../commands/board').parseDueDate(dueInput);
    if (!title || (title.length > 200 && title !== draft.details[0]) || (description.length > 2000 && description !== draft.details[1])) {
        return { task, error: 'Use a title of 1–200 characters and a description of at most 2,000 characters. Existing longer text can be kept unchanged.' };
    }
    if (!priority) return { task, error: 'Choose low, medium, high, or urgent for the priority.' };
    if (dueInput && (!/^\d{4}-\d{2}-\d{2}$/.test(dueInput) || !due.ok)) return { task, error: 'Enter a real due date in YYYY-MM-DD format, or leave it blank to clear it.' };
    const edited = { ...task, title, description, priority, dueDate: due.dueDate, updatedAt: new Date().toISOString() };
    // Forms opened before the dependency field was added keep their prerequisites.
    if (fields.fields?.has('dependencies')) {
        const dependencies = resolveDependencies(edited, fields.getTextInputValue('dependencies'), tasks);
        if (dependencies.error) return { task, error: dependencies.error };
        edited.dependsOn = dependencies.ids;
        edited.dependsOnTags = dependencies.tags;
    }
    const cycle = validateDependencyGraph(edited, tasks);
    if (cycle) return { task, error: cycle };
    // Re-read and save synchronously so another edit or claim cannot be overwritten.
    if (!actor.client.taskStorage.updateTask(actor.guild.id, task.id, edited)) return { error: 'Failed to save the task. Open the task and try editing again.' };
    actor.client.taskEdits.delete(id);
    return { task: edited };
}

module.exports = { prepareEdit, saveEdit };
