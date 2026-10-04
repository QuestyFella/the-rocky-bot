const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } = require('discord.js');

const pageSize = 5;
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const short = (text, length) => text.length > length ? `${text.slice(0, length - 1)}…` : text;

function buildImportErrors(errors) {
    return {
        content: `**Fix the list before importing**\n${errors.slice(0, 8).map(error => `• ${short(escapeMarkdown(error), 180)}`).join('\n')}${errors.length > 8 ? `\n…and ${errors.length - 8} more error(s).` : ''}\nNo tasks were added.`,
        embeds: [], components: [new ActionRowBuilder().addComponents(button('kanban:import', 'Try Again', ButtonStyle.Primary))], allowedMentions: { parse: [] }
    };
}

function buildImportPreview(draft, requestedPage = 0, includeFile = false) {
    const count = draft.rows.filter(row => !row.duplicate).length;
    const skipped = draft.rows.length - count;
    const pages = Math.max(1, Math.ceil(draft.rows.length / pageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
    const embed = new EmbedBuilder().setColor(0x0052cc).setTitle('Task import preview')
        .setDescription(`${count} new task(s) · ${skipped} duplicate(s) will be skipped.\nNew tasks start unassigned in To Do. Only you can confirm this import.`)
        .setFooter({ text: `Page ${page + 1}/${pages} · Preview expires after 15 minutes` });
    for (const row of draft.rows.slice(page * pageSize, (page + 1) * pageSize)) {
        embed.addFields({ name: short(`${row.number}. ${row.title}`, 256), value: `${row.duplicate ? '**Skip: title and team already listed**\n' : ''}**Team:** ${escapeMarkdown(row.team?.name || 'No team')} · **Priority:** ${row.priority} · **Due:** ${row.dueDate || 'None'}\n${escapeMarkdown(short(row.description || 'No description.', 240))}` });
    }
    const controls = new ActionRowBuilder().addComponents(
        button(`kanban:importpage:${draft.id}:${page - 1}`, 'Previous').setDisabled(page === 0),
        button(`kanban:importpage:${draft.id}:${page + 1}`, 'Next').setDisabled(page === pages - 1),
        button(`kanban:importconfirm:${draft.id}`, 'Import Tasks', ButtonStyle.Success).setDisabled(count === 0),
        button(`kanban:importcancel:${draft.id}`, 'Cancel', ButtonStyle.Danger)
    );
    const payload = { content: 'Review the fields below. The preview file includes all entries and full descriptions.', embeds: [embed], components: [controls], allowedMentions: { parse: [] } };
    if (includeFile) payload.files = [{ name: 'task-import-preview.txt', attachment: Buffer.from(draft.rows.map(row => `${row.number}. ${row.duplicate ? '[SKIP DUPLICATE]' : '[WILL IMPORT]'}\nTitle: ${row.title}\nDescription: ${row.description}\nPriority: ${row.priority}\nDue date: ${row.dueDate || ''}\nTeam: ${row.team?.name || ''}`).join('\n\n'), 'utf8') }];
    return payload;
}

module.exports = { buildImportErrors, buildImportPreview };
