module.exports = {
    name: 'clear',
    description: 'Clear all completed tasks',
    execute(message, args) {
        // Get user tasks from guild-specific storage
        const userTasks = message.client.taskStorage.getUserTasks(message.guild.id, message.author.id);
        const completedTasks = userTasks.filter(task => task.completed);
        
        if (completedTasks.length === 0) {
            return message.reply('No completed tasks to clear!');
        }
        
        // Update storage to remove completed tasks
        let success = true;
        for (const completedTask of completedTasks) {
            if (!message.client.taskStorage.deleteTask(message.guild.id, completedTask.id)) {
                success = false;
            }
        }
        
        if (success) {
            message.reply(`Cleared ${completedTasks.length} completed task(s)!`);
        } else {
            message.reply('Failed to clear some tasks from storage.');
        }
    }
};