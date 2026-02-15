const { Client, GatewayIntentBits, Collection, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const cron = require('node-cron');
const TaskStorage = require('./taskStorage');

// Create a new client instance
const client = new Client({ 
    intents: [ 
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ] 
});

// Initialize server configurations
client.serverConfigs = {};

// Function to load server configuration
function loadServerConfig(guildId) {
    const configPath = `./server-configs/${guildId}.json`;
    
    try {
        if (fs.existsSync(configPath)) {
            const configFile = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(configFile);
            // Backward compatibility: convert single channel ID to an array
            if (config.allowedChannelId && !Array.isArray(config.allowedChannelIds)) {
                config.allowedChannelIds = [config.allowedChannelId];
                delete config.allowedChannelId;
            }
            return config;
        }
    } catch (error) {
        console.log(`No config file found for server ${guildId}, using default settings`);
    }
    
    // Return default config
    return { allowedChannelIds: [] };
}

// Function to save server configuration
function saveServerConfig(guildId, config) {
    const configDir = './server-configs';
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    
    const configPath = `./server-configs/${guildId}.json`;
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error(`Error saving config for server ${guildId}:`, error);
        return false;
    }
}

// Make these functions available to commands
client.loadServerConfig = loadServerConfig;
client.saveServerConfig = saveServerConfig;

// Collection to store commands
client.commands = new Collection();

// Initialize task storage
client.taskStorage = new TaskStorage();
client.tasks = client.taskStorage.getAllTasks();

// Listen for task updates to refresh noticeboards immediately
client.taskStorage.setUpdateListener(async (guildId) => {
    const noticeCommand = client.commands.get('notice');
    if (noticeCommand && noticeCommand.updateNoticeboard) {
        await noticeCommand.updateNoticeboard(client, guildId);
    }
});

// Load commands
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    client.commands.set(command.name, command);
}

// When the client is ready, run this code
client.once('ready', () => {
    console.log(`Task Manager Bot is ready! Logged in as ${client.user.tag}`);
    
    // Set bot activity
    client.user.setActivity('your tasks | Use !task help', { type: 'WATCHING' });

    scheduleReminders(client);
    
    // Schedule task reminder summary every day at midnight and noon
    cron.schedule('0 0,12 * * *', async () => {
        console.log('Sending due date summary...');
    
        // Get all available guilds
        for (const guild of client.guilds.cache.values()) {
            // Load all tasks for this specific guild
            const allTasks = client.taskStorage.getAllTasks(guild.id);
            
            // Filter for tasks with a due date that are not completed
            const tasksWithDueDate = allTasks.filter(task => task.dueDate && !task.completed);
            
            if (tasksWithDueDate.length === 0) {
                continue; // No tasks with due dates in this guild
            }
            
            // Group tasks by user
            const userTasks = {};
            for (const task of tasksWithDueDate) {
                if (!userTasks[task.userId]) {
                    userTasks[task.userId] = [];
                }
                userTasks[task.userId].push(task);
            }
            
            // Send a summary to each user
            for (const userId in userTasks) {
                try {
                    const user = await client.users.fetch(userId);
                    if (user) {
                        /* 
                        // DM functionality disabled by request
                        let summaryMessage = 'Here is a summary of your tasks with due dates:\n\n';
                        for (const task of userTasks[userId]) {
                            summaryMessage += `- **${task.title}** - Due: ${task.dueDate}\n`;
                        }
                        
                        await user.send(summaryMessage);
                        console.log(`Sent due date summary to user ${user.username}`);
                         */
                        console.log(`Skipped due date summary for ${user.username} (DMs disabled)`);
                    }
                } catch (error) {
                    console.error(`Could not process summary for user ID ${userId}:`, error);
                }
            }
        }
    }, {
        scheduled: true,
        timezone: "America/Toronto" // Set appropriate timezone
    });
    
    console.log('Task reminder summary scheduler started');

    // Schedule noticeboard updates (every 2 minutes)
    cron.schedule('*/2 * * * *', async () => {
        const noticeCommand = client.commands.get('notice');
        if (noticeCommand && noticeCommand.updateNoticeboard) {
            // Get all guilds with active noticeboards involves reading the file, 
            // but the command logic handles reading/validating.
            // We need to iterate over known guilds or just let the command handle it?
            // The command's updateNoticeboard takes a guildId.
            // Let's iterate all guilds client is in.
            for (const guild of client.guilds.cache.values()) {
                await noticeCommand.updateNoticeboard(client, guild.id);
            }
        }
    });
    console.log('Noticeboard updater started');
});

