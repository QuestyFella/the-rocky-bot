const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, EmbedBuilder, escapeMarkdown
} = require('discord.js');
const { getTaskStatus, getColumn, getIssueKey, sortBoardTasks, formatDue, canChange, claimError } = require('./kanban');

const pageSize = 25;
const short = (text, length) => String(text || '').slice(0, length);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const lists = {
    find: { label: 'Find Work', empty: 'Nothing is open right now. Click **Add Task** to create a task.', hint: 'Choose a task to see its details and claim it.' },
    mine: { label: 'My Tasks', empty: 'You have no tasks. Click **Find Work** to pick one up.', hint: 'Choose a task to mark it done or hand it back.' }
};

function buildBoardComponents() {
    return [new ActionRowBuilder().addComponents(
        button('kanban:find:0', 'Find Work', ButtonStyle.Primary),
        button('kanban:mine:0', 'My Tasks'),
        button('kanban:add', 'Add Task', ButtonStyle.Success)
    )];
}

function filterTasks(tasks, list, actor) {
    if (list === 'mine') return tasks.filter(task => task.userId === actor.author.id && getTaskStatus(task) !== 'done');
    return tasks.filter(task => !task.userId && getTaskStatus(task) !== 'done');
}

function buildTaskPicker(allTasks, list, requestedPage, actor) {
    const tasks = sortBoardTasks(filterTasks(allTasks, list, actor));
    const pageCount = Math.max(1, Math.ceil(tasks.length / pageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
    const visible = tasks.slice(page * pageSize, (page + 1) * pageSize);
    const components = [];
    if (visible.length) {
        components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId('kanban:select')
            .setPlaceholder('Choose a task')
            .addOptions(visible.map(task => ({
                label: short(`${getIssueKey(task)}: ${task.title}`, 100),
                value: String(task.id),
                description: short([getColumn(task).name, formatDue(task)].filter(Boolean).join(' · '), 100)
            })))));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            button(`kanban:${list}:${page - 1}`, 'Previous').setDisabled(page === 0),
            button(`kanban:${list}:${page + 1}`, 'Next').setDisabled(page === pageCount - 1)
        ));
    }
    components.push(...buildBoardComponents());
    const { label, empty, hint } = lists[list];
    return {
        content: `**${label}** — ${tasks.length} task(s)${pageCount > 1 ? ` · page ${page + 1}/${pageCount}` : ''}\n${visible.length ? hint : empty}`,
        embeds: [], components, allowedMentions: { parse: [] }
    };
}

function buildTaskEmbed(task) {
    const column = getColumn(task);
    return new EmbedBuilder()
        .setColor(column.id === 'done' ? 0x2e7d32 : 0x0052cc)
        .setTitle(short(`${getIssueKey(task)}: ${task.title}`, 256))
        .setDescription(short(task.description || 'No description.', 4000))
        .addFields(
            { name: 'Status', value: `${column.icon} ${column.name}`, inline: true },
            { name: 'Owner', value: task.userId ? `<@${task.userId}>` : 'Nobody yet', inline: true },
            { name: 'Due', value: formatDue(task) || 'No due date', inline: true }
        );
}

function buildTaskComponents(task, actor) {
    const id = String(task.id);
    const status = getTaskStatus(task);
    const controls = [];
    if (status !== 'done' && task.userId !== actor.author.id && !claimError(actor, task)) controls.push(button(`kanban:claim:${id}`, 'Claim', ButtonStyle.Success));
    if (canChange(actor, task)) {
        if (status !== 'done') controls.push(button(`kanban:done:${id}`, 'Mark Done', ButtonStyle.Success));
        if (status !== 'done' && task.userId) controls.push(button(`kanban:unclaim:${id}`, 'Unclaim'));
        if (status === 'done') controls.push(button(`kanban:reopen:${id}`, 'Reopen'));
        controls.push(button(`kanban:edit:${id}`, 'Edit'), button(`kanban:delete:${id}`, 'Delete', ButtonStyle.Danger));
    }
    const rows = [];
    if (controls.length) rows.push(new ActionRowBuilder().addComponents(controls));
    rows.push(new ActionRowBuilder().addComponents(button('kanban:find:0', 'Find Work'), button('kanban:mine:0', 'My Tasks')));
    return rows;
}

function buildTaskView(task, actor, content = '') {
    return { content, embeds: [buildTaskEmbed(task)], components: buildTaskComponents(task, actor), allowedMentions: { parse: [] } };
}

function buildDeleteConfirm(task) {
    return {
        content: `Delete **${escapeMarkdown(short(`${getIssueKey(task)}: ${task.title}`, 300))}**? This cannot be undone.`,
        embeds: [],
        components: [new ActionRowBuilder().addComponents(
            button(`kanban:deleteconfirm:${task.id}`, 'Delete permanently', ButtonStyle.Danger),
            button(`kanban:view:${task.id}`, 'Cancel')
        )],
        allowedMentions: { parse: [] }
    };
}

function textInput(id, label, { style = TextInputStyle.Short, required = false, maxLength, value = '', placeholder }) {
    const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(Math.max(maxLength, value.length));
    if (value) input.setValue(value);
    if (placeholder) input.setPlaceholder(placeholder);
    return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

// Add and Edit share one short form: title, optional description, optional due date.
function buildTaskModal(task = null) {
    return new ModalBuilder()
        .setCustomId(task ? `kanban:editsave:${task.id}` : 'kanban:create')
        .setTitle(task ? 'Edit task' : 'Add a task')
        .addLabelComponents(
            textInput('title', 'Title', { required: true, maxLength: 200, value: task?.title || '', placeholder: '[POWER] Check the battery pack' }),
            textInput('description', 'Description (optional)', { style: TextInputStyle.Paragraph, maxLength: 2000, value: task?.description || '' }),
            textInput('due', 'Due date (optional, YYYY-MM-DD)', { maxLength: 10, value: task?.dueDate || '', placeholder: '2026-12-01' })
        );
}

module.exports = { buildBoardComponents, filterTasks, buildTaskPicker, buildTaskView, buildDeleteConfirm, buildTaskModal, pageSize };
