const { MessageFlags } = require('discord.js');
const board = require('../commands/board');
const { canRunInChannel, getCachedServerConfig } = require('./serverConfig');
const { buildBoardComponents, buildTaskPicker, buildTaskView, buildDeleteConfirm, buildTaskModal } = require('./boardComponents');
const { getIssueKey, parseDueDate, canChange } = require('./kanban');
const { getImportDraft, commitImport } = require('./taskImport');

const cannotChange = 'Only the person working on this task, its creator, or a manager can change it.';
const taskActions = new Set(['select', 'view', 'delete', 'deleteconfirm', 'editsave', ...Object.keys(board.taskCommands)]);

function readTaskForm(fields) {
    const title = fields.getTextInputValue('title').trim();
    const description = fields.getTextInputValue('description').trim();
    const due = parseDueDate(fields.getTextInputValue('due'));
    if (!title || title.length > 200) return { error: 'Give the task a title of 1–200 characters.' };
    if (description.length > 2000) return { error: 'Keep the description to 2,000 characters.' };
    if (!due.ok) return { error: 'Use a due date like 2026-12-01, or leave it blank.' };
    return { title, description, dueDate: due.dueDate };
}

async function handleBoardInteraction(interaction) {
    if (!interaction.customId?.startsWith('kanban:') || !(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return false;
    const ephemeral = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!interaction.inGuild()) {
        await ephemeral('Use the task board in a server.');
        return true;
    }
    if (!canRunInChannel(getCachedServerConfig(interaction.client, interaction.guildId), interaction.channelId, 'board')) {
        await ephemeral('Task commands are disabled in this channel.');
        return true;
    }
    if (interaction.member?.pending || interaction.client.pendingVerifications?.has(`${interaction.guildId}:${interaction.user.id}`)) {
        await ephemeral('Finish verification before using the board.');
        return true;
    }

    let [, action, target] = interaction.customId.split(':');
    // Buttons on messages from older versions of the bot.
    if (action === 'list' || action === 'page') action = target === 'mine' ? 'mine' : 'find', target = '0';
    if (action === 'details') action = 'view';

    const storage = interaction.client.taskStorage;
    const actor = { client: interaction.client, guild: interaction.guild, author: interaction.user, member: { permissions: interaction.memberPermissions || interaction.member?.permissions } };
    const taskId = action === 'select' ? interaction.values?.[0] : target;
    const task = storage.getAllTasks(interaction.guildId).find(item => String(item.id) === taskId);

    // Modals must be shown as the very first response.
    if (action === 'add' && interaction.isButton()) {
        await interaction.showModal(buildTaskModal());
        return true;
    }
    if (action === 'edit' && interaction.isButton()) {
        if (!task) await ephemeral('This task no longer exists.');
        else if (!canChange(actor, task)) await ephemeral(cannotChange);
        else if ((task.title || '').length > 4000 || (task.description || '').length > 4000) await ephemeral('This task is too long for the edit form. Use `!task edit KEY New title`.');
        else await interaction.showModal(buildTaskModal(task));
        return true;
    }

    // The import preview is a public message: only its author may change it.
    if (action === 'importconfirm' || action === 'importcancel') {
        const { draft, error } = getImportDraft(actor, target);
        if (error) {
            await ephemeral(error);
            return true;
        }
        await interaction.deferUpdate();
        let content = 'Import cancelled. Nothing was added.';
        if (action === 'importconfirm') {
            const result = commitImport(actor, draft);
            content = result.error || `Imported **${result.created.length} task(s)** into To Do.${result.skipped ? ` Skipped ${result.skipped} duplicate title(s).` : ''}`;
        } else interaction.client.taskImports.delete(draft.id);
        await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
        return true;
    }

    // Clicks inside a private view update it; clicks on the shared board open a private reply.
    if (!interaction.isModalSubmit() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = payload => interaction.editReply({ embeds: [], components: [], allowedMentions: { parse: [] }, ...payload });

    if (action === 'find' || action === 'mine') {
        await reply(buildTaskPicker(storage.getAllTasks(interaction.guildId), action, target, actor));
        return true;
    }

    if (action === 'create' && interaction.isModalSubmit()) {
        const form = readTaskForm(interaction.fields);
        const created = !form.error && board.createIssue(actor, form);
        if (form.error) await reply({ content: form.error });
        else if (!storage.addTask(interaction.guildId, created)) await reply({ content: 'Failed to save the task.' });
        else await reply(buildTaskView(created, actor, `Created **${getIssueKey(created)}**. Anyone can claim it from **Find Work**.`));
        return true;
    }

    if (!taskActions.has(action)) {
        await reply({ content: 'This button is out of date. Run `!task` to open the current board.' });
        return true;
    }
    if (!task) {
        await reply({ content: 'This task no longer exists. Click **Find Work** to see current tasks.' });
        return true;
    }

    if (action === 'select' || action === 'view') {
        await reply(buildTaskView(task, actor));
        return true;
    }

    if (action === 'delete' || action === 'deleteconfirm') {
        if (!canChange(actor, task)) await reply({ content: cannotChange });
        else if (action === 'delete') await reply(buildDeleteConfirm(task));
        else if (!storage.deleteTask(interaction.guildId, task.id)) await reply({ content: 'Failed to delete the task.' });
        else await reply({ content: `Deleted ${getIssueKey(task)}.`, components: buildBoardComponents() });
        return true;
    }

    let content;
    if (action === 'editsave' && interaction.isModalSubmit()) {
        const form = readTaskForm(interaction.fields);
        if (form.error) content = form.error;
        else if (!canChange(actor, task)) content = cannotChange;
        else {
            Object.assign(task, form, { updatedAt: new Date().toISOString() });
            content = storage.updateTask(interaction.guildId, task.id, task) ? 'Saved.' : 'Failed to save the task.';
        }
    } else {
        // No awaits between reading, checking, and saving, so two quick claims cannot both win.
        const { check, apply } = board.taskCommands[action];
        content = check(actor, task);
        if (!content) {
            content = apply(actor, task);
            if (!storage.updateTask(interaction.guildId, task.id, task)) content = 'Failed to save the task.';
        }
    }
    await reply(buildTaskView(storage.getAllTasks(interaction.guildId).find(item => item.id === task.id) || task, actor, content));
    return true;
}

module.exports = { handleBoardInteraction };
