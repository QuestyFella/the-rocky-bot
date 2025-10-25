module.exports = {
    name: 'add',
    description: 'Add a new task',
    execute(message, args) {
        if (!args.length) {
            return message.reply('Please provide a task title!');
        }
        
        const taskTitle = args.join(' ');
        const newTask = {
            id: Date.now(), // unique ID
            title: taskTitle,
            description: '',
            dueDate: null,
            completed: false,
            createdAt: new Date().toISOString(),
            userId: message.author.id, // Store the user ID
            guildId: message.guild.id // Store guild ID for multi-server
        };
        
        // Save to guild-specific storage
        const success = message.client.taskStorage.addTask(message.guild.id, newTask);
        
        if (success) {
            message.reply(`Added new task: "${taskTitle}"`);
        } else {
            message.reply('Failed to save task to storage.');
        }
    }
};