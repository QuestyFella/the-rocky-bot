const { MessageFlags, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const board = require('../commands/board');
const { canRunInChannel, getCachedServerConfig } = require('./serverConfig');
const { buildMoreMenu, buildTaskPicker, buildTeamPicker, buildIssueComponents, buildAddModal, buildEditModal, buildTeamSetup, buildTeamSetupModal, buildImportModal, filterTasks } = require('./boardComponents');
const { sortBoardTasks, getIssueKey, normalizePriority, normalizeColumn, userCanManageIssue, claimError, releaseError, setTaskStatus, isManager } = require('./kanban');
const { getConfiguredTeams, saveTeams, validateTeam, listTaskTeams, setTaskTeam, preserveTaskTeam } = require('./teams');
const { readImportInput, prepareImport, getImportDraft, commitImport } = require('./taskImport');
const { buildImportPreview, buildImportErrors } = require('./importComponents');
const { prepareEdit, saveEdit } = require('./taskEditing');
const { groupTasksByTag } = require('./taskTags');
const { blockingError } = require('./taskDependencies');
const { prepareDeletion, getDeletionDraft, reviewDeletion, commitDeletion } = require('./taskDeletion');
const { buildDeletionTagPicker, buildDeletionPreview } = require('./deletionComponents');

function issuePayload(actor, task, content = '') {
    return {
        content,
        embeds: [board.buildIssueEmbed(task, 0, actor)],
        components: buildIssueComponents(task, actor),
        allowedMentions: { parse: [] }
    };
}

async function handleBoardInteraction(interaction) {
    if (!interaction.customId?.startsWith('kanban:') || !(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isModalSubmit())) return false;
    if (!interaction.inGuild()) {
        await interaction.reply({ content: 'Use this board in a server.', flags: MessageFlags.Ephemeral });
        return true;
    }
    const config = getCachedServerConfig(interaction.client, interaction.guildId);
    if (!canRunInChannel(config, interaction.channelId, 'board')) {
        await interaction.reply({ content: 'Task commands are disabled in this channel.', flags: MessageFlags.Ephemeral });
        return true;
    }
    if (interaction.member?.pending || interaction.client.pendingVerifications?.has(`${interaction.guildId}:${interaction.user.id}`)) {
        await interaction.reply({ content: 'Finish verification before using the board.', flags: MessageFlags.Ephemeral });
        return true;
    }

    const [, action, target, page, selectedTeamId] = interaction.customId.split(':');
    // Modal responses must be immediate. Discord supplies current permissions and
    // role IDs on the interaction; saving rechecks a freshly fetched member.
    const modalActor = {
        client: interaction.client, guild: interaction.guild, author: interaction.user, channelId: interaction.channelId,
        member: { permissions: interaction.memberPermissions || interaction.member?.permissions || { has: () => false }, roles: { cache: interaction.member?.roles?.cache || new Set(interaction.member?.roles || []) } }
    };
    if (action === 'edit' && interaction.isButton()) {
        const tasks = interaction.client.taskStorage.getAllTasks(interaction.guildId);
        const task = tasks.find(task => String(task.id) === target);
        let error;
        if (!task) error = 'This task no longer exists. Open Browse Tasks to choose another.';
        else if (!userCanManageIssue(modalActor, task)) error = 'You do not have permission to edit this task.';
        else if ((task.title || '').length > 4000 || (task.description || '').length > 4000) error = 'This task has text longer than the edit form supports. Use the text commands to edit it.';
        if (error) await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
        else {
            const draft = prepareEdit(modalActor, task);
            await interaction.showModal(buildEditModal(task, draft.id, tasks));
        }
        return true;
    }
    if (action === 'import' && interaction.isButton()) {
        if (!isManager(modalActor)) await interaction.reply({ content: 'You need Manage Server permission to import tasks. Use Add Task to create an individual task.', flags: MessageFlags.Ephemeral });
        else await interaction.showModal(buildImportModal());
        return true;
    }
    if (action === 'add' && interaction.isButton()) {
        await interaction.showModal(buildAddModal(getConfiguredTeams({ client: interaction.client, guild: interaction.guild })));
        return true;
    }
    if (action === 'teamsetup' && target === 'edit' && interaction.isButton()) {
        const permissions = interaction.memberPermissions || interaction.member?.permissions;
        if (!permissions || !(permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageGuild))) {
            await interaction.reply({ content: 'You need Manage Server permission to set up teams.', flags: MessageFlags.Ephemeral });
        } else await interaction.showModal(buildTeamSetupModal({ client: interaction.client, guild: interaction.guild }));
        return true;
    }

    // Acknowledge before fetching a member or touching the board over the network.
    if (!interaction.isModalSubmit() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
        await interaction.deferUpdate();
    } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (member.pending) {
        await interaction.editReply({ content: 'Finish server verification before using the board.', embeds: [], components: [] });
        return true;
    }
    const actor = { client: interaction.client, guild: interaction.guild, author: interaction.user, member, channelId: interaction.channelId };
    const replyError = content => interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });

    if (['importpreview', 'importpage', 'importconfirm'].includes(action) && !isManager(actor)) {
        await replyError('You need Manage Server permission to import tasks. Use Add Task to create an individual task.');
        return true;
    }

    if (action === 'more') {
        await interaction.editReply(buildMoreMenu(actor));
        return true;
    }

    if (['delete', 'deletetags', 'deletetag', 'deletepage', 'deleteconfirm', 'deletecancel'].includes(action)) {
        if (['deletetags', 'deletetag'].includes(action)) {
            if (!isManager(actor)) await replyError('You need Manage Server permission to delete tasks by tag.');
            else if (action === 'deletetags') await interaction.editReply(buildDeletionTagPicker(actor.client.taskStorage.getAllTasks(actor.guild.id), target));
            else {
                const result = prepareDeletion(actor, { tagId: interaction.values?.[0] });
                if (result.error) await replyError(result.error);
                else await interaction.editReply(buildDeletionPreview(result.draft, actor));
            }
        } else if (action === 'delete') {
            const result = prepareDeletion(actor, { taskId: target });
            if (result.error) await replyError(result.error);
            else await interaction.editReply(buildDeletionPreview(result.draft, actor));
        } else if (action === 'deletecancel') {
            const result = getDeletionDraft(actor, target);
            if (result.error) await replyError(result.error);
            else {
                actor.client.taskDeletes.delete(target);
                await interaction.editReply(buildMoreMenu(actor, 'Deletion cancelled. No tasks were deleted.'));
            }
        } else if (action === 'deletepage') {
            const result = reviewDeletion(actor, target);
            if (result.error) await replyError(result.error);
            else await interaction.editReply(buildDeletionPreview(result.draft, actor, page));
        } else {
            const result = commitDeletion(actor, target);
            if (result.error && result.draft) await interaction.editReply({ ...buildDeletionPreview(result.draft, actor), content: result.error });
            else if (result.error) await replyError(result.error);
            else await interaction.editReply(buildMoreMenu(actor, `Deleted **${result.deleted} task(s)**${result.tag ? ` from **${escapeMarkdown(result.tag.name)}**` : ''}.`));
        }
        return true;
    }

    if (action === 'editsave' && interaction.isModalSubmit()) {
        const { task, error } = saveEdit(actor, target, interaction.fields);
        if (task) await interaction.editReply(issuePayload(actor, task, error || 'Task details saved. Use the dropdowns below to change its status or team.'));
        else await replyError(error);
        return true;
    }

    if (action === 'importpreview' && interaction.isModalSubmit()) {
        let text;
        try {
            text = await readImportInput(interaction.fields.getTextInputValue('list'), [...(interaction.fields.getUploadedFiles('file')?.values() || [])]);
        } catch (error) {
            await interaction.editReply(buildImportErrors([error.message]));
            return true;
        }
        const result = prepareImport(actor, text);
        await interaction.editReply(result.errors ? buildImportErrors(result.errors) : buildImportPreview(result.draft, 0, true));
        return true;
    }

    if (['importpage', 'importconfirm', 'importcancel'].includes(action)) {
        const { draft, error } = getImportDraft(actor, target);
        if (error) {
            await replyError(error);
            return true;
        }
        if (action === 'importpage') await interaction.editReply(buildImportPreview(draft, page));
        else {
            let payload;
            if (action === 'importcancel') {
                actor.client.taskImports.delete(draft.id);
                payload = { content: 'Import cancelled. No tasks were added.', embeds: [], components: [], allowedMentions: { parse: [] } };
            } else {
                const result = commitImport(actor, draft);
                if (result.error) {
                    await interaction.editReply({ ...buildImportPreview(draft), content: result.error });
                    return true;
                }
                const keys = result.created.map(task => task.issueKey);
                payload = { content: `Imported **${keys.length} task(s)** into To Do, unassigned.${result.skipped ? ` Skipped ${result.skipped} duplicate(s).` : ''}${keys.length ? `\nIssue keys: ${keys[0]}${keys.length > 1 ? ` through ${keys.at(-1)}` : ''}.` : ''}`, embeds: [], components: [], allowedMentions: { parse: [] } };
            }
            // Text-command previews are public; clear their buttons after the owner finishes.
            if (!interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.message.edit(payload);
            await interaction.editReply(payload);
        }
        return true;
    }

    if (action === 'teamsetup') {
        if (!isManager(actor)) {
            await replyError('You need Manage Server permission to set up teams. Use Team Tasks to browse any group’s work.');
            return true;
        }
        if (target === 'clear' || (target === 'save' && interaction.isModalSubmit())) {
            const error = saveTeams(actor, target === 'clear' ? [] : interaction.fields.getTextInputValue('names').split(/\r?\n/));
            if (error) await replyError(error);
            else {
                await board.updateBoard(interaction.client, interaction.guildId);
                await interaction.editReply(buildTeamSetup(actor, target === 'clear' ? 'Team setup cleared. Existing task labels are kept.' : 'Teams saved. The Add Task form now includes your team choices.'));
            }
        } else await interaction.editReply(buildTeamSetup(actor));
        return true;
    }

    if (action === 'create' && interaction.isModalSubmit()) {
        const title = interaction.fields.getTextInputValue('title').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        const priorityInput = interaction.fields.getTextInputValue('priority').trim();
        const dueInput = interaction.fields.getTextInputValue('due').trim();
        const priority = priorityInput ? normalizePriority(priorityInput) : 'medium';
        const due = board.parseDueDate(dueInput);
        // Old forms submitted after a restart may have no team field.
        const teamValue = interaction.fields.fields?.has('team') ? interaction.fields.getStringSelectValues('team')?.[0] : null;
        const teamId = teamValue && teamValue !== 'none' ? teamValue : null;
        const teamError = validateTeam(actor, teamId);
        if (!title || title.length > 200 || description.length > 2000) {
            await replyError('Please give the task a title of 1–200 characters and a description of at most 2,000 characters.');
        } else if (!priority) {
            await replyError('Choose low, medium, high, or urgent for the priority.');
        } else if (dueInput && (!/^\d{4}-\d{2}-\d{2}$/.test(dueInput) || !due.ok)) {
            await replyError('Enter a real due date in YYYY-MM-DD format, or leave it blank.');
        } else if (teamError) {
            await replyError(teamError);
        } else {
            const task = board.createIssue(actor, { title, description, priority, dueDate: due.dueDate, status: 'todo', team: getConfiguredTeams(actor).find(team => team.id === teamId) });
            if (!interaction.client.taskStorage.addTask(interaction.guildId, task)) await replyError('Failed to save the task.');
            else await interaction.editReply(issuePayload(actor, task, `Created **${getIssueKey(task)}**. It is available for someone to claim.`));
        }
        return true;
    }

    if (['list', 'page', 'teamview', 'teamlist'].includes(action)) {
        const allTasks = interaction.client.taskStorage.getAllTasks(interaction.guildId);
        const filter = action === 'teamview' ? 'teams' : target === 'blocked' ? 'waiting' : ['ready', 'readyonly', 'waiting', 'available', 'mine', 'all', 'teams', 'tag'].includes(target) ? target : 'all';
        const teamId = action === 'teamview' ? interaction.values?.[0] : selectedTeamId;
        if (filter === 'tag' && !groupTasksByTag(allTasks).some(tag => tag.id === teamId)) {
            await interaction.editReply(buildMoreMenu(actor, 'This tag no longer has tasks. Use Browse Tasks to see the current list.'));
        } else if (action === 'teamlist' || (filter === 'teams' && !teamId)) {
            await interaction.editReply(buildTeamPicker(allTasks, actor, action === 'teamlist' ? target : 0));
        } else if (filter === 'teams' && !listTaskTeams(allTasks, actor).some(team => team.id === teamId)) {
            await interaction.editReply(buildTeamPicker(allTasks, actor));
        } else {
            const tasks = sortBoardTasks(filterTasks(allTasks, filter, actor, teamId));
            await interaction.editReply(buildTaskPicker(tasks, filter, action === 'teamview' ? 0 : page, actor, teamId));
        }
        return true;
    }

    if (action === 'refresh') {
        if (!isManager(actor)) {
            await replyError('You need Manage Server permission to refresh the live board. Task changes refresh it automatically.');
            return true;
        }
        await board.updateBoard(interaction.client, interaction.guildId, { force: true });
        await interaction.editReply(buildMoreMenu(actor, 'Board refreshed.'));
        return true;
    }

    const id = action === 'select' ? interaction.values?.[0] : target;
    // Look up stable storage IDs only; a deleted task must never resolve to a new board position.
    const tasks = interaction.client.taskStorage.getAllTasks(interaction.guildId);
    const task = tasks.find(item => String(item.id) === id);
    if (!task) {
        await replyError('This task no longer exists. Open Browse Tasks to choose another.');
        return true;
    }

    let error = null;
    let content = '';
    if (action === 'claim' || action === 'start') {
        error = claimError(actor, task);
        if (!error && action === 'start') error = blockingError(task, tasks);
        if (!error) {
            preserveTaskTeam(task, actor);
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
            preserveTaskTeam(task, actor);
            task.userId = null;
            task.assignedToRole = null;
            task.assignedBy = null;
            setTaskStatus(task, 'todo');
            content = 'Released back to To Do for someone else to claim.';
        }
    } else if (action === 'team') {
        const teamId = interaction.values?.[0];
        if (!userCanManageIssue(actor, task)) error = 'You do not have permission to change this task’s team.';
        else if (!teamId) error = 'Choose a team or No team.';
        else {
            const selected = teamId === 'none' ? null : teamId;
            error = validateTeam(actor, selected);
            if (!error) {
                setTaskTeam(task, getConfiguredTeams(actor).find(team => team.id === selected));
                task.updatedAt = new Date().toISOString();
                content = selected ? 'Team tag updated.' : 'Team tag cleared.';
            }
        }
    } else if (action === 'status') {
        const status = normalizeColumn(interaction.values?.[0]);
        if (!userCanManageIssue(actor, task)) error = 'You do not have permission to change this task.';
        else if (!status) error = 'Choose a valid task status.';
        else if (status !== 'todo' && blockingError(task, tasks)) error = blockingError(task, tasks);
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
