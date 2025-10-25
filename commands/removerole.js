module.exports = {
    name: 'removerole',
    description: 'Remove tasks assigned to a specific role from all members',
    execute(message, args) {
        // Check if the user has admin permissions
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to remove tasks from a role!');
        }
        
        if (args.length < 1) {
            return message.reply('Please provide a role mention/name to remove tasks from (e.g., "!task removerole @role")');
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
        
        let successCount = 0;
        
        // Delete each task assigned to this role
        for (const task of roleTasks) {
            const success = message.client.taskStorage.deleteTask(message.guild.id, task.id);
            if (success) {
                successCount++;
            }
        }
        
        message.reply(`Successfully removed ${successCount} task(s) assigned to role ${role.toString()}.`);
    }
};