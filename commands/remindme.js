const ms = require('ms');
const fs = require('fs');

module.exports = {
    name: 'remindme',
    description: 'Set, list, view, or delete a reminder for yourself.',
    execute(message, args) {
        const subCommand = args[0] ? args[0].toLowerCase() : null;
        const reminders = JSON.parse(fs.readFileSync('./reminders.json', 'utf8'));
        const userReminders = reminders.filter(r => r.userId === message.author.id);

        if (subCommand === 'list') {
            if (userReminders.length === 0) {
                return message.reply('You have no reminders set.');
            }
            let reply = 'Your reminders:\n';
            userReminders.forEach((reminder, index) => {
                reply += `${index + 1}. "${reminder.message}" - in ${ms(reminder.remindAt - Date.now(), { long: true })}\n`;
            });
            return message.reply(reply);
        } else if (subCommand === 'view') {
            const index = parseInt(args[1]) - 1;
            if (isNaN(index) || index < 0 || index >= userReminders.length) {
                return message.reply('Invalid reminder number.');
            }
            const reminder = userReminders[index];
            return message.reply(`Reminder ${index + 1}: "${reminder.message}"\nSet to go off in: ${ms(reminder.remindAt - Date.now(), { long: true })}`);
        } else if (subCommand === 'delete') {
            const index = parseInt(args[1]) - 1;
            if (isNaN(index) || index < 0 || index >= userReminders.length) {
                return message.reply('Invalid reminder number.');
            }
            const reminderToDelete = userReminders[index];
            const newReminders = reminders.filter(r => r !== reminderToDelete);
            fs.writeFileSync('./reminders.json', JSON.stringify(newReminders, null, 2));
            return message.reply(`Deleted reminder: "${reminderToDelete.message}"`);
        }

        const fullArgs = args.join(' ');
        const timeMatch = fullArgs.match(/in\s+(.+)$/i);

        if (!timeMatch) {
            return message.reply('Please provide a time for the reminder. Example: `!task remindme take out the trash in 4 hours`');
        }

        const timeString = timeMatch[1];
        const reminderMessage = fullArgs.substring(0, timeMatch.index).trim();

        if (!reminderMessage) {
            return message.reply('Please provide a reminder message.');
        }
        
        const processedTimeString = timeString
            .replace(/hours?/g, 'h')
            .replace(/hrs?/g, 'h')
            .replace(/minutes?/g, 'm')
            .replace(/mins?/g, 'm')
            .replace(/days?/g, 'd');

        const time = ms(processedTimeString);

        if (!time) {
            return message.reply('Invalid time format. Please use a format like `4 hours`, `30 minutes`, `1d`, etc.');
        }

        if (time > 2147483647) { // setTimeout has a max value of 2^31 - 1
            return message.reply('The reminder time is too far in the future. Please choose a shorter time.');
        }

        const remindAt = Date.now() + time;

        const reminder = {
            userId: message.author.id,
            message: reminderMessage,
            remindAt: remindAt
        };

        reminders.push(reminder);
        fs.writeFileSync('./reminders.json', JSON.stringify(reminders, null, 2));

        message.client.scheduleReminder(message.client, reminder);

        message.reply(`Okay, I will remind you to "${reminderMessage}" in ${ms(time, { long: true })}.`);
    }
};