const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { groupTasksByTag } = require('./taskTags');
const { getIssueKey, getTaskStatus, columns } = require('./kanban');
const { getTaskTeam } = require('./teams');
const { isBlocked } = require('./taskDependencies');

const pageSize = 5;
const tagPageSize = 25;
const short = (text, length) => String(text || '').slice(0, length);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const pageNumber = (requested, count) => Math.max(0, Math.min(Math.trunc(Number(requested)) || 0, count - 1));

function buildDeletionTagPicker(tasks, requestedPage = 0) {
    const tags = groupTasksByTag(tasks);
    const pages = Math.max(1, Math.ceil(tags.length / tagPageSize));
    const page = pageNumber(requestedPage, pages);
    const components = [];
    if (tags.length) components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('kanban:deletetag').setPlaceholder('Choose a title tag to preview its tasks')
        .addOptions(tags.slice(page * tagPageSize, (page + 1) * tagPageSize).map(tag => ({
            label: short(tag.name, 100), value: tag.id,
            description: `${tag.tasks.length} task(s) · ${tag.tasks.filter(task => getTaskStatus(task) === 'done').length} Done · ${tag.tasks.filter(task => isBlocked(task, tasks)).length} blocked`
        })))));
    if (pages > 1) components.push(new ActionRowBuilder().addComponents(
        button(`kanban:deletetags:${page - 1}`, 'Previous').setDisabled(page === 0),
        button(`kanban:deletetags:${page + 1}`, 'Next').setDisabled(page === pages - 1)
    ));
    components.push(new ActionRowBuilder().addComponents(button('kanban:more', 'More')));
    return {
        content: `**Delete Tag Tasks**${pages > 1 ? ` · Page ${page + 1}/${pages}` : ''}\n${tags.length ? 'Choose a [TAG] from task titles. General contains tasks without a title tag. The preview includes every task in that tag, across all teams and statuses, including blocked tasks. You will confirm before deleting.' : 'No tasks to delete.'}`,
        embeds: [], components, allowedMentions: { parse: [] }
    };
}

function buildDeletionPreview(draft, actor, requestedPage = 0) {
    const pages = Math.max(1, Math.ceil(draft.tasks.length / pageSize));
    const page = pageNumber(requestedPage, pages);
    const embed = new EmbedBuilder().setColor(0xed4245).setTitle('Task deletion preview')
        .setDescription(`**${draft.tasks.length} task(s) will be permanently deleted**${draft.tag ? ` from **${escapeMarkdown(draft.tag.name)}**` : ''}.\n${draft.tag ? 'Includes all teams and statuses, including completed and blocked tasks.\n' : ''}Only you can confirm this deletion.${draft.references ? `\n${draft.references} other task(s) reference these tasks or their tags. Prerequisites are kept; missing tasks and empty tags block unfinished work.` : ''}`)
        .setFooter({ text: `Page ${page + 1}/${pages} · Preview expires after 15 minutes` });
    for (const task of draft.tasks.slice(page * pageSize, (page + 1) * pageSize)) embed.addFields({
        name: short(`${getIssueKey(task) || task.id}: ${task.title}`, 256),
        value: `**Team:** ${short(escapeMarkdown(getTaskTeam(task, actor)?.name || 'No team'), 180)} · **Status:** ${columns.find(column => column.id === getTaskStatus(task)).name}\n${short(escapeMarkdown(task.description || 'No description.'), 220)}`
    });
    const controls = [];
    if (pages > 1) controls.push(
        button(`kanban:deletepage:${draft.id}:${page - 1}`, 'Previous').setDisabled(page === 0),
        button(`kanban:deletepage:${draft.id}:${page + 1}`, 'Next').setDisabled(page === pages - 1)
    );
    controls.push(button(`kanban:deleteconfirm:${draft.id}`, draft.tag ? `Delete ${draft.tasks.length} Tasks` : 'Delete Task', ButtonStyle.Danger), button(`kanban:deletecancel:${draft.id}`, 'Cancel'));
    return { content: 'Review the selected tasks, then confirm or cancel.', embeds: [embed], components: [new ActionRowBuilder().addComponents(controls)], allowedMentions: { parse: [] } };
}

module.exports = { buildDeletionTagPicker, buildDeletionPreview };
