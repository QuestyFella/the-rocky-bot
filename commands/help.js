const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'help',
    description: 'Show task board help',
    execute(message) {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0052cc)
            .setTitle('Task Board')
            .setDescription([
                '**Getting started takes three clicks:**',
                '1. On the board, click **Find Work** and pick a task.',
                '2. Click **Claim**. It is now yours and In Progress. Others can click **Join** to work on it with you.',
                '3. When finished, open **My Tasks** and click **Mark Done**.',
                '',
                'Anyone can click **Add Task**. Start a title with a tag like `[POWER]` to group related work.',
                'Some tasks are 🔒 locked: they appear once the tasks before them in the same category are done.'
            ].join('\n'))
            .addFields(
                {
                    name: 'Text commands',
                    value: [
                        '`!task` - Show the board',
                        '`!task add [TAG] Title` - Add a task',
                        '`!task claim KEY` / `!task done KEY` / `!task unclaim KEY` / `!task reopen KEY`',
                        '`!task details KEY` - Show one task',
                        '`!task edit KEY New title` / `!task due KEY 2026-12-01|none` / `!task delete KEY`'
                    ].join('\n')
                },
                {
                    name: 'Managers',
                    value: [
                        '`!task setup` - Post the live board in this channel',
                        '`!task setup NAME` - Create a separate board here (for example `exec` or `liquid-rocket`)',
                        '`!task block KEY OTHER-1, OTHER-2|none` - Hide a task until same-category tasks are done',
                        '`!task import` - Attach a .txt list (`Title:`, `Description:`, `Due date:` lines) or paste it after the command',
                        '`!task assign KEY @user [@user2…]|none` - Add people to a task, or take everyone off it',
                        '`!task notice on|off` - Show or hide a "How this board works" card at the top of this channel\'s board',
                        '`!task notice set Your text` / `!task notice default` - Use your own notice text, or go back to the built-in one',
                        '`!task refresh` - Redraw the live board',
                        '`!task setchannel add|remove|list #channel` - Limit where the bot answers',
                        '`!task role all @Role [remove]` - Add or remove a role for everyone'
                    ].join('\n')
                }
            );

        return message.channel.send({ embeds: [helpEmbed] });
    }
};
