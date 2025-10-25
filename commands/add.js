module.exports = {
    name: 'add',
    description: 'Add a new task',
    execute(message, args) {
        if (!args.length) {
            return message.reply('Please provide a task title!');
        }
        
        const taskTitle = args.join(' ');
        const newTask = {
            id: Date.now(), // unique ID
            title: taskTitle,
            description: '',
            dueDate: null,
            completed: false,
            createdAt: new Date().toISOString(),
            userId: message.author.id // Store the user ID
        };
        
        // Add to in-memory tasks and save to file
        message.client.tasks.push(newTask);
        const success = message.client.taskStorage.addTask(newTask);
        
        if (success) {
            message.reply(`Added new task: "${taskTitle}"`);
        } else {
            message.reply('Failed to save task to storage.');
        }
    }
};