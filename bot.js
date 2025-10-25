const { Client, GatewayIntentBits, Collection, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const cron = require('node-cron');
const TaskStorage = require('./taskStorage');

// Load configuration
let config = { allowedChannelId: null };
try {
    const configFile = fs.readFileSync('./config.json', 'utf8');
    config = JSON.parse(configFile);
} catch (error) {
    console.log('No config file found, using default settings');
}

// Create a new client instance
const client = new Client({ 
    intents: [ 
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ] 
});

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
    
    // Load tasks from storage
    client.tasks = client.taskStorage.getAllTasks();
    
    // Set bot activity
    client.user.setActivity('your tasks | Use /help', { type: 'WATCHING' });
    
    // Schedule task reminder check every day at midnight
    cron.schedule('0 0 * * *', async () => {
        console.log('Checking for tasks due tomorrow...');
        
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowString = tomorrow.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        
        // Find tasks due tomorrow that aren't completed
        const tasksDueTomorrow = client.tasks.filter(task => {
            return task.dueDate === tomorrowString && !task.completed;
        });
        
        console.log(`Found ${tasksDueTomorrow.length} tasks due tomorrow`);
        
        for (const task of tasksDueTomorrow) {
            try {
                // Find the user in the Discord server
                const user = await client.users.fetch(task.userId);
                
                if (user) {
                    // Attempt to send a direct message to the user
                    await user.send(`⏰ Reminder: Your task "${task.title}" is due tomorrow!`);
                    console.log(`Sent reminder to user ${user.username} for task: ${task.title}`);
                }
            } catch (error) {
                console.error(`Could not send reminder to user ID ${task.userId}:`, error);
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
    
    // Check if message is a command
    if (message.content.startsWith('!task')) {
        // Check if the bot is restricted to a specific channel
        if (config.allowedChannelId && message.channel.id !== config.allowedChannelId) {
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