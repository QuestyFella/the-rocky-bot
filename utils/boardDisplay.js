const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { getTaskStatus, getIssueKey, sortBoardTasks, formatDue, isLocked, clipText, getSummary } = require('./kanban');
const { getTaskTag, groupTasksByTag, getTagStyle } = require('./taskTags');
const { buildBoardComponents } = require('./boardComponents');

const blue = 0x0052cc;
const orange = 0xfb8c00;
const grey = 0x5865f2;
// Discord allows 10 embeds and 6,000 embed characters per message, and 25 fields per embed.
const embedsPerMessage = 10;
const charsPerMessage = 5800;
const fieldsPerEmbed = 25;

// One field per task: its key and title in bold, then its plain-language summary and due date.
function taskField(task, { showTag = false } = {}) {
    const tag = getTaskTag(task);
    const title = showTag ? `${getTagStyle(tag.name).emoji} ${tag.title}` : tag.title;
    const facts = [task.userId ? `👤 <@${task.userId}>` : null, formatDue(task) ? `📅 ${formatDue(task)}` : null].filter(Boolean).join(' · ');
    const summary = getSummary(task) ? escapeMarkdown(clipText(getSummary(task), 300)) : '';
    return {
        name: clipText(`${getIssueKey(task)} · ${escapeMarkdown(title)}`, 256),
        value: [summary, facts].filter(Boolean).join('\n') || 'No description yet.'
    };
}

const size = card => (card.title || '').length + (card.description || '').length + card.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

// A section becomes one card, or several "(cont.)" cards when it has too many tasks for one.
function sectionCards({ title, description, color, fields }) {
    const cards = [{ title, description, color, fields: [] }];
    for (const field of fields) {
        let card = cards.at(-1);
        if (card.fields.length && (card.fields.length >= fieldsPerEmbed || size(card) + field.name.length + field.value.length > charsPerMessage)) {
            card = { title: `${title} (cont.)`, color, fields: [] };
            cards.push(card);
        }
        card.fields.push(field);
    }
    return cards;
}

// An optional card at the top that explains the board to new members; managers turn it on with !task notice on.
const noticeCard = {
    title: '📌 How this board works',
    description: [
        '**1. Find something to do.** Click **Find Work** below. Use the category menu to see only your area, then pick a task to read what it involves.',
        '**2. Claim it.** Click **Claim**. The task is yours and moves to 🔧 In Progress, so nobody else picks it up.',
        '**3. Finish it.** Open **My Tasks** and click **Mark Done**. Can\'t finish it? Click **Unclaim** to hand it back.',
        '',
        '🔒 **Locked tasks:** some tasks wait for earlier ones in the same category. They appear here once those are done.',
        '➕ **Spotted something missing?** Click **Add Task**. You can edit or delete tasks you created or claimed.',
        '❓ Type `!task help` for all commands, or ask an exec.'
    ].join('\n'),
    color: grey,
    fields: []
};

// The board is an optional notice, a header card, an In Progress card, then one card per category with the
// tasks people can claim now. Done tasks are only counted, and locked tasks only counted per category.
function boardCards(tasks, title, { notice = false } = {}) {
    const doing = sortBoardTasks(tasks.filter(task => getTaskStatus(task) === 'progress'));
    const todo = tasks.filter(task => getTaskStatus(task) === 'todo');
    const locked = todo.filter(task => isLocked(task, tasks)).length;
    const done = tasks.filter(task => getTaskStatus(task) === 'done').length;
    const counts = [`📥 **${todo.length - locked}** ready to claim`, `🔧 **${doing.length}** in progress`, locked ? `🔒 **${locked}** waiting` : null, `✅ **${done}** done`];
    const cards = notice ? [noticeCard] : [];
    cards.push({
        title: `🚀 ${title}`.slice(0, 256),
        description: [
            counts.filter(Boolean).join('  ·  '),
            // The notice already explains how to use the board.
            ...(notice ? [] : ['', '**Want to help?** Click **Find Work**, pick a task, then **Claim** it.', '**Finished?** Open **My Tasks** and click **Mark Done**.']),
            ...(!doing.length && !todo.length ? ['', 'No open tasks. Click **Add Task** to create one.'] : [])
        ].join('\n'),
        color: blue,
        fields: []
    });
    if (doing.length) cards.push(...sectionCards({ title: '🔧 In Progress', color: orange, fields: doing.map(task => taskField(task, { showTag: true })) }));
    for (const group of groupTasksByTag(todo)) {
        const open = sortBoardTasks(group.tasks.filter(task => !isLocked(task, tasks)));
        const waiting = group.tasks.length - open.length;
        const style = getTagStyle(group.name);
        const description = [
            open.length ? `**${open.length}** ready to claim` : 'Nothing to claim right now.',
            waiting ? `🔒 ${waiting} more unlock as these finish` : null
        ].filter(Boolean).join('  ·  ');
        cards.push(...sectionCards({ title: `${style.emoji} ${escapeMarkdown(group.name)}`, description, color: style.color, fields: open.map(task => taskField(task)) }));
    }
    return cards;
}

function renderBoard(tasks, title, options) {
    const messages = [[]];
    for (const card of boardCards(tasks, title, options)) {
        const current = messages.at(-1);
        if (current.length && (current.length >= embedsPerMessage || current.reduce((n, c) => n + size(c), 0) + size(card) > charsPerMessage)) messages.push([card]);
        else current.push(card);
    }
    // The buttons go on the last message, at the bottom of the channel where people look.
    return messages.map((cards, index) => ({
        content: '',
        embeds: cards.map(card => {
            const embed = new EmbedBuilder().setColor(card.color).setTitle(card.title);
            if (card.description) embed.setDescription(card.description);
            if (card.fields.length) embed.addFields(card.fields);
            return embed;
        }),
        components: index === messages.length - 1 ? buildBoardComponents() : [],
        allowedMentions: { parse: [] }
    }));
}

module.exports = { renderBoard, taskField };