// When a message is received
client.on('messageCreate', message => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Debug logging to verify message content intent
    console.log(`Received message: ${message.content} from ${message.author.tag} in ${message.guild ? message.guild.name : 'DM'}`);
    
    // Check if it's a guild message (not a DM)
    if (!message.guild) return;
    
    // Check if message is a command
    if (message.content.startsWith('!task')) {
        // Load the server config if not already loaded
        if (!message.client.serverConfigs[message.guild.id]) {
            message.client.serverConfigs[message.guild.id] = loadServerConfig(message.guild.id);
        }
        
        const serverConfig = message.client.serverConfigs[message.guild.id];
        
        // Check if the bot is restricted to a specific channel
        if (serverConfig.allowedChannelIds && serverConfig.allowedChannelIds.length > 0 && !serverConfig.allowedChannelIds.includes(message.channel.id)) {
            // Allow the setchannel command to work in any channel
            const potentialCommand = message.content.slice('!task'.length).trim().split(/ +/)[0].toLowerCase();
            if (potentialCommand !== 'setchannel') {
                return; // Ignore commands in unauthorized channels
            }
        }
        
        const args = message.content.slice('!task'.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();
        
        const command = message.client.commands.get(commandName);
        
        if (!command) {
            return message.reply('Unknown task command. Use !task help for a list of commands.');
        }
        
        try {
            command.execute(message, args);
        } catch (error) {
            console.error(error);
            message.reply('There was an error executing that command!');
        }
    }

    if (message.content.startsWith('!utter')) {
        const command = message.client.commands.get('utter');
        if (command) {
            try {
                command.execute(message, message.content.slice('!utter'.length).trim().split(/ +/));
            } catch (error) {
                console.error(error);
                message.reply('There was an error executing that command!');
            }
        }
    }


    if (message.content.startsWith('!notice')) {
        const args = message.content.slice('!notice'.length).trim().split(/ +/);
        // If no args, default to help or something? But command expects subcommands.
        // commands/notice.js handles args[0]
        
        const command = message.client.commands.get('notice');
        if (command) {
            try {
                command.execute(message, args);
            } catch (error) {
                console.error(error);
                message.reply('There was an error executing that command!');
            }
        }
    }
});

// Login to Discord with your app's token
client.login(process.env.DISCORD_TOKEN);

client.reminders = [];

// Function to schedule a single reminder
function scheduleReminder(client, reminder) {
    const timeRemaining = reminder.remindAt - Date.now();

    if (timeRemaining > 0) {
        setTimeout(async () => {
            try {
                const user = await client.users.fetch(reminder.userId);
                if (user) {
                    /*
                    // DM functionality disabled by request
                    user.send(`Reminder: "${reminder.message}"`)
                        .catch(error => console.error(`Could not send reminder DM to user ${reminder.userId}:`, error));
                    */
                   console.log(`Reminder for ${user.username}: "${reminder.message}" (DMs disabled)`);
                }
            } catch (error) {
                console.error(`Could not fetch user ${reminder.userId} for reminder:`, error);
            }

            // Remove the reminder after sending
            client.reminders = client.reminders.filter(r => r !== reminder);
            fs.writeFileSync('./reminders.json', JSON.stringify(client.reminders, null, 2));
        }, timeRemaining);
    }
}

// Function to load and schedule all reminders
function scheduleReminders(client) {
    const remindersFilePath = './reminders.json';

    if (!fs.existsSync(remindersFilePath)) {
        fs.writeFileSync(remindersFilePath, JSON.stringify([]), 'utf8');
    }

    client.reminders = JSON.parse(fs.readFileSync(remindersFilePath, 'utf8'));

    client.reminders.forEach(reminder => scheduleReminder(client, reminder));
}

// Make scheduleReminder available to commands
client.scheduleReminder = scheduleReminder;