module.exports = {
    name: 'setchannel',
    description: 'Set the channel where the bot will operate',
    execute(message, args) {
        // Check if the user has admin permissions
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to set the bot channel!');
        }
        
        if (!message.mentions.channels.first() && !args.length) {
            return message.reply('Please mention a channel or provide a channel ID (e.g., "!task setchannel #tasks" or "!task setchannel 123456789")');
        }

        let channelId;
        if (message.mentions.channels.first()) {
            // If channel is mentioned
            channelId = message.mentions.channels.first().id;
        } else {
            // If channel ID is provided directly
            channelId = args[0];
        }

        // Validate that the channel exists in the guild
        const channel = message.guild.channels.cache.get(channelId);
        if (!channel) {
            return message.reply('Please provide a valid channel that exists in this server!');
        }

        // Load and update the guild-specific configuration
        if (!message.client.serverConfigs[message.guild.id]) {
            message.client.serverConfigs[message.guild.id] = message.client.loadServerConfig(message.guild.id);
        }
        
        message.client.serverConfigs[message.guild.id].allowedChannelId = channelId;
        
        // Save the configuration to file
        const success = message.client.saveServerConfig(message.guild.id, message.client.serverConfigs[message.guild.id]);
        
        if (success) {
            message.reply(`Bot channel has been set to <#${channelId}>. The bot will only work in this channel now.`);
        } else {
            message.reply('Failed to save configuration.');
        }
    }
};