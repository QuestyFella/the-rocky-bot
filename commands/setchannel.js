module.exports = {
    name: 'setchannel',
    description: 'Manage channels where the bot will operate',
    execute(message, args) {
        // Check if the user has admin permissions
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to manage bot channels!');
        }

        const subCommand = args[0] ? args[0].toLowerCase() : 'add';

        // Load and update the guild-specific configuration
        if (!message.client.serverConfigs[message.guild.id]) {
            message.client.serverConfigs[message.guild.id] = message.client.loadServerConfig(message.guild.id);
        }
        const serverConfig = message.client.serverConfigs[message.guild.id];
        if (!serverConfig.allowedChannelIds) {
            serverConfig.allowedChannelIds = [];
        }

        if (subCommand === 'list') {
            if (serverConfig.allowedChannelIds.length === 0) {
                return message.reply('The bot is currently allowed to operate in all channels.');
            }
            const channelList = serverConfig.allowedChannelIds.map(id => `<#${id}>`).join(', ');
            return message.reply(`The bot is allowed to operate in the following channels: ${channelList}`);
        }

        const channelMention = message.mentions.channels.first();
        const channelId = channelMention ? channelMention.id : args[1];

        if (!channelId) {
            return message.reply('Please mention a channel or provide a channel ID.');
        }

        // Validate that the channel exists in the guild
        const channel = message.guild.channels.cache.get(channelId);
        if (!channel) {
            return message.reply('Please provide a valid channel that exists in this server!');
        }

        if (subCommand === 'add') {
            if (serverConfig.allowedChannelIds.includes(channelId)) {
                return message.reply(`The bot is already allowed in <#${channelId}>.`);
            }
            serverConfig.allowedChannelIds.push(channelId);
            const success = message.client.saveServerConfig(message.guild.id, serverConfig);
            if (success) {
                message.reply(`The bot is now allowed to operate in <#${channelId}>.`);
            } else {
                message.reply('Failed to save configuration.');
            }
        } else if (subCommand === 'remove') {
            if (serverConfig.allowedChannelIds.length === 1 && serverConfig.allowedChannelIds[0] === channelId) {
                return message.reply('You cannot remove the last channel. Please add another channel first before removing this one.');
            }
            const index = serverConfig.allowedChannelIds.indexOf(channelId);
            if (index === -1) {
                return message.reply(`The bot is not restricted to <#${channelId}>.`);
            }
            serverConfig.allowedChannelIds.splice(index, 1);
            const success = message.client.saveServerConfig(message.guild.id, serverConfig);
            if (success) {
                message.reply(`The bot is no longer restricted to <#${channelId}>.`);
            } else {
                message.reply('Failed to save configuration.');
            }
        } else {
            message.reply('Invalid subcommand. Use `add`, `remove`, or `list`.');
        }
    }
};