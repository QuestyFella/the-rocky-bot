module.exports = {
    name: 'delete',
    description: "Delete your own or another user's task.",
    execute(message, args) {
        const userToModify = message.mentions.users.first() || message.author;
        const isSelf = userToModify.id === message.author.id;
        const taskNumberArg = isSelf ? args[0] : args[1];

        if (!isSelf && !message.member.permissions.has('Administrator')) {
            return message.reply('You must have administrator permissions to delete other users\' tasks!');
        }

        if (!taskNumberArg) {
            return message.reply('Please provide a task number to delete.');
        }

        const taskIndex = parseInt(taskNumberArg) - 1;
        const userTasks = message.client.taskStorage.getUserTasks(message.guild.id, userToModify.id);

        if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= userTasks.length) {
            return message.reply('Please provide a valid task number.');
        }

        const taskToDelete = userTasks[taskIndex];
        const success = message.client.taskStorage.deleteTask(message.guild.id, taskToDelete.id);

        if (success) {
            const reply = isSelf 
                ? `Deleted task: "${taskToDelete.title}"`
                : `Deleted task "${taskToDelete.title}" from ${userToModify.username}'s list.`;
            message.reply(reply);
        } else {
            message.reply('Failed to delete the task.');
        }
    }
};