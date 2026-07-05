const { PermissionFlagsBits } = require('discord.js');

module.exports = {
    name: 'verify',
    description: 'Configure human-verification on join (random emoji prompt)',
    async execute(message, args) {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('You need Manage Server permission.');
        }

        const sub = (args[0] || '').toLowerCase();
        const serverConfig = message.client.serverConfigs[message.guild.id]
            || (message.client.serverConfigs[message.guild.id] = message.client.loadServerConfig(message.guild.id));

        if (sub === 'off') {
            delete serverConfig.verification;
            message.client.saveServerConfig(message.guild.id, serverConfig);
            return message.reply('Verification disabled. Existing pending prompts will still time out.');
        }

        if (sub === 'status') {
            const v = serverConfig.verification;
            if (!v || !v.channelId) {
                return message.reply('Verification is not set up. Use `!task verify setup #channel @Role`.');
            }
            const pending = message.client.pendingVerifications.size;
            return message.reply(`Verification → channel: <#${v.channelId}>, role: <@&${v.roleId}>. Random emoji per join. ${pending} pending prompt(s).`);
        }

        if (sub === 'setup') {
            const channel = message.mentions.channels.first();
            const role = message.mentions.roles.first();
            if (!channel || !role) {
                return message.reply('Usage: `!task verify setup #channel @Role`. The bot asks each new member to type a random emoji.');
            }
            if (message.guild.members.me.roles.highest.position <= role.position) {
                return message.reply(`My highest role must be above **${role.name}** to grant it.`);
            }
            serverConfig.verification = { channelId: channel.id, roleId: role.id };
            message.client.saveServerConfig(message.guild.id, serverConfig);
            return message.reply(`Verification configured. New members get a random emoji prompt in ${channel}; they reply with that emoji to get <@&${role.id}>.`);
        }

        return message.reply('Usage: `!task verify setup #channel @Role`, `!task verify status`, or `!task verify off`.');
    }
};
