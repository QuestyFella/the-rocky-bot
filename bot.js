const { Client, Events, GatewayIntentBits, MessageFlags, ActivityType } = require('discord.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: process.env.BOT_ENV_FILE || path.join(__dirname, '.env') });
const cron = require('node-cron');
const TaskStorage = require('./taskStorage');
const { executeCommand, loadCommands, parseMessageCommand } = require('./utils/commandRouter');
const { handleBoardInteraction } = require('./utils/boardInteractions');
const { createBridge } = require('./utils/ircBridge');
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
client.taskStorage = new TaskStorage();
client.loadServerConfig = loadServerConfig;
client.saveServerConfig = saveServerConfig;

client.commands = loadCommands(path.join(__dirname, 'commands'));

// Discord <-> apollo #lobby chat, if APOLLO_BRIDGE_CHANNEL_ID is set.
const bridge = createBridge(client);

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

client.once(Events.ClientReady, async () => {
    console.log(`Task Manager Bot is ready! Logged in as ${client.user.tag}`);
    client.user.setActivity('Kanban board | Use !task', { type: ActivityType.Watching });

    if (process.env.BOT_READY_FILE) {
        fs.writeFileSync(process.env.BOT_READY_FILE, JSON.stringify({ pid: process.pid, readyAt: new Date().toISOString() }));
    }
    if (process.send) process.send('ready');

    scheduleLiveBoardUpdates();
    bridge?.start();
    for (const guild of client.guilds.cache.values()) {
        await client.commands.get('board').updateBoard(client, guild.id);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    try {
        await handleBoardInteraction(interaction);
    } catch (error) {
        console.error('Failed to handle board interaction:', error);
        const payload = { content: 'Something went wrong. Refresh the task and try again.', embeds: [], components: [] };
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
});

function shutdown() {
    bridge?.stop();
    client.destroy();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// One failed reply or handler must not stop the bot for everyone: log it and carry on.
client.on(Events.Error, error => console.error('Discord client error:', error));
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));

client.on('messageCreate', async (message) => {
    bridge?.fromDiscord(message);
    if (message.author.bot || !message.guild) {
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

// Without a login the bot can do nothing, so exit and let PM2 and the deployment check see the failure.
client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Could not log in to Discord:', error);
    process.exit(1);
});
