const { readImportInput, prepareImport } = require('../utils/taskImport');
const { buildImportPreview, buildImportErrors } = require('../utils/importComponents');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    name: 'import',
    description: 'Preview and import a pasted task list or text attachment',
    async execute(message) {
        const actor = { client: message.client, guild: message.guild, author: message.author, member: message.member, channelId: message.channel.id };
        if (message.member.pending || message.client.pendingVerifications?.has(`${message.guild.id}:${message.author.id}`)) return message.reply('Finish verification before importing tasks.');
        const text = message.content.replace(/^\s*!task\s+import\b[ \t]*/i, '').trim();
        const attachments = [...message.attachments.values()];
        if (!text && !attachments.length) return message.reply({
            content: 'Click **Import Tasks** to paste a short list or upload a .txt file. You can also attach one .txt file to a message containing `!task import`. Review the preview, then click **Import Tasks** to save.',
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('kanban:import').setLabel('Import Tasks').setStyle(ButtonStyle.Primary))], allowedMentions: { parse: [] }
        });
        let source;
        try { source = await readImportInput(text, attachments); }
        catch (error) { return message.reply(buildImportErrors([error.message])); }
        const result = prepareImport(actor, source);
        return message.reply(result.errors ? buildImportErrors(result.errors) : buildImportPreview(result.draft, 0, true));
    }
};
