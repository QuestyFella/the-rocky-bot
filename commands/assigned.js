module.exports = {
    name: 'assigned',
    description: 'List tasks assigned to you by others',
    execute(message, args) {
        // Get tasks assigned to the user from guild-specific storage
        const allTasks = message.client.taskStorage.getAllTasks(message.guild.id);
        const assignedTasks = allTasks.filter(task => 
            task.userId === message.author.id && 
            task.assignedBy && 
            task.assignedBy !== message.author.id
        );
        
        if (assignedTasks.length === 0) {
            return message.reply('No tasks assigned to you by others!');
        }
        
        let taskList = `Tasks assigned to you by others:\n`;
        assignedTasks.forEach((task, index) => {
            const assignedByUser = message.client.users.cache.get(task.assignedBy);
            const assignedByName = assignedByUser ? assignedByUser.username : 'Unknown User';
            
            taskList += `${index + 1}. ${task.completed ? '✅' : '❌'} ${task.title} (assigned by ${assignedByName})\n`;
            if (task.description && !task.description.startsWith('Assigned by')) {
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