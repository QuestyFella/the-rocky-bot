const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');

const noticeboardsFile = './noticeboards.json';

function loadNoticeboards() {
    if (!fs.existsSync(noticeboardsFile)) {
        return {};
    }
    return JSON.parse(fs.readFileSync(noticeboardsFile, 'utf8'));
}

function saveNoticeboards(data) {
    fs.writeFileSync(noticeboardsFile, JSON.stringify(data, null, 2));
}

async function generateNoticeboardEmbed(client, guildId) {
    const allTasks = client.taskStorage.getAllTasks(guildId);
    // Filter for active (not completed) tasks that are assigned to someone/role
    const activeTasks = allTasks.filter(task => !task.completed && (task.userId || task.assignedToRole));

    if (activeTasks.length === 0) {
        return new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('📋 Server Noticeboard')
            .setDescription('No active tasks assigned at the moment.')
            .setTimestamp();
    }

    // Sort by due date (tasks with due dates first, then by creation? or just due date)
    activeTasks.sort((a, b) => {
        if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
        if (a.dueDate) return -1; // a comes first
        return 1; // b comes first
    });

    const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle('📋 Server Noticeboard')
        .setDescription('Current active tasks and assignments.')
        .setTimestamp();

    // Grouping or just defined list? Let's do a list for now as per request
    // "who or what role they are assigned to and when the task is due, also if the task is overdue or not"
    
    // Discord field limit is 25, so we might need to truncate if too many tasks.
    // For now, let's assume reasonable usage.
    
    // We can put multiple tasks in one field or one field per task. One field per task is cleaner but limits to 25.
    // Let's try to combine them into a single description or a few fields if possible, 
    // but the request asks for "embedded message that contains all the tasks". 
    // A single description field can hold 4096 chars.
    
    let descriptionText = '';

    for (const task of activeTasks) {
        let assignee = 'Unknown';
        if (task.userId) {
            assignee = `<@${task.userId}>`;
        } else if (task.assignedToRole) {
            assignee = `<@&${task.assignedToRole}>`;
        }

        let dueStatus = 'No due date';
        let isOverdue = false;

        if (task.dueDate) {
            const dueDate = new Date(task.dueDate); // Assuming tasks have ISO date or similar parseable
            // If task.dueDate is a string like "2023-10-27", Date.parse works.
            // If it's a timestamp, new Date works.
            // Let's rely on standard JS Date parsing which handles many formats.
            // Actually, existing bot seems to use free text for dates? 
            // In `duedate.js`, it doesn't seem to enforce format/parsing. 
            // Wait, previous code `new.js` uses `chrono-node` or similar? 
            // Ah, I don't see chrono-node in package.json.
            // Let's check `duedate.js` content if I could... 
            // But for now, let's assume it attempts to be a date string.
            
            // To make "time till due" work, we really need a valid date object.
            // I'll assume standard date strings for now.
            // If standard string:
            const now = new Date();
            const dueTime = new Date(task.dueDate).getTime(); // Try to parse
            
            if (!isNaN(dueTime)) {
                 // Discord Timestamp format: <t:TIMESTAMP:R> (Relative)
                 dueStatus = `<t:${Math.floor(dueTime / 1000)}:R>`;
                 if (now.getTime() > dueTime) {
                     isOverdue = true;
                 }
            } else {
                dueStatus = task.dueDate; // Fallback to raw string
            }
        }

        const icon = isOverdue ? 'CRITICAL: 🔴 OVERDUE' : '📅';
        
        descriptionText += `**${task.title}** (ID: ${task.id})\n`;
        descriptionText += `👤 Assigned to: ${assignee}\n`;
        descriptionText += `${icon} Due: ${dueStatus}\n`;
        descriptionText += `\n`;
    }

    if (descriptionText.length > 4000) {
        descriptionText = descriptionText.substring(0, 3997) + '...';
    }
    
    embed.setDescription(descriptionText || 'No active tasks found.');

    return embed;
}

module.exports = {
    name: 'notice',
    description: 'Manage the task noticeboard',
    async execute(message, args) {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return message.reply('You need Manage Guild permissions to use this command.');
        }

        const subcommand = args[0] ? args[0].toLowerCase() : null;

        if (subcommand === 'generate') {
            const embed = await generateNoticeboardEmbed(message.client, message.guild.id);
            const sentMessage = await message.channel.send({ embeds: [embed] });

            // Save this message as the active noticeboard for this guild
            const noticeboards = loadNoticeboards();
            noticeboards[message.guild.id] = {
                channelId: message.channel.id,
                messageId: sentMessage.id
            };
            saveNoticeboards(noticeboards);
            
            // Delete the command message to keep it clean? Optional.
            // message.delete().catch(() => {});

        } else {
            message.reply('Usage: `!notice generate` - Creates a self-updating noticeboard.');
        }
    },
    // Export function for the bot to use in scheduler
    updateNoticeboard: async (client, guildId) => {
        const noticeboards = loadNoticeboards();
        const config = noticeboards[guildId];

        if (!config) return;

        try {
            const channel = await client.channels.fetch(config.channelId);
            if (!channel) return;

            const message = await channel.messages.fetch(config.messageId);
            if (!message) return;

            const newEmbed = await generateNoticeboardEmbed(client, guildId);
            
            // Only edit if content changed? 
            // Actually, relative timestamps <t:x:R> update client-side, 
            // BUT "OVERDUE" status calc is server-side.
            // Also adds/removes/edits need to be reflected.
            
            await message.edit({ embeds: [newEmbed] });
            
        } catch (error) {
            console.error(`Failed to update noticeboard for guild ${guildId}:`, error);
            // If message not found (deleted), maybe remove from config?
            // For now, just log.
        }
    }
};
