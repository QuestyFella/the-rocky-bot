const { MessageFlags } = require('discord.js');
const board = require('../commands/board');
const { canRunInChannel, getCachedServerConfig } = require('./serverConfig');
const { buildBoardComponents, buildTaskPicker, buildIssueComponents, buildAddModal, filterTasks } = require('./boardComponents');
const { sortBoardTasks, getIssueKey, normalizePriority, normalizeColumn, userCanManageIssue, claimError, releaseError, setTaskStatus } = require('./kanban');

function issuePayload(actor, task, content = '') {
    return {
        content,
        embeds: [board.buildIssueEmbed(task, 0)],
        components: buildIssueComponents(task, actor),
        allowedMentions: { parse: [] }
    };
}

async function handleBoardInteraction(interaction) {
    if (!interaction.customId?.startsWith('kanban:') || !(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return false;
    if (!interaction.inGuild()) {
        await interaction.reply({ content: 'Use this board in a server.', flags: MessageFlags.Ephemeral });
        return true;
    }
    const config = getCachedServerConfig(interaction.client, interaction.guildId);
    if (!canRunInChannel(config, interaction.channelId, 'board')) {
        await interaction.reply({ content: 'Task commands are disabled in this channel.', flags: MessageFlags.Ephemeral });
        return true;
    }
    if (interaction.client.pendingVerifications?.has(`${interaction.guildId}:${interaction.user.id}`)) {
        await interaction.reply({ content: 'Finish verification before using the board.', flags: MessageFlags.Ephemeral });
        return true;
    }

    const [, action, target, page] = interaction.customId.split(':');
    if (action === 'add' && interaction.isButton()) {
        await interaction.showModal(buildAddModal());
        return true;
    }

    // Acknowledge before fetching a member or touching the board over the network.
    if (!interaction.isModalSubmit() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
        await interaction.deferUpdate();
    } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (member.pending) {
        await interaction.editReply({ content: 'Finish server verification before using the board.', embeds: [], components: [] });
        return true;
    }
    const actor = { client: interaction.client, guild: interaction.guild, author: interaction.user, member };
    const replyError = content => interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });

    if (action === 'create' && interaction.isModalSubmit()) {
        const title = interaction.fields.getTextInputValue('title').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        const priorityInput = interaction.fields.getTextInputValue('priority').trim();
        const dueInput = interaction.fields.getTextInputValue('due').trim();
        const priority = priorityInput ? normalizePriority(priorityInput) : 'medium';
        const due = board.parseDueDate(dueInput);
        if (!title || title.length > 200 || description.length > 2000) {
            await replyError('Please give the task a title of 1–200 characters and a description of at most 2,000 characters.');
        } else if (!priority) {
            await replyError('Choose low, medium, high, or urgent for the priority.');
        } else if (dueInput && (!/^\d{4}-\d{2}-\d{2}$/.test(dueInput) || !due.ok)) {
            await replyError('Enter a real due date in YYYY-MM-DD format, or leave it blank.');
        } else {
            const task = board.createIssue(actor, { title, description, priority, dueDate: due.dueDate, status: 'todo' });
            if (!interaction.client.taskStorage.addTask(interaction.guildId, task)) await replyError('Failed to save the task.');
            else await interaction.editReply(issuePayload(actor, task, `Created **${getIssueKey(task)}**. It is available for someone to claim.`));
        }
        return true;
    }

    if (action === 'list') {
        const filter = ['available', 'mine', 'all'].includes(target) ? target : 'all';
        const tasks = sortBoardTasks(filterTasks(interaction.client.taskStorage.getAllTasks(interaction.guildId), filter, actor));
        await interaction.editReply(buildTaskPicker(tasks, filter, page));
        return true;
    }

    if (action === 'refresh') {
        await board.updateBoard(interaction.client, interaction.guildId);
        await interaction.message.edit({ embeds: [board.generateBoardEmbed(interaction.client, interaction.guildId)], components: buildBoardComponents(), allowedMentions: { parse: [] } });
        await interaction.editReply({ content: 'Board refreshed.', embeds: [], components: [] });
        return true;
    }

    const id = action === 'select' ? interaction.values?.[0] : target;
    // Look up stable storage IDs only; a deleted task must never resolve to a new board position.
    const task = interaction.client.taskStorage.getAllTasks(interaction.guildId).find(item => String(item.id) === id);
    if (!task) {
        await replyError('This task no longer exists. Open Browse Tasks to choose another.');
        return true;
    }

    let error = null;
    let content = '';
    if (action === 'claim' || action === 'start') {
        error = claimError(actor, task);
        if (!error) {
            task.userId = interaction.user.id;
            task.assignedToRole = null;
            task.assignedBy = interaction.user.id;
            task.updatedAt = new Date().toISOString();
            if (action === 'start') setTaskStatus(task, 'progress');
            content = action === 'start' ? 'Assigned to you and moved to In Progress.' : 'Assigned to you.';
        }
    } else if (action === 'release') {
        error = releaseError(actor, task);
        if (!error) {
            task.userId = null;
            task.assignedToRole = null;
            task.assignedBy = null;
            setTaskStatus(task, 'todo');
            content = 'Released back to To Do for someone else to claim.';
        }
    } else if (action === 'status') {
        const status = normalizeColumn(interaction.values?.[0]);
        if (!userCanManageIssue(actor, task)) error = 'You do not have permission to change this task.';
        else if (!status) error = 'Choose a valid task status.';
        else {
            setTaskStatus(task, status);
            content = 'Task status updated.';
        }
    } else if (!['select', 'details'].includes(action)) {
        await replyError('Unknown board action. Refresh the board and try again.');
        return true;
    }

    // No awaits between reading the task, checking ownership, and saving it.
    // Concurrent claims see the preceding claim instead of overwriting it.
    if (!error && content && !interaction.client.taskStorage.updateTask(interaction.guildId, task.id, task)) error = 'Failed to save the task.';
    if (error) await replyError(error);
    else await interaction.editReply(issuePayload(actor, task, content));
    return true;
}

module.exports = { handleBoardInteraction };
