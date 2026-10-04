const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { columns, priorities, getTaskStatus, getTaskPriority, getIssueKey, sortBoardTasks } = require('./kanban');
const { getTaskTeam } = require('./teams');
const { getTaskTag, groupTasksByTag } = require('./taskTags');
const { buildBoardComponents } = require('./boardComponents');

const blue = 0x0052cc;
const dueFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function splitText(text, limit = 1024) {
    const parts = [];
    let part = '';
    for (const character of text) {
        if (part.length + character.length > limit) { parts.push(part); part = ''; }
        part += character;
    }
    if (part) parts.push(part);
    return parts;
}

function statusCounts(tasks) {
    return columns.map(column => ({ ...column, count: tasks.filter(task => getTaskStatus(task) === column.id).length }));
}

function taskFields(task, displayIndex, actor, showTeam) {
    const tag = getTaskTag(task);
    const key = `\`${String(getIssueKey(task) || `#${displayIndex + 1}`).replace(/`/g, '').slice(0, 100)}\``;
    const title = escapeMarkdown(tag.title);
    const status = columns.find(column => column.id === getTaskStatus(task));
    const priority = priorities[getTaskPriority(task)];
    const date = task.dueDate ? new Date(`${task.dueDate}T00:00:00Z`) : null;
    const due = date && !Number.isNaN(date.getTime()) ? dueFormat.format(date) : task.dueDate || 'No due date';
    const owner = task.userId ? `<@${task.userId}>` : task.assignedToRole ? `<@&${task.assignedToRole}>` : getTaskStatus(task) === 'done' ? 'Unassigned' : 'Available to claim';
    const team = getTaskTeam(task, actor)?.name || 'No team';
    const details = `${status.icon} **${status.name}** · ${priority.icon} ${priority.label} · 📅 ${escapeMarkdown(due)}\n👤 ${owner}${showTeam ? ` · Team: ${escapeMarkdown(team)}` : ''}`;
    const name = `${key} · ${title}`;
    const values = splitText(name.length <= 256 ? details : `**${title}**\n${details}`);
    return values.map((value, index) => ({ name: index ? 'Task continued' : name.length <= 256 ? name : key, value, inline: false }));
}

function packFields(fields, overhead, maxFields, extraPerField = 0) {
    const pages = [[]];
    let length = overhead;
    for (const field of fields) {
        const size = field.name.length + field.value.length + extraPerField;
        if (pages.at(-1).length >= maxFields || length + size > 5600) { pages.push([]); length = overhead; }
        pages.at(-1).push(field);
        length += size;
    }
    return pages;
}

function renderBoard(tasks, title, actor) {
    const groups = groupTasksByTag(tasks);
    const displayTasks = sortBoardTasks(tasks);
    const indexes = new Map(displayTasks.map((task, index) => [task.id, index]));
    const result = [];
    if (groups.length > 1) {
        const description = `**${tasks.length} tasks · ${groups.length} tags**\n${statusCounts(tasks).map(column => `${column.icon} ${column.name}: **${column.count}**`).join(' · ')}\n\nJump to a tag below. Use **Available Tasks** to claim work or **My Tasks** to find your assignments.`;
        const fields = groups.map(group => ({ name: escapeMarkdown(group.name), value: `${group.tasks.length} tasks · ${group.tasks.filter(task => getTaskStatus(task) === 'done').length} done`, inline: true }));
        const pages = packFields(fields, title.length + description.length + 200, 25, 160);
        let offset = 0;
        for (const [index, page] of pages.entries()) {
            result.push({
                sectionKey: `overview:${index}`, indexTags: groups.slice(offset, offset + page.length).map(group => group.id),
                content: '', embeds: [new EmbedBuilder().setColor(blue).setTitle(`${title.slice(0, 200)} · Overview${pages.length > 1 ? ` ${index + 1}/${pages.length}` : ''}`)
                    .setDescription(description).addFields(page).setFooter({ text: 'Tags come from [TAG] at the start of a task title.' })],
                components: buildBoardComponents(), allowedMentions: { parse: [] }
            });
            offset += page.length;
        }
    }
    if (!groups.length) return [{
        sectionKey: 'empty', content: '', embeds: [new EmbedBuilder().setColor(blue).setTitle(title.slice(0, 220))
            .setDescription('No tasks yet. Click **Add Task** to get started. Use a title like **[POWER] Check the battery pack** to group related work.')
            .setFooter({ text: 'Everyone can add a task. Team labels are optional.' })],
        components: buildBoardComponents(), allowedMentions: { parse: [] }
    }];
    for (const group of groups) {
        const ordered = sortBoardTasks(group.tasks);
        const teams = [...new Set(group.tasks.map(task => getTaskTeam(task, actor)?.name || 'No team'))];
        const counts = statusCounts(group.tasks);
        const done = counts.find(column => column.id === 'done').count;
        const description = `**${group.tasks.length} tasks · ${done}/${group.tasks.length} done**\n${teams.length === 1 ? `Team: **${escapeMarkdown(teams[0])}**` : 'Teams shown on each task.'}`;
        const fields = ordered.flatMap(task => taskFields(task, indexes.get(task.id), actor, teams.length > 1));
        const pages = packFields(fields, group.name.length + description.length + 200, 10);
        for (const [index, page] of pages.entries()) result.push({
            sectionKey: `tag:${group.id}:${index}`, tagId: group.id,
            content: '', embeds: [new EmbedBuilder().setColor(done === group.tasks.length ? 0x2e7d32 : blue)
                .setTitle(`${group.name}${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''}`)
                .setDescription(description).addFields(page).setFooter({ text: 'Open Tasks → choose a task → Claim, Start Work, or Edit Task' })],
            components: buildBoardComponents(group.id), allowedMentions: { parse: [] }
        });
    }
    return result;
}

module.exports = { renderBoard };
