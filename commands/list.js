module.exports = {
    name: 'list',
    description: 'List all tasks',
    execute(message, args) {
        // Get user tasks from guild-specific storage
        const userTasks = message.client.taskStorage.getUserTasks(message.guild.id, message.author.id);
        
        if (userTasks.length === 0) {
            return message.reply('No tasks found!');
        }
        
        let taskList = 'Your tasks:\n';
        userTasks.forEach((task, index) => {
            taskList += `${index + 1}. ${task.completed ? '✅' : '❌'} ${task.title}\n`;
            if (task.description) {
                taskList += `   ${task.description}\n`;
            }
            if (task.dueDate) {
                taskList += `   Due: ${task.dueDate}\n`;
            }
            taskList += '\n';
        });
        
        message.channel.send(taskList);
    }
};