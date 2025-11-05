module.exports = {
    name: 'new',
    description: 'Create a new task interactively',
    async execute(message, args) {
        const questions = [
            "Let's create a new task! What should the title be?",
            "Got it. What's the description for this task? (You can say 'skip' if you don't want to add one)",
            "Great. When is this task due? (e.g., '4 Nov, 2025'. You can say 'skip' for no due date)",
            "Okay. Who should this task be assigned to? (You can say 'me', mention a @user, or a @role)"
        ];

        const answers = [];
        const filter = response => response.author.id === message.author.id;

        for (let i = 0; i < questions.length; i++) {
            await message.channel.send(questions[i]);
            try {
                const collected = await message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
                const answer = collected.first().content.trim();
                if (answer.toLowerCase() === 'cancel') {
                    return message.channel.send('Task creation cancelled.');
                }
                answers.push(collected.first());
            } catch (error) {
                return message.channel.send('You took too long to respond. Task creation cancelled.');
            }
        }

        const [title, description, dueDateInput, assigneeInput] = answers.map(a => a.content.trim());

        let dueDate = null;
        if (dueDateInput.toLowerCase() !== 'skip') {
            const parsedDate = new Date(dueDateInput);
            if (!isNaN(parsedDate.getTime())) {
                dueDate = parsedDate.toISOString().split('T')[0];
            } else {
                message.channel.send("I couldn't understand that date. The task will be created without a due date.");
            }
        }

        const lastMessage = answers[3];
        const mentionedUser = lastMessage.mentions.users.first();
        const mentionedRole = lastMessage.mentions.roles.first();

        if (assigneeInput.toLowerCase() === 'me') {
            const newTask = {
                id: Date.now(),
                title: title,
                description: description.toLowerCase() !== 'skip' ? description : '',
                dueDate: dueDate,
                completed: false,
                createdAt: new Date().toISOString(),
                userId: message.author.id,
                assignedBy: message.author.id,
                guildId: message.guild.id
            };
            const success = message.client.taskStorage.addTask(message.guild.id, newTask);
            if (success) {
                message.reply(`Task "${title}" created and assigned to you.`);
            } else {
                message.reply('Failed to save task to storage.');
            }
        } else if (mentionedUser) {
            const newTask = {
                id: Date.now(),
                title: title,
                description: description.toLowerCase() !== 'skip' ? description : '',
                dueDate: dueDate,
                completed: false,
                createdAt: new Date().toISOString(),
                userId: mentionedUser.id,
                assignedBy: message.author.id,
                guildId: message.guild.id
            };
            const success = message.client.taskStorage.addTask(message.guild.id, newTask);
            if (success) {
                message.reply(`Task "${title}" created and assigned to ${mentionedUser.username}.`);
            } else {
                message.reply('Failed to save task to storage.');
            }
        } else if (mentionedRole) {
            const membersWithRole = message.guild.members.cache.filter(member => 
                member.roles.cache.has(mentionedRole.id) && !member.user.bot
            );

            if (membersWithRole.size === 0) {
                return message.reply(`No members found with the role!`);
            }

            let successCount = 0;
            for (const member of membersWithRole.values()) {
                const newTask = {
                    id: Date.now() + successCount,
                    title: title,
                    description: description.toLowerCase() !== 'skip' ? description : '',
                    dueDate: dueDate,
                    completed: false,
                    createdAt: new Date().toISOString(),
                    userId: member.user.id,
                    assignedBy: message.author.id,
                    assignedToRole: mentionedRole.id,
                    guildId: message.guild.id
                };
                const success = message.client.taskStorage.addTask(message.guild.id, newTask);
                if (success) {
                    successCount++;
                }
            }
            message.reply(`Successfully assigned task to ${successCount} member(s) with the role.`);
        } else {
            return message.reply("I couldn't figure out who to assign the task to. Please try again and make sure to mention a user or a role, or say 'me'.");
        }
    }
};