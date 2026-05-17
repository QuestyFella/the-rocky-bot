const { EmbedBuilder } = require('discord.js');

const helpSections = [
    {
        name: 'Kanban Board',
        value: [
            '`!task jira setup` - Create the live board in this channel.',
            '`!task board` - Show the board once.',
            '`!task jira add [issue]` - Add an issue.',
            '`!task jira move [key] [todo|doing|review|done]` - Move an issue.',
            '`!task jira claim [key]` - Assign an issue to yourself.',
            '`!task jira assign [key] @user|@role|none` - Change assignee.',
            '`!task jira priority [key] [low|medium|high|urgent]` - Set priority.',
            '`!task jira due [key] [date|none]` - Set or clear due date.',
            '`!task jira details [key]` - Show issue details.'
        ].join('\n')
    },
    {
        name: 'Personal Tasks',
        value: [
            '`!task add [task]` - Add a task to yourself.',
            '`!task new` - Create a task interactively.',
            '`!task view [@user]` - View tasks.',
            '`!task edit [number] [description]` - Edit your task description.',
            '`!task complete [number]` - Complete your task.',
            '`!task delete [number]` - Delete your task.',
            '`!task duedate [number] [date]` - Set a due date.',
            '`!task clear` - Clear completed tasks.',
            '`!task remindme [message] in [time]` - Set a reminder.'
        ].join('\n')
    },
    {
        name: 'Admin',
        value: [
            '`!task assign @user [task]` - Assign a task to a user.',
            '`!task assignrole @role [task]` - Assign a task to every member of a role.',
            '`!task listrole @role` - List role tasks.',
            '`!task removerole @role` - Remove role tasks.',
            '`!task delete @user [number]` - Delete a user task.',
            '`!task setchannel [add|remove|list] [#channel]` - Manage allowed channels.'
        ].join('\n')
    }
];

module.exports = {
    name: 'help',
    description: 'Show help information for the bot',
    execute(message) {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0052cc)
            .setTitle('Task Bot Commands')
            .setDescription('Use `!task board` for the Kanban board or `!task jira help` for board-specific examples.')
            .addFields(helpSections)
            .setTimestamp();

        message.channel.send({ embeds: [helpEmbed] });
    }
};
