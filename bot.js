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

client.on('messageCreate', async (message) => {
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

client.login(process.env.DISCORD_TOKEN);
