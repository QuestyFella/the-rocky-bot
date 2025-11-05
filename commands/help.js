const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'help',
    description: 'Show help information for the bot',
    execute(message, args) {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Bocchi Bot - Commands')
            .setDescription('**Task Management**\n' +
                '`!task new`: Create a new task interactively.\n' +
                '`!task add [task]`: Add a new task.\n' +
                '`!task view [@user]`: View your or another user\'s tasks.\n' +
                '`!task edit [number] [description]`: Edit a task.\n' +
                '`!task complete [number]`: Mark a task as complete.\n' +
                '`!task delete [number]`: Delete a task.\n' +
                '`!task duedate [number] [date]`: Set a due date.\n' +
                '`!task clear`: Clear all completed tasks.\n' +
                '`!task remindme [message] in [time]`: Set a reminder for yourself.\n' +
                '`!task remindme [list|view|delete]`: Manage your reminders.\n\n' +
                '**Admin**\n' +
                '`!task assign @user [task]`: Assign a task to a user.\n' +
                '`!task assignrole @role [task]`: Assign a task to a role.\n' +
                '`!task listrole @role`: List tasks for a role.\n' +
                '`!task removerole @role`: Remove tasks for a role.\n' +
                '`!task setchannel [add|remove|list] [#channel]`: Manage allowed channels for the bot.\n' +
                '`!task delete @user [number]`: Delete a user\'s task.\n\n' +
                '**General**\n' +
                '`!task help`: Show this help message.'
            )
            .setTimestamp();
        
        message.channel.send({ embeds: [helpEmbed] });
    }
};
