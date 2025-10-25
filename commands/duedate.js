module.exports = {
    name: 'duedate',
    description: 'Set a due date for a task',
    execute(message, args) {
        // Get user tasks
        const userTasks = message.client.taskStorage.getUserTasks(message.author.id);
        
        if (args.length < 2) {
            return message.reply('Please provide a task number and due date (e.g., "!task duedate 1 2023-12-25")');
        }
        
        const taskIndex = parseInt(args[0]) - 1;
        if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= userTasks.length) {
            return message.reply('Please provide a valid task number!');
        }
        
        const taskToEdit = userTasks[taskIndex];
        const dueDateInput = args.slice(1).join(' ');
        
        // Parse the date and format it as YYYY-MM-DD
        let dueDate = null;
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD format
        
        if (dateRegex.test(dueDateInput)) {
            // Already in correct format
            dueDate = dueDateInput;
        } else {
            // Try to parse other date formats
            const parsedDate = new Date(dueDateInput);
            if (isNaN(parsedDate.getTime())) {
                return message.reply('Please provide a valid date format (YYYY-MM-DD or a recognizable date format like "Dec 25, 2023")');
            }
            
            // Format to YYYY-MM-DD
            dueDate = parsedDate.toISOString().split('T')[0];
        }
        
        // Update the task in the main tasks array
        const taskInMainArray = message.client.tasks.find(task => task.id === taskToEdit.id);
        if (taskInMainArray) {
            taskInMainArray.dueDate = dueDate;
            
            // Update the task in storage
            const success = message.client.taskStorage.updateTask(taskToEdit.id, taskInMainArray);
            
            if (success) {
                message.reply(`Set due date for task: "${taskToEdit.title}" to ${dueDate}`);
            } else {
                message.reply('Failed to update task in storage.');
            }
        }
    }
};