module.exports = {
    name: 'assignrole',
    description: 'Assign a task to all members of a specific role',
    execute(message, args) {
        // Check if the user has admin permissions
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to assign tasks to a role!');
        }
        
        if (args.length < 2) {
            return message.reply('Please provide a role mention/name and a task description (e.g., "!task assignrole @role Do something")');
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
        
        // Get the task description (everything after the role)
        const taskDescription = args.slice(1).join(' ');
        
        if (!taskDescription) {
            return message.reply('Please provide a task description!');
        }
        
        // Get all members with this role
        const membersWithRole = message.guild.members.cache.filter(member => 
            member.roles.cache.has(role.id) && !member.user.bot // Exclude bots
        );
        
        if (membersWithRole.size === 0) {
            return message.reply(`No members found with the role ${role.toString()}!`);
        }
        
        let successCount = 0;
        
        // Create a task for each member with this role
        for (const member of membersWithRole.values()) {
            const newTask = {
                id: Date.now() + successCount, // unique ID
                title: taskDescription,
                description: `Assigned to role: ${role.name} by ${message.author.username}`,
                dueDate: null,
                completed: false,
                createdAt: new Date().toISOString(),
                userId: member.user.id, // Assign to the role member
                assignedBy: message.author.id, // Track who assigned the task
                assignedToRole: role.id, // Track which role the task was assigned to
                guildId: message.guild.id // Store guild ID for multi-server
            };
            
            // Save to guild-specific storage
            const success = message.client.taskStorage.addTask(message.guild.id, newTask);
            
            if (success) {
                successCount++;
            }
        }
        
        message.reply(`Successfully assigned task to ${successCount} member(s) with role ${role.toString()}: "${taskDescription}"`);
    }
};