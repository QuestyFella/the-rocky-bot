const { Client, GatewayIntentBits, Collection, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const TaskStorage = require('./taskStorage');

// Create a new client instance
const client = new Client({ 
    intents: [ 
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
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
});

// When a message is received
client.on('messageCreate', message => {
    // Ignore messages from bots
    if (message.author.bot) return;
    
    // Check if message is a command
    if (message.content.startsWith('!task')) {
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