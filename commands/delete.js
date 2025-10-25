module.exports = {
    name: 'delete',
    description: 'Delete a task',
    execute(message, args) {
        // Get user tasks
        const userTasks = message.client.taskStorage.getUserTasks(message.author.id);
        
        if (!args.length) {
            return message.reply('Please provide a task number to delete!');
        }
        
        const taskIndex = parseInt(args[0]) - 1;
        if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= userTasks.length) {
            return message.reply('Please provide a valid task number!');
        }
        
        const taskToDelete = userTasks[taskIndex];
        
        // Remove the task from the main tasks array
        const taskIndexInMainArray = message.client.tasks.findIndex(task => task.id === taskToDelete.id);
        if (taskIndexInMainArray !== -1) {
            message.client.tasks.splice(taskIndexInMainArray, 1);
            
            // Delete the task from storage
            const success = message.client.taskStorage.deleteTask(taskToDelete.id);
            
            if (success) {
                message.reply(`Deleted task: "${taskToDelete.title}"`);
            } else {
                message.reply('Failed to delete task from storage.');
            }
        }
    }
};