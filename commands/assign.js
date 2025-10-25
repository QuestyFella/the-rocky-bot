module.exports = {
    name: 'assign',
    description: 'Assign a task to another user',
    execute(message, args) {
        // Check if the user has admin permissions
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to assign tasks to others!');
        }
        
        if (args.length < 2) {
            return message.reply('Please provide a user mention and a task description (e.g., "!task assign @user Do something")');
        }
        
        // Get the mentioned user
        const userMention = message.mentions.users.first();
        if (!userMention) {
            return message.reply('Please mention a user to assign the task to!');
        }
        
        // Get the task description (everything after the user mention)
        const taskDescription = args.slice(1).join(' ');
        
        if (!taskDescription) {
            return message.reply('Please provide a task description!');
        }
        
        // Create the assigned task
        const newTask = {
            id: Date.now(), // unique ID
            title: taskDescription,
            description: `Assigned by ${message.author.username}`,
            dueDate: null,
            completed: false,
            createdAt: new Date().toISOString(),
            userId: userMention.id, // Assign to the mentioned user
            assignedBy: message.author.id, // Track who assigned the task
            guildId: message.guild.id // Store guild ID for multi-server
        };
        
        // Save to guild-specific storage
        const success = message.client.taskStorage.addTask(message.guild.id, newTask);
        
        if (success) {
            message.reply(`Assigned task to ${userMention.username}: "${taskDescription}"`);
        } else {
            message.reply('Failed to save task to storage.');
        }
    }
};