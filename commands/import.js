const { readImportInput, prepareImport, buildImportPreview, buildImportErrors } = require('../utils/taskImport');
const { isManager } = require('../utils/kanban');
const { boardForChannel } = require('./board');

module.exports = {
    name: 'import',
    description: 'Preview and import a pasted task list or text attachment',
    async execute(message) {
        const actor = { client: message.client, guild: message.guild, author: message.author, member: message.member, board: boardForChannel(message.guild.id, message.channel.id) };
        if (!isManager(actor)) return message.reply('You need Manage Server permission to import tasks. Use **Add Task** to create one.');
        const text = message.content.replace(/^\s*!task\s+import\b[ \t]*/i, '').trim();
        let source;
        try {
            source = await readImportInput(text, [...message.attachments.values()]);
        } catch (error) {
            return message.reply(buildImportErrors([error.message]));
        }
        const result = prepareImport(actor, source);
        return message.reply(result.errors ? buildImportErrors(result.errors) : buildImportPreview(actor, result.draft));
    }
};
