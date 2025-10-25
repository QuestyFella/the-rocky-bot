module.exports = {
    name: 'complete',
    description: 'Complete a task',
    execute(message, args) {
        // Get user tasks
        const userTasks = message.client.taskStorage.getUserTasks(message.author.id);
        
        if (!args.length) {
            return message.reply('Please provide a task number to complete!');
        }
        
        const taskIndex = parseInt(args[0]) - 1;
        if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= userTasks.length) {
            return message.reply('Please provide a valid task number!');
        }
        
        const taskToComplete = userTasks[taskIndex];
        
        // Update the task as completed in the main tasks array
        const taskInMainArray = message.client.tasks.find(task => task.id === taskToComplete.id);
        if (taskInMainArray) {
            taskInMainArray.completed = true;
            
            // Update the task in storage
            const success = message.client.taskStorage.updateTask(taskToComplete.id, taskInMainArray);
            
            if (success) {
                message.reply(`Completed task: "${taskToComplete.title}"`);
            } else {
                message.reply('Failed to update task in storage.');
            }
        }
    }
};