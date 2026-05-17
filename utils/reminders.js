const fs = require('fs');

const remindersFilePath = './reminders.json';

function loadReminders() {
    if (!fs.existsSync(remindersFilePath)) {
        fs.writeFileSync(remindersFilePath, JSON.stringify([]), 'utf8');
    }

    try {
        const raw = fs.readFileSync(remindersFilePath, 'utf8');
        return raw.trim() ? JSON.parse(raw) : [];
    } catch (error) {
        console.error('Error loading reminders:', error);
        return [];
    }
}

function saveReminders(reminders) {
    fs.writeFileSync(remindersFilePath, JSON.stringify(reminders, null, 2));
}

function isSameReminder(left, right) {
    return left.userId === right.userId &&
        left.message === right.message &&
        left.remindAt === right.remindAt;
}

function scheduleReminder(client, reminder) {
    const timeRemaining = reminder.remindAt - Date.now();

    if (timeRemaining <= 0) {
        return;
    }

    setTimeout(async () => {
        const stillActive = client.reminders.some(savedReminder => isSameReminder(savedReminder, reminder));
        if (!stillActive) {
            return;
        }

        try {
            const user = await client.users.fetch(reminder.userId);
            if (user) {
                console.log(`Reminder for ${user.username}: "${reminder.message}" (DMs disabled)`);
            }
        } catch (error) {
            console.error(`Could not fetch user ${reminder.userId} for reminder:`, error);
        }

        client.reminders = client.reminders.filter(savedReminder => !isSameReminder(savedReminder, reminder));
        saveReminders(client.reminders);
    }, timeRemaining);
}

function scheduleReminders(client) {
    const now = Date.now();
    client.reminders = loadReminders().filter(reminder => reminder.remindAt > now);
    saveReminders(client.reminders);
    client.reminders.forEach(reminder => scheduleReminder(client, reminder));
}

module.exports = {
    loadReminders,
    saveReminders,
    scheduleReminder,
    scheduleReminders
};
