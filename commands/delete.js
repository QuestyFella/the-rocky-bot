module.exports = {
    name: 'delete',
    description: 'Delete a task',
    execute(message, args) {
        // Get user tasks from guild-specific storage
        const userTasks = message.client.taskStorage.getUserTasks(message.guild.id, message.author.id);
        
        if (!args.length) {
            return message.reply('Please provide a task number to delete!');
        }
        
        const taskIndex = parseInt(args[0]) - 1;
        if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= userTasks.length) {
            return message.reply('Please provide a valid task number!');
        }
        
        const taskToDelete = userTasks[taskIndex];
        
        // Delete the task from guild-specific storage
        const success = message.client.taskStorage.deleteTask(message.guild.id, taskToDelete.id);
        
        if (success) {
            message.reply(`Deleted task: "${taskToDelete.title}"`);
        } else {
            message.reply('Failed to delete task from storage.');
        }
    }
};