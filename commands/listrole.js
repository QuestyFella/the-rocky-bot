module.exports = {
    name: 'listrole',
    description: 'List tasks assigned to a specific role',
    execute(message, args) {
        // Check if the user has admin permissions
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to list tasks for a role!');
        }
        
        if (args.length < 1) {
            return message.reply('Please provide a role mention/name to list tasks for (e.g., "!task listrole @role")');
        }
        
        // Find the role - check mentions first, then by name
        let role = message.mentions.roles.first();
        if (!role) {
            // If not mentioned, try to find by name
            role = message.guild.roles.cache.find(r => r.name.toLowerCase() === args[0].toLowerCase());
            if (!role) {
                return message.reply('Please mention a valid role or provide a role name!');
            }
        }
        
        // Get all tasks assigned to this role in the guild
        const allTasks = message.client.taskStorage.getAllTasks(message.guild.id);
        const roleTasks = allTasks.filter(task => task.assignedToRole === role.id);
        
        if (roleTasks.length === 0) {
            return message.reply(`No tasks found assigned to the role ${role.toString()}!`);
        }
        
        let taskList = `Tasks assigned to role ${role.toString()}:\n`;
        roleTasks.forEach((task, index) => {
            const assignedByUser = message.client.users.cache.get(task.assignedBy);
            const assignedByName = assignedByUser ? assignedByUser.username : 'Unknown User';
            
            taskList += `${index + 1}. ${task.completed ? '✅' : '❌'} ${task.title} (assigned by ${assignedByName})\n`;
            if (task.description && !task.description.startsWith('Assigned to role')) {
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