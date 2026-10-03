const { PermissionFlagsBits } = require('discord.js');

const columns = [
    { id: 'todo', name: 'To Do', icon: '📥' },
    { id: 'progress', name: 'In Progress', icon: '🔧' },
    { id: 'review', name: 'Review', icon: '👀' },
    { id: 'done', name: 'Done', icon: '✅' }
];
const columnAliases = {
    backlog: 'todo', open: 'todo', ready: 'todo', todo: 'todo', 'to-do': 'todo',
    doing: 'progress', progress: 'progress', 'in-progress': 'progress', inprogress: 'progress', wip: 'progress',
    review: 'review', testing: 'review', test: 'review', qa: 'review',
    done: 'done', complete: 'done', completed: 'done', closed: 'done'
};
const priorities = {
    low: { label: 'Low', icon: '🟢', weight: 1 },
    medium: { label: 'Medium', icon: '🟡', weight: 2 },
    high: { label: 'High', icon: '🟠', weight: 3 },
    urgent: { label: 'Urgent', icon: '🔴', weight: 4 }
};
const priorityAliases = {
    l: 'low', low: 'low', normal: 'medium', med: 'medium', medium: 'medium', m: 'medium',
    high: 'high', h: 'high', urgent: 'urgent', critical: 'urgent', blocker: 'urgent',
    p1: 'urgent', p2: 'high', p3: 'medium', p4: 'low'
};

function normalizeColumn(value) {
    const cleaned = String(value || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
    return columnAliases[cleaned] || columnAliases[cleaned.replace(/-/g, '')] || null;
}

function normalizePriority(value) {
    return priorityAliases[String(value || '').toLowerCase().trim()] || null;
}

function getTaskStatus(task) {
    return task.completed ? 'done' : normalizeColumn(task.status) || 'todo';
}

function getTaskPriority(task) {
    return normalizePriority(task.priority) || 'medium';
}

function getIssueKey(task) {
    return task.issueKey || task.jiraKey;
}

function getTaskTeamRoleId(task) {
    // Older role assignments double as team tags until first edited.
    return Object.hasOwn(task, 'teamRoleId') ? task.teamRoleId || null : task.assignedToRole || null;
}

function preserveTaskTeam(task) {
    if (!Object.hasOwn(task, 'teamRoleId')) task.teamRoleId = getTaskTeamRoleId(task);
}

function sortBoardTasks(tasks) {
    return [...tasks].sort((a, b) => {
        const status = getTaskStatus(a);
        const columnDifference = columns.findIndex(c => c.id === status) - columns.findIndex(c => c.id === getTaskStatus(b));
        if (columnDifference) return columnDifference;
        if (status === 'done') return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
        const priorityDifference = priorities[getTaskPriority(b)].weight - priorities[getTaskPriority(a)].weight;
        if (priorityDifference) return priorityDifference;
        if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    });
}

function isManager(actor) {
    return actor.member.permissions.has(PermissionFlagsBits.Administrator)
        || actor.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function userCanManageIssue(actor, task) {
    return isManager(actor) || task.userId === actor.author.id || task.createdBy === actor.author.id
        || task.assignedBy === actor.author.id
        || Boolean(task.assignedToRole && actor.member.roles.cache.has(task.assignedToRole));
}

function claimError(actor, task) {
    if (getTaskStatus(task) === 'done') return 'This task is done. Reopen it before claiming it.';
    if (task.userId && task.userId !== actor.author.id) return 'Someone else has already claimed this task.';
    if (task.assignedToRole && !actor.member.roles.cache.has(task.assignedToRole) && !isManager(actor)) {
        return 'This task is reserved for members of its assigned role.';
    }
    return null;
}

function releaseError(actor, task) {
    if (task.userId !== actor.author.id && !isManager(actor)) return 'You can only release a task assigned to you.';
    return null;
}

function setTaskStatus(task, status) {
    task.status = status;
    task.completed = status === 'done';
    task.updatedAt = new Date().toISOString();
}

module.exports = {
    columns, priorities, normalizeColumn, normalizePriority, getTaskStatus, getTaskPriority,
    getIssueKey, sortBoardTasks, isManager, userCanManageIssue, claimError, releaseError, setTaskStatus,
    getTaskTeamRoleId, preserveTaskTeam
};
