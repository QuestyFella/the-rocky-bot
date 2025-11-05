module.exports = {
    name: 'view',
    description: "View your own or another user's tasks.",
    execute(message, args) {
        const userToView = message.mentions.users.first() || message.author;
        const isSelf = userToView.id === message.author.id;

        if (!isSelf && !message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to view other users\' tasks!');
        }

        const userTasks = message.client.taskStorage.getUserTasks(message.guild.id, userToView.id);

        if (userTasks.length === 0) {
            const reply = isSelf ? 'You have no tasks.' : `${userToView.username} has no tasks.`;
            return message.reply(reply);
        }

        const taskListHeader = isSelf ? 'Your tasks:\n' : `${userToView.username}'s tasks:\n`;
        let taskList = taskListHeader;
        userTasks.forEach((task, index) => {
            taskList += `${index + 1}. ${task.completed ? '✅' : '❌'} ${task.title}\n`;
            if (task.description) {
                taskList += `   ${task.description}\n`;
            }
            if (task.dueDate) {
                taskList += `   Due: ${task.dueDate}\n`;
            }
            taskList += '\n';
        });

        message.channel.send(taskList);
    }
};