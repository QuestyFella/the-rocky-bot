const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { columns, getTaskStatus, getIssueKey, sortBoardTasks, formatDue } = require('./kanban');
const { getTaskTag, groupTasksByTag } = require('./taskTags');
const { buildBoardComponents } = require('./boardComponents');

const blue = 0x0052cc;
const descriptionLimit = 4000;

function taskLine(task, { showTag = false } = {}) {
    const tag = getTaskTag(task);
    const title = escapeMarkdown(showTag ? task.title : tag.title).slice(0, 200);
    const owner = task.userId ? ` — <@${task.userId}>` : '';
    const due = formatDue(task);
    return `\`${getIssueKey(task).replace(/`/g, '')}\` ${title}${owner}${due ? ` · ${due}` : ''}`;
}

// Done tasks are only counted, so the board stays focused on open work.
function boardLines(tasks) {
    const counts = columns.map(column => `${column.icon} ${column.name}: **${tasks.filter(task => getTaskStatus(task) === column.id).length}**`).join(' · ');
    const lines = [
        counts,
        '**Want to help?** Click **Find Work**, pick a task, then **Claim**. Finished? Open **My Tasks** and click **Mark Done**.'
    ];
    const doing = sortBoardTasks(tasks.filter(task => getTaskStatus(task) === 'progress'));
    const todo = tasks.filter(task => getTaskStatus(task) === 'todo');
    if (doing.length) lines.push('', '**🔧 In Progress**', ...doing.map(task => taskLine(task, { showTag: true })));
    if (todo.length) {
        lines.push('', '**📥 To Do**');
        const groups = groupTasksByTag(todo);
        for (const group of groups) {
            if (groups.length > 1 || group.name !== 'General') lines.push(`__${escapeMarkdown(group.name)}__`);
            lines.push(...sortBoardTasks(group.tasks).map(task => taskLine(task)));
        }
    }
    if (!doing.length && !todo.length) lines.push('', 'No open tasks. Click **Add Task** to create one.');
    return lines;
}

function renderBoard(tasks, title) {
    const parts = [''];
    for (const line of boardLines(tasks)) {
        const next = parts.at(-1) ? `${parts.at(-1)}\n${line}` : line;
        if (next.length > descriptionLimit && parts.at(-1)) parts.push(line);
        else parts[parts.length - 1] = next;
    }
    return parts.map((description, index) => ({
        content: '',
        embeds: [new EmbedBuilder().setColor(blue)
            .setTitle(`${title.slice(0, 200)}${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ''}`)
            .setDescription(description || '​')],
        components: buildBoardComponents(),
        allowedMentions: { parse: [] }
    }));
}

module.exports = { renderBoard, taskLine };
