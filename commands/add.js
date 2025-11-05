module.exports = {
    name: 'add',
    description: 'Add a new task',
    execute(message, args) {
        if (!args.length) {
            return message.reply('Please provide a task title!');
        }
        
        let taskTitle = args.join(' ');
        let dueDate = null;

        const keywords = ['by', 'on', 'at'];
        let keywordIndex = -1;
        let keyword = '';

        for (const kw of keywords) {
            const index = args.lastIndexOf(kw);
            if (index > keywordIndex) {
                keywordIndex = index;
                keyword = kw;
            }
        }

        if (keywordIndex !== -1) {
            taskTitle = args.slice(0, keywordIndex).join(' ');
            const dueDateInput = args.slice(keywordIndex + 1).join(' ');
            
            if (dueDateInput) {
                const parsedDate = new Date(dueDateInput);
                if (!isNaN(parsedDate.getTime())) {
                    dueDate = parsedDate.toISOString().split('T')[0];
                }
            }
        }

        if (!taskTitle) {
            return message.reply('Please provide a task title!');
        }

        const newTask = {
            id: Date.now(), // unique ID
            title: taskTitle,
            description: '',
            dueDate: dueDate,
            completed: false,
            createdAt: new Date().toISOString(),
            userId: message.author.id, // Store the user ID
            guildId: message.guild.id // Store guild ID for multi-server
        };
        
        // Save to guild-specific storage
        const success = message.client.taskStorage.addTask(message.guild.id, newTask);
        
        if (success) {
            let replyMessage = `Added new task: "${taskTitle}"`;
            if (dueDate) {
                replyMessage += ` with due date: ${dueDate}`;
            }
            message.reply(replyMessage);
        } else {
            message.reply('Failed to save task to storage.');
        }
    }
};