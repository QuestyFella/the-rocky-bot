const { PermissionFlagsBits } = require('discord.js');

const columns = [
    { id: 'todo', name: 'To Do', icon: '📥' },
    { id: 'progress', name: 'In Progress', icon: '🔧' },
    { id: 'done', name: 'Done', icon: '✅' }
];
const dueFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// Older tasks may use the removed Review column; treat it as work in progress.
function getTaskStatus(task) {
    if (task.completed || task.status === 'done') return 'done';
    return ['progress', 'doing', 'review'].includes(task.status) ? 'progress' : 'todo';
}

function getColumn(task) {
    return columns.find(column => column.id === getTaskStatus(task));
}

function getIssueKey(task) {
    return task.issueKey || task.jiraKey || String(task.id);
}

function sortBoardTasks(tasks) {
    return [...tasks].sort((a, b) => {
        if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
        if (a.dueDate !== b.dueDate) return a.dueDate ? -1 : 1;
        return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    });
}

function formatDue(task) {
    if (!task.dueDate) return '';
    const date = new Date(`${task.dueDate}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return task.dueDate;
    const overdue = getTaskStatus(task) !== 'done' && Date.now() > date.getTime() + 86399999;
    return `${overdue ? '⚠️ overdue' : 'due'} ${dueFormat.format(date)}`;
}

function parseDueDate(input) {
    const value = String(input || '').trim();
    if (!value || ['none', 'clear'].includes(value.toLowerCase())) return { ok: true, dueDate: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false };
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? { ok: true, dueDate: value } : { ok: false };
}

function isManager(actor) {
    const permissions = actor.member?.permissions;
    return Boolean(permissions?.has(PermissionFlagsBits.Administrator) || permissions?.has(PermissionFlagsBits.ManageGuild));
}

// One rule for changing a task: the person working on it, its creator, or a manager.
function canChange(actor, task) {
    return isManager(actor) || task.userId === actor.author.id || task.createdBy === actor.author.id;
}

function claimError(actor, task) {
    if (getTaskStatus(task) === 'done') return 'This task is already done.';
    if (task.userId && task.userId !== actor.author.id) return 'Someone else is already working on this task.';
    return null;
}

function setTaskStatus(task, status) {
    task.status = status;
    task.completed = status === 'done';
    task.updatedAt = new Date().toISOString();
}

module.exports = {
    columns, getTaskStatus, getColumn, getIssueKey, sortBoardTasks, formatDue, parseDueDate,
    isManager, canChange, claimError, setTaskStatus
};
