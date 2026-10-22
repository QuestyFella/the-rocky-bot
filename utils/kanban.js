const { PermissionFlagsBits } = require('discord.js');
const { getTaskTag } = require('./taskTags');

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

// Fits text into a length limit, cutting at a word and marking the cut with an ellipsis.
function clipText(text, length) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= length) return value;
    const cut = value.slice(0, length - 1);
    return `${cut.slice(0, cut.lastIndexOf(' ') > length / 2 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s.,;:—-]+$/, '')}…`;
}

// The first paragraph of a description is its plain-language summary; details follow a blank line.
function getSummary(task) {
    return String(task.description || '').split(/\n\s*\n/)[0].trim();
}

function parseDueDate(input) {
    const value = String(input || '').trim();
    if (!value || ['none', 'clear'].includes(value.toLowerCase())) return { ok: true, dueDate: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false };
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? { ok: true, dueDate: value } : { ok: false };
}

// The people working on a task. Several people can claim the same task.
// Older tasks stored a single person in userId.
function getOwners(task) {
    if (Array.isArray(task.userIds)) return task.userIds;
    return task.userId ? [task.userId] : [];
}

function setOwners(task, owners) {
    task.userIds = [...new Set(owners)];
    delete task.userId;
}

function isOwner(task, userId) {
    return getOwners(task).includes(userId);
}

function isBoardName(name) {
    return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) && name !== 'prototype' && !Object.hasOwn(Object.prototype, name);
}

function getTaskBoard(task) {
    return typeof task.board === 'string' && task.board ? task.board : 'main';
}

// Unfinished tasks this one waits on. Only blockers in the same [TAG] category count,
// so one category can never hold up another. Deleted blockers no longer block.
function getBlockers(task, tasks) {
    const tag = getTaskTag(task).id;
    return (task.blockedBy || [])
        .map(id => tasks.find(other => other.id === id))
        .filter(other => other && other.id !== task.id && getTaskTag(other).id === tag && getTaskStatus(other) !== 'done');
}

// Blocked tasks stay hidden until their blockers are done, unless someone already took them on.
function isLocked(task, tasks) {
    return getTaskStatus(task) === 'todo' && !getOwners(task).length && getBlockers(task, tasks).length > 0;
}

function isManager(actor) {
    const permissions = actor.member?.permissions;
    return Boolean(permissions?.has(PermissionFlagsBits.Administrator) || permissions?.has(PermissionFlagsBits.ManageGuild));
}

// One rule for changing a task: anyone working on it, its creator, or a manager.
function canChange(actor, task) {
    return isManager(actor) || isOwner(task, actor.author.id) || task.createdBy === actor.author.id;
}

function claimError(actor, task, tasks = []) {
    if (getTaskStatus(task) === 'done') return 'This task is already done.';
    if (isLocked(task, tasks)) return `This task unlocks after ${getBlockers(task, tasks).map(getIssueKey).join(', ')} ${getBlockers(task, tasks).length > 1 ? 'are' : 'is'} done.`;
    if (isOwner(task, actor.author.id)) return 'You are already working on this task.';
    return null;
}

function setTaskStatus(task, status) {
    task.status = status;
    task.completed = status === 'done';
    task.updatedAt = new Date().toISOString();
}

module.exports = {
    columns, getTaskStatus, getColumn, getIssueKey, sortBoardTasks, formatDue, clipText, getSummary, parseDueDate,
    getOwners, setOwners, isOwner, isBoardName, getTaskBoard, getBlockers, isLocked, isManager, canChange, claimError, setTaskStatus
};
