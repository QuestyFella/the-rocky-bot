const { isManager } = require('../utils/kanban');
const { buildTeamSetup } = require('../utils/boardComponents');

module.exports = {
    name: 'teams',
    description: 'Choose Discord roles to use as Kanban teams',
    async execute(message) {
        if (!isManager(message)) return message.reply('Use My Teams on the board or `!task myteams` to see your teams’ tasks. A server manager can use Setup Teams to configure team roles.');
        await message.guild.roles.fetch();
        return message.channel.send(buildTeamSetup(message));
    }
};
