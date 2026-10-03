const { isManager } = require('../utils/kanban');
const { buildTeamSetup, buildTeamPicker } = require('../utils/boardComponents');

module.exports = {
    name: 'teams',
    description: 'Browse team tasks or set up group labels',
    async execute(message, args = []) {
        if (args[0]?.toLowerCase() === 'setup') {
            if (!isManager(message)) return message.reply('You need Manage Server permission to set up teams.');
            return message.channel.send(buildTeamSetup(message));
        }
        return message.channel.send(buildTeamPicker(message.client.taskStorage.getAllTasks(message.guild.id), message));
    }
};
