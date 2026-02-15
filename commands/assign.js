module.exports = {
    name: 'assign',
    description: 'Assign a task to another user',
    async execute(message, args) {
        // Check if the user has admin permissions
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to assign tasks to others!');
        }
        
        if (args.length < 2) {
            return message.reply('Please provide a user mention and a task description (e.g., "!task assign @user Do something")');
        }
        
        // Get the mentioned user
        let userMention = message.mentions.users.first();
        if (!userMention) {
            // Check if first arg is a User ID
            const userId = args[0].replace(/[<@!>]/g, '');
            if (/^\d{17,19}$/.test(userId)) {
                try {
                    userMention = await message.client.users.fetch(userId);
                } catch (error) {
                    return message.reply('Invalid user ID provided or user not found.');
                }
            } else {
                return message.reply('Please mention a user or provide a valid user ID to assign the task to!');
            }
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