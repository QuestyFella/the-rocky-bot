const { Client, Events, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const path = require('path');
const cron = require('node-cron');
const TaskStorage = require('./taskStorage');
const { executeCommand, loadCommands, parseMessageCommand } = require('./utils/commandRouter');
const {
    canRunInChannel,
    getCachedServerConfig,
    loadServerConfig,
    saveServerConfig
} = require('./utils/serverConfig');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.serverConfigs = {};
client.pendingVerifications = new Map(); // ponytail: in-memory; bot restart loses pending verifications, members rejoin to retry
client.taskStorage = new TaskStorage();
client.loadServerConfig = loadServerConfig;
client.saveServerConfig = saveServerConfig;

client.commands = loadCommands(path.join(__dirname, 'commands'));

client.taskStorage.setUpdateListener(async (guildId) => {
    const boardCommand = client.commands.get('board');
    if (boardCommand && boardCommand.updateBoard) {
        await boardCommand.updateBoard(client, guildId);
    }
});

function scheduleLiveBoardUpdates() {
    cron.schedule('*/2 * * * *', async () => {
        const boardCommand = client.commands.get('board');
        if (!boardCommand || !boardCommand.updateBoard) {
            return;
        }

        for (const guild of client.guilds.cache.values()) {
            await boardCommand.updateBoard(client, guild.id);
        }
    });

    console.log('Live board updater started');
}

client.once(Events.ClientReady, () => {
    console.log(`Task Manager Bot is ready! Logged in as ${client.user.tag}`);
    client.user.setActivity('Kanban board | Use !task', { type: 'WATCHING' });

    scheduleLiveBoardUpdates();
});

const VERIFY_EMOJIS = ['🍎','🍊','🍇','🍓','🍌','🍉','🍒','🍑','🍍','🥝','🥭','🍋','🐟','🐢','🦊','🐱','🐶','🌟','🌙','☀️','🌈','🍀','🌹','🌻','🦄','🐝','🦋','🐙','🦀','🐸'];
const PENDING_TTL_MS = 10 * 60 * 1000;

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) {
        return;
    }

    const pendingKey = `${message.guild.id}:${message.author.id}`;
    const pending = client.pendingVerifications.get(pendingKey);
    if (pending && pending.channelId === message.channel.id) {
        await message.delete().catch(() => {});
        if (Date.now() - pending.startedAt > PENDING_TTL_MS) {
            client.pendingVerifications.delete(pendingKey);
            return message.channel.send(`<@${message.author.id}> your verification timed out. Rejoin to get a new prompt.`).catch(() => {});
        }
        if (message.content.trim() === pending.expectedEmoji) {
            const member = await message.guild.members.fetch(message.author.id).catch(() => null);
            if (member) {
                try {
                    await member.roles.add(pending.roleId, 'Verified via typed emoji');
                } catch (error) {
                    console.error(`Verify role add failed in ${message.guild.id}:`, error);
                }
            }
            client.pendingVerifications.delete(pendingKey);
            const prompt = await message.channel.messages.fetch(pending.promptMessageId).catch(() => null);
            if (prompt?.deletable) await prompt.delete().catch(() => {});
        }
        return;
    }

    const route = parseMessageCommand(message.content);
    if (!route) {
        return;
    }

    if (route.restricted) {
        const serverConfig = getCachedServerConfig(message.client, message.guild.id);
        if (!canRunInChannel(serverConfig, message.channel.id, route.commandName)) {
            return;
        }
    }

    await executeCommand(message, route);
});

client.on(Events.GuildMemberAdd, async (member) => {
    const serverConfig = getCachedServerConfig(member.client, member.guild.id);
    const v = serverConfig.verification;
    if (!v || !v.channelId || !v.roleId) return;
    const channel = member.guild.channels.cache.get(v.channelId);
    if (!channel) return;

    const expectedEmoji = VERIFY_EMOJIS[Math.floor(Math.random() * VERIFY_EMOJIS.length)];
    try {
        const prompt = await channel.send(`Hey ${member.toString()}, welcome! To verify you're human, send the emoji **${expectedEmoji}** in this channel within 10 minutes.`);
        client.pendingVerifications.set(`${member.guild.id}:${member.id}`, {
            expectedEmoji,
            promptMessageId: prompt.id,
            channelId: channel.id,
            roleId: v.roleId,
            startedAt: Date.now()
        });
    } catch (error) {
        console.error(`Verification greeting failed in ${member.guild.id}:`, error);
    }
});

client.login(process.env.DISCORD_TOKEN);
