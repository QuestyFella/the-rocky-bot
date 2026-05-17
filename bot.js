const { Client, GatewayIntentBits } = require('discord.js');
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
const {
    loadReminders,
    saveReminders,
    scheduleReminder,
    scheduleReminders
} = require('./utils/reminders');

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
client.loadReminders = loadReminders;
client.saveReminders = saveReminders;
client.scheduleReminder = scheduleReminder;
client.reminders = [];

const { commands, commandList } = loadCommands(path.join(__dirname, 'commands'));
client.commands = commands;
client.commandList = commandList;

client.taskStorage.setUpdateListener(async (guildId) => {
    const jiraCommand = client.commands.get('jira');
    if (jiraCommand && jiraCommand.updateJiraBoard) {
        await jiraCommand.updateJiraBoard(client, guildId);
    }
});

async function sendDueDateSummary() {
    console.log('Sending due date summary...');

    for (const guild of client.guilds.cache.values()) {
        const tasksWithDueDate = client.taskStorage
            .getAllTasks(guild.id)
            .filter(task => task.dueDate && !task.completed && task.userId);

        const userTasks = tasksWithDueDate.reduce((groupedTasks, task) => {
            groupedTasks[task.userId] = groupedTasks[task.userId] || [];
            groupedTasks[task.userId].push(task);
            return groupedTasks;
        }, {});

        for (const userId of Object.keys(userTasks)) {
            try {
                const user = await client.users.fetch(userId);
                if (user) {
                    console.log(`Skipped due date summary for ${user.username} (DMs disabled)`);
                }
            } catch (error) {
                console.error(`Could not process summary for user ID ${userId}:`, error);
            }
        }
    }
}

function scheduleLiveBoardUpdates() {
    cron.schedule('*/2 * * * *', async () => {
        const jiraCommand = client.commands.get('jira');
        if (!jiraCommand || !jiraCommand.updateJiraBoard) {
            return;
        }

        for (const guild of client.guilds.cache.values()) {
            await jiraCommand.updateJiraBoard(client, guild.id);
        }
    });

    console.log('Live board updater started');
}

client.once('ready', () => {
    console.log(`Task Manager Bot is ready! Logged in as ${client.user.tag}`);
    client.user.setActivity('Kanban board | Use !task help', { type: 'WATCHING' });

    scheduleReminders(client);

    cron.schedule('0 0,12 * * *', sendDueDateSummary, {
        scheduled: true,
        timezone: 'America/Toronto'
    });
    console.log('Task reminder summary scheduler started');

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
