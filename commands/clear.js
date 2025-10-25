module.exports = {
    name: 'clear',
    description: 'Clear all completed tasks',
    execute(message, args) {
        // Get user tasks
        const userTasks = message.client.taskStorage.getUserTasks(message.author.id);
        const completedTasks = userTasks.filter(task => task.completed);
        
        if (completedTasks.length === 0) {
            return message.reply('No completed tasks to clear!');
        }
        
        // Remove completed tasks from main tasks array
        for (const completedTask of completedTasks) {
            const taskIndexInMainArray = message.client.tasks.findIndex(task => task.id === completedTask.id);
            if (taskIndexInMainArray !== -1) {
                message.client.tasks.splice(taskIndexInMainArray, 1);
            }
        }
        
        // Update storage to remove completed tasks
        let success = true;
        for (const completedTask of completedTasks) {
            if (!message.client.taskStorage.deleteTask(completedTask.id)) {
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