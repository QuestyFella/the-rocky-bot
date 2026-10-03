const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'help',
    description: 'Show Kanban board commands',
    execute(message) {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0052cc)
            .setTitle('Kanban Board Commands')
            .setDescription('Open `!task` and use the buttons. Choose **Available Tasks**, pick a task, then **Claim** or **Start Work**. **My Tasks** shows your work; **My Teams** shows active work tagged for your Discord team roles. Use the task’s dropdowns to change its status or team.')
            .addFields(
                {
                    name: 'Core Flow',
                    value: [
                        '`!task` - Show the board.',
                        '`!task setup` - Create the live-updating board in this channel.',
                        '`!task add [issue]` - Add an issue.',
                        '`!task available` / `!task mine` - Browse available tasks or your work.',
                        '`!task myteams` - Show your teams’ active tasks.',
                        '`!task move [key] [todo|doing|review|done]` - Move an issue.',
                        '`!task claim [key]` - Assign an issue to yourself.',
                        '`!task start [key]` - Claim and move to In Progress.',
                        '`!task release [key]` - Return your task to To Do.',
                        '`!task done [key]` - Move an issue to Done.'
                    ].join('\n')
                },
                {
                    name: 'Issue Details',
                    value: [
                        '`!task details [key]` - Show one issue.',
                        '`!task assign [key] @user|@role|none` - Change assignee.',
                        '`!task team [key] @TeamRole|none` - Set or clear the team tag.',
                        '`!task priority [key] [low|medium|high|urgent]` - Set priority.',
                        '`!task due [key] [date|none]` - Set or clear due date.',
                        '`!task edit [key] [new title]` - Rename an issue.',
                        '`!task delete [key]` - Delete an issue.'
                    ].join('\n')
                },
                {
                    name: 'Setup',
                    value: [
                        '`!task setchannel add #channel` - Restrict bot commands to a channel.',
                        '**Setup Teams** button / `!task teams` - Pick team roles (Manage Server).',
                        '`!task setchannel list` - Show allowed channels.',
                        '`!task role all @Role [remove]` - Mass add/remove a role; add skips pending members and bots.',
                        '`!task verify setup #channel @Role` or IDs - New members type a random emoji to verify.',
                        '`!task verify status` / `!task verify off` - Check or disable verification.',
                        '`!task board`, `!task kanban`, and `!task jira` still work as aliases.'
                    ].join('\n')
                }
            )
            .setTimestamp();

        message.channel.send({ embeds: [helpEmbed] });
    }
};
