const { isManager } = require('../utils/kanban');
const { buildTeamPicker } = require('../utils/boardComponents');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    name: 'teams',
    description: 'Browse team tasks or set up group labels',
    async execute(message, args = []) {
        if (args[0]?.toLowerCase() === 'setup') {
            if (!isManager(message)) return message.reply('You need Manage Server permission to set up teams.');
            return message.reply({ content: 'Click **More**, then **Setup Teams** to open your private manager controls.', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('kanban:more').setLabel('More').setStyle(ButtonStyle.Secondary))], allowedMentions: { parse: [] } });
        }
        return message.channel.send(buildTeamPicker(message.client.taskStorage.getAllTasks(message.guild.id), message));
    }
};
