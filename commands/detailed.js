const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'detailed',
    description: 'Show detailed view of all tasks',
    execute(message, args) {
        // Get user tasks from storage
        const userTasks = message.client.taskStorage.getUserTasks(message.author.id);
        
        if (userTasks.length === 0) {
            return message.reply('No tasks found!');
        }
        
        // Create an embed to display tasks
        const taskEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Your Tasks')
            .setTimestamp();
        
        // Add fields for each task (Discord embeds have a limit on fields, so only show first 25)
        const tasksToShow = userTasks.slice(0, 25); // Limit to 25 tasks to avoid Discord limits
        
        if (tasksToShow.length > 0) {
            tasksToShow.forEach((task, index) => {
                const status = task.completed ? '✅ Completed' : '❌ Pending';
                const taskValue = `${task.description ? task.description + '\n' : ''}${task.dueDate ? `Due: ${task.dueDate}` : ''}`;
                
                taskEmbed.addFields({
                    name: `${index + 1}. ${task.title}`,
                    value: `${status}${taskValue ? `\n${taskValue}` : ''}`,
                    inline: false
                });
            });
            
            if (userTasks.length > 25) {
                taskEmbed.setFooter({ text: `Showing first 25 of ${userTasks.length} tasks` });
            } else {
                taskEmbed.setFooter({ text: `Total: ${userTasks.length} tasks` });
            }
        }
        
        message.channel.send({ embeds: [taskEmbed] });
    }
};