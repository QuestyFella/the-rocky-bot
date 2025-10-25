module.exports = {
    name: 'edit',
    description: 'Edit a task description or due date',
    execute(message, args) {
        // Get user tasks
        const userTasks = message.client.taskStorage.getUserTasks(message.author.id);
        
        if (args.length < 2) {
            return message.reply('Please provide a task number and new description (e.g., "!task edit 1 New description")');
        }
        
        const taskIndex = parseInt(args[0]) - 1;
        if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= userTasks.length) {
            return message.reply('Please provide a valid task number!');
        }
        
        const taskToEdit = userTasks[taskIndex];
        const newDescription = args.slice(1).join(' ');
        
        // Update the task in the main tasks array
        const taskInMainArray = message.client.tasks.find(task => task.id === taskToEdit.id);
        if (taskInMainArray) {
            taskInMainArray.description = newDescription;
            
            // Update the task in storage
            const success = message.client.taskStorage.updateTask(taskToEdit.id, taskInMainArray);
            
            if (success) {
                message.reply(`Updated task: "${taskToEdit.title}" with new description: "${newDescription}"`);
            } else {
                message.reply('Failed to update task in storage.');
            }
        }
    }
};