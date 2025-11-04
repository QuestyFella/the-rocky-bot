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
            return JSON.parse(configFile);
        }
    } catch (error) {
        console.log(`No config file found for server ${guildId}, using default settings`);
    }
    
    // Return default config
    return { allowedChannelId: null };
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
    client.user.setActivity('your tasks | Use /help', { type: 'WATCHING' });
    
    // Schedule task reminder check every day at midnight
    cron.schedule('0 0 * * *', async () => {
        console.log('Checking for tasks due tomorrow...');
        
        // Get all available guilds
        for (const guild of client.guilds.cache.values()) {
            // Load tasks for this specific guild
            const guildTasks = client.taskStorage.getAllTasks(guild.id);
            
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowString = tomorrow.toISOString().split('T')[0]; // Format as YYYY-MM-DD
            
            // Find tasks due tomorrow that aren't completed in this guild
            const tasksDueTomorrow = guildTasks.filter(task => {
                return task.dueDate === tomorrowString && !task.completed;
            });
            
            console.log(`Found ${tasksDueTomorrow.length} tasks due tomorrow in guild ${guild.name}`);
            
            for (const task of tasksDueTomorrow) {
                try {
                    // Find the user in the Discord server
                    const user = await client.users.fetch(task.userId);
                    
                    if (user) {
                        // Attempt to send a direct message to the user
                        await user.send(`⏰ Reminder: Your task "${task.title}" is due tomorrow! (from ${guild.name})`);
                        console.log(`Sent reminder to user ${user.username} for task: ${task.title}`);
                    }
                } catch (error) {
                    console.error(`Could not send reminder to user ID ${task.userId}:`, error);
                }
            }
        }
    }, {
        scheduled: true,
        timezone: "America/Toronto" // Set appropriate timezone
    });
    
    console.log('Task reminder scheduler started');
});

// When a message is received
client.on('messageCreate', message => {
    // Ignore messages from bots
    if (message.author.bot) return;
    
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
        if (serverConfig.allowedChannelId && message.channel.id !== serverConfig.allowedChannelId) {
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
});

// Login to Discord with your app's token
client.login(process.env.DISCORD_TOKEN);