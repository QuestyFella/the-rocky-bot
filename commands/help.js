const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'help',
    description: 'Show help information for the bot',
    execute(message, args) {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Task Manager Bot - Commands')
            .setDescription('Here are the available commands:')
            .addFields(
                { name: '!task add [task]', value: 'Add a new task' },
                { name: '!task assign @user [task]', value: 'Assign a task to another user' },
                { name: '!task list', value: 'List all your tasks' },
                { name: '!task assigned', value: 'List tasks assigned to you by others' },
                { name: '!task detailed', value: 'Show detailed view of all tasks' },
                { name: '!task complete [number]', value: 'Mark a task as complete' },
                { name: '!task delete [number]', value: 'Delete a task' },
                { name: '!task edit [number] [description]', value: 'Edit a task description' },
                { name: '!task duedate [number] [date]', value: 'Set a due date for a task' },
                { name: '!task clear', value: 'Clear all completed tasks' },
                { name: '!task help', value: 'Show this help message' }
            )
            .setTimestamp();
        
        message.channel.send({ embeds: [helpEmbed] });
    }
};