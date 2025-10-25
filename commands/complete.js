module.exports = {
    name: 'complete',
    description: 'Complete a task',
    execute(message, args) {
        // Get user tasks from guild-specific storage
        const userTasks = message.client.taskStorage.getUserTasks(message.guild.id, message.author.id);
        
        if (!args.length) {
            return message.reply('Please provide a task number to complete!');
        }
        
        const taskIndex = parseInt(args[0]) - 1;
        if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= userTasks.length) {
            return message.reply('Please provide a valid task number!');
        }
        
        const taskToComplete = userTasks[taskIndex];
        
        // Update the task as completed
        taskToComplete.completed = true;
        
        // Update the task in guild-specific storage
        const success = message.client.taskStorage.updateTask(message.guild.id, taskToComplete.id, taskToComplete);
        
        if (success) {
            message.reply(`Completed task: "${taskToComplete.title}"`);
        } else {
            message.reply('Failed to update task in storage.');
        }
    }
};