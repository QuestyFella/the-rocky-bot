const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, FileUploadBuilder, EmbedBuilder, escapeMarkdown
} = require('discord.js');
const { columns, priorities, getTaskStatus, getTaskPriority, getIssueKey, claimError, releaseError, userCanManageIssue, isManager } = require('./kanban');
const { getConfiguredTeams, getTaskTeam, listTaskTeams, maxTeams, maxTeamNameLength } = require('./teams');
const { getTaskTag } = require('./taskTags');
const { isBlocked, canViewTask, blockingSummary, dependencyInput } = require('./taskDependencies');

const pageSize = 10;
const teamPageSize = 25;
const short = (text, length) => String(text || '').slice(0, length);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function buildBoardComponents(tagId = null) {
    if (tagId) return [new ActionRowBuilder().addComponents(
        button(`kanban:list:tag:0:${tagId}`, 'Open Tasks', ButtonStyle.Primary),
        button('kanban:add', 'Add Task'),
        button('kanban:list:mine:0', 'My Tasks'),
        button('kanban:list:teams:0', 'Team Tasks'),
        button('kanban:more', 'More')
    )];
    return [new ActionRowBuilder().addComponents(
        button('kanban:add', 'Add Task', ButtonStyle.Primary),
        button('kanban:list:available:0', 'Available Tasks', ButtonStyle.Success),
        button('kanban:list:mine:0', 'My Tasks'),
        button('kanban:list:teams:0', 'Team Tasks'),
        button('kanban:more', 'More')
    )];
}

function buildMoreMenu(actor, content = '') {
    const controls = [button('kanban:list:all:0', 'Browse Tasks')];
    if (isManager(actor)) controls.push(button('kanban:import', 'Import Tasks'), button('kanban:teamsetup', 'Setup Teams'), button('kanban:refresh', 'Refresh Board'));
    controls.push(button('kanban:add', 'Add Task', ButtonStyle.Primary));
    return {
        content: `${content ? `${content}\n\n` : ''}**More task controls**\nBrowse ${isManager(actor) ? 'all' : 'unlocked'} tasks, including completed work.${isManager(actor) ? '\nManager controls: view blocked tasks, import a task list, set up team labels, or refresh the live board.' : ''}`,
        embeds: [], components: [new ActionRowBuilder().addComponents(controls), ...(isManager(actor) ? [new ActionRowBuilder().addComponents(button('kanban:list:blocked:0', 'Blocked Tasks'))] : [])], allowedMentions: { parse: [] }
    };
}

function filterTasks(tasks, filter, actor, teamId = null) {
    return tasks.filter(task => {
        if (!canViewTask(task, tasks, actor)) return false;
        if (filter === 'blocked') return Boolean(actor?.member && isManager(actor)) && isBlocked(task, tasks);
        if (filter === 'mine') return task.userId === actor.author.id && getTaskStatus(task) !== 'done';
        if (filter === 'available') return !task.userId && !claimError(actor, task, tasks);
        if (filter === 'teams') return getTaskStatus(task) !== 'done' && Boolean(getTaskTeam(task, actor)) && (!teamId || getTaskTeam(task, actor).id === teamId);
        if (filter === 'tag') return !isBlocked(task, tasks) && getTaskTag(task).id === teamId;
        return true;
    });
}

function buildTaskPicker(tasks, filter, requestedPage = 0, actor = null, teamId = null) {
    const allTasks = actor?.client?.taskStorage?.getAllTasks(actor.guild.id) || tasks;
    const pageCount = Math.max(1, Math.ceil(tasks.length / pageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
    const visible = tasks.slice(page * pageSize, (page + 1) * pageSize);
    const team = listTaskTeams(tasks, actor).find(team => team.id === teamId);
    const tag = tasks.length ? getTaskTag(tasks[0]) : null;
    const labels = { available: 'Available Tasks', mine: 'My Tasks', all: 'All Tasks', blocked: 'Blocked Tasks', teams: team ? `Team Tasks: ${escapeMarkdown(team.name)}` : 'Team Tasks', tag: tag ? `Tasks: ${escapeMarkdown(tag.name)}` : 'Tag Tasks' };
    const components = [];
    if (visible.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId('kanban:select')
            .setPlaceholder('Choose a task to view or update it')
            .addOptions(visible.map(task => ({
                label: short(`${getIssueKey(task) || task.id}: ${task.title}`, 100),
                value: String(task.id),
                description: short(`${isBlocked(task, allTasks) ? 'Blocked · ' : ''}${getTaskTeam(task, actor) ? `${getTaskTeam(task, actor).name} · ` : ''}${columns.find(c => c.id === getTaskStatus(task)).name} · ${priorities[getTaskPriority(task)].label} priority · ${task.userId ? 'Assigned' : 'Available'}`, 100)
            })));
        components.push(new ActionRowBuilder().addComponents(select));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            button(`kanban:page:${filter}:${page - 1}${teamId ? `:${teamId}` : ''}`, 'Previous').setDisabled(page === 0),
            button(`kanban:page:${filter}:${page + 1}${teamId ? `:${teamId}` : ''}`, 'Next').setDisabled(page === pageCount - 1)
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        button('kanban:list:available:0', 'Available Tasks'),
        button('kanban:list:mine:0', 'My Tasks'),
        button('kanban:list:teams:0', 'Team Tasks'),
        button('kanban:list:all:0', 'Browse Tasks'),
        button('kanban:add', 'Add Task', ButtonStyle.Primary)
    ));
    components.push(new ActionRowBuilder().addComponents(button('kanban:more', 'More')));
    const embeds = [];
    if (visible.length) {
        const embed = new EmbedBuilder().setColor(0x0052cc);
        for (const task of visible) embed.addFields({
            name: `${short(getIssueKey(task) || task.id, 40)}: ${short(task.title, 200)}`,
            value: `**Team:** ${escapeMarkdown(getTaskTeam(task, actor)?.name || 'No team')} · **Priority:** ${priorities[getTaskPriority(task)].label}\n**Status:** ${columns.find(column => column.id === getTaskStatus(task)).name} · **Due:** ${task.dueDate || 'None'}${isBlocked(task, allTasks) ? `\n🔒 **Blocked by:** ${blockingSummary(task, allTasks, 500)}` : ''}`
        });
        embeds.push(embed);
    }
    return {
        content: `**${labels[filter] || labels.all}** — ${tasks.length} task(s)${pageCount > 1 ? ` · Page ${page + 1}/${pageCount}` : ''}\n${visible.length ? 'Full task titles are listed below. Choose a task to read its description or update it.' : filter === 'teams' ? 'No active tasks for this team.' : 'No tasks here yet.'}`,
        embeds, components, allowedMentions: { parse: [] }
    };
}

function buildTeamPicker(tasks, actor, requestedPage = 0) {
    const teams = listTaskTeams(tasks, actor);
    const pageCount = Math.max(1, Math.ceil(teams.length / teamPageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
    const components = [];
    if (teams.length) components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('kanban:teamview').setPlaceholder('Choose the team you want to see')
        .addOptions(teams.slice(page * teamPageSize, (page + 1) * teamPageSize).map(team => ({
            label: short(team.name, 100), value: team.id,
            description: `${filterTasks(tasks, 'teams', actor, team.id).length} active task(s)`
        })))));
    if (pageCount > 1) components.push(new ActionRowBuilder().addComponents(
        button(`kanban:teamlist:${page - 1}`, 'Previous').setDisabled(page === 0),
        button(`kanban:teamlist:${page + 1}`, 'Next').setDisabled(page === pageCount - 1)
    ));
    components.push(new ActionRowBuilder().addComponents(
        button('kanban:list:all:0', 'Browse Tasks'), button('kanban:add', 'Add Task', ButtonStyle.Primary),
        button('kanban:more', 'More')
    ));
    return {
        content: `**Team Tasks**${pageCount > 1 ? ` · Page ${page + 1}/${pageCount}` : ''}\n${teams.length ? 'Choose a group to see its active tasks. Anyone can view any team.' : 'No teams yet. A server manager can use Setup Teams to enter team names.'}`,
        embeds: [], components, allowedMentions: { parse: [] }
    };
}

function buildIssueComponents(task, actor) {
    const id = String(task.id);
    const tasks = actor.client?.taskStorage?.getAllTasks(actor.guild.id) || [task];
    const blocked = isBlocked(task, tasks);
    if (!canViewTask(task, tasks, actor)) return [new ActionRowBuilder().addComponents(button('kanban:list:available:0', 'Available Tasks'))];
    const controls = [];
    if (!claimError(actor, task)) {
        if (!task.userId) controls.push(button(`kanban:claim:${id}`, 'Claim', ButtonStyle.Success));
        if (getTaskStatus(task) !== 'progress') controls.push(button(`kanban:start:${id}`, 'Start Work', ButtonStyle.Primary));
    }
    if (task.userId && !releaseError(actor, task)) controls.push(button(`kanban:release:${id}`, 'Release'));
    if (userCanManageIssue(actor, task)) controls.push(button(`kanban:edit:${id}`, 'Edit Task', ButtonStyle.Primary));
    controls.push(button(`kanban:details:${id}`, 'Refresh'), button('kanban:list:mine:0', 'My Tasks'));
    const components = [new ActionRowBuilder().addComponents(controls)];
    if (userCanManageIssue(actor, task)) {
        components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`kanban:status:${id}`)
            .setPlaceholder(blocked ? 'Blocked task: return to To Do' : 'Change task status')
            .addOptions(columns.filter(column => !blocked || column.id === 'todo').map(column => ({ label: column.name, value: column.id, emoji: column.icon, default: column.id === getTaskStatus(task) })))));
        const teams = getConfiguredTeams(actor);
        if (teams.length || getTaskTeam(task, actor)) {
            const teamId = getTaskTeam(task, actor)?.id;
            components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
                .setCustomId(`kanban:team:${id}`)
                .setPlaceholder('Change team tag')
                .addOptions([
                    { label: 'No team', value: 'none', default: !teamId },
                    ...teams.map(team => ({ label: short(team.name, 100), value: team.id, default: team.id === teamId }))
                ])));
        }
    }
    return components;
}

function buildAddModal(teams = []) {
    const fields = [
        ['title', 'Task title (optional [TAG] prefix)', TextInputStyle.Short, true, 200, '[POWER] Check the battery pack'],
        ['description', 'Description', TextInputStyle.Paragraph, false, 2000, 'Add context, links, or acceptance criteria'],
        ['priority', 'Priority (low, medium, high, urgent)', TextInputStyle.Short, false, 20, 'medium'],
        ['due', 'Due date (YYYY-MM-DD)', TextInputStyle.Short, false, 10, '2026-12-01']
    ];
    const modal = new ModalBuilder().setCustomId('kanban:create').setTitle('Add an available task').addLabelComponents(fields.map(([id, label, style, required, maxLength, placeholder]) =>
        new LabelBuilder().setLabel(label).setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(maxLength).setPlaceholder(placeholder))
    ));
    if (teams.length) {
        modal.addLabelComponents(new LabelBuilder().setLabel('Team').setDescription('Who is this task for?').setStringSelectMenuComponent(new StringSelectMenuBuilder()
            .setCustomId('team').setRequired(false).setPlaceholder('Choose a team (optional)')
            // This SDK version validates modal option labels at 45 characters.
            // Keep longer team names visible in the option's description.
            .addOptions([{ label: 'No team', value: 'none', default: true }, ...teams.map(team => ({ label: short(team.name, 45), value: team.id, ...(team.name.length > 45 ? { description: team.name } : {}) }))])));
    }
    return modal;
}

function buildEditModal(task, draftId, tasks = []) {
    const fields = [
        ['title', 'Task title', TextInputStyle.Short, true, task.title || '', 200],
        ['description', 'Description', TextInputStyle.Paragraph, false, task.description || '', 2000],
        ['priority', 'Priority (low, medium, high, urgent)', TextInputStyle.Short, false, getTaskPriority(task), 20],
        ['due', 'Due date (YYYY-MM-DD; blank clears)', TextInputStyle.Short, false, task.dueDate || '', 10],
        ['dependencies', 'Blocked by (task keys or [TAG]; blank clears)', TextInputStyle.Short, false, dependencyInput(task, tasks), 2000]
    ];
    return new ModalBuilder().setCustomId(`kanban:editsave:${draftId}`).setTitle('Edit task details')
        .addLabelComponents(fields.map(([id, label, style, required, value, maxLength]) => {
            const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(Math.max(maxLength, value.length));
            if (value) input.setValue(value);
            const field = new LabelBuilder().setLabel(label).setTextInputComponent(input);
            if (id === 'dependencies') { input.setPlaceholder('URC-12, [POWER], [GROUND STATION]'); field.setDescription('Wait for each task and every task in each tag. Blocked tasks are visible only to managers.'); }
            return field;
        }));
}

function buildTeamSetup(actor, content = '') {
    const teams = getConfiguredTeams(actor);
    const summary = teams.map(team => escapeMarkdown(team.name)).join(', ');
    return {
        content: `${content ? `${content}\n\n` : ''}**Setup Teams**\nClick **Edit Teams** and enter one group name per line (up to ${maxTeams}). Teams are labels that tell people who the task is meant for. Anyone can browse them using **Team Tasks**.\nCurrent teams: ${teams.length ? `${short(summary, 1200)}${summary.length > 1200 ? '…' : ''}` : 'None yet.'}\nExisting task labels are kept when you change this setup.`,
        embeds: [],
        components: [new ActionRowBuilder().addComponents(
            button('kanban:teamsetup:edit', 'Edit Teams', ButtonStyle.Primary),
            button('kanban:teamsetup:clear', 'Clear Team Setup'),
            button('kanban:list:teams:0', 'Team Tasks'),
            button('kanban:add', 'Add Task', ButtonStyle.Primary)
        )],
        allowedMentions: { parse: [] }
    };
}

function buildTeamSetupModal(actor) {
    const names = getConfiguredTeams(actor).map(team => team.name.slice(0, maxTeamNameLength)).join('\n');
    const input = new TextInputBuilder().setCustomId('names').setStyle(TextInputStyle.Paragraph)
        .setRequired(false).setMaxLength(maxTeams * (maxTeamNameLength + 1))
        .setPlaceholder('Avionics\nSoftware\nMechanical');
    if (names) input.setValue(names);
    return new ModalBuilder().setCustomId('kanban:teamsetup:save').setTitle('Set up team labels')
        .addLabelComponents(new LabelBuilder().setLabel('Team names (one per line)').setTextInputComponent(input));
}

function buildImportModal() {
    return new ModalBuilder().setCustomId('kanban:importpreview').setTitle('Import a task list').addLabelComponents(
        new LabelBuilder().setLabel('Paste a short list').setDescription('Use Title, Description, Priority, Due date, and Team fields.')
            .setTextInputComponent(new TextInputBuilder().setCustomId('list').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000)
                .setPlaceholder('Title: Build payload\nDescription:\nPriority: high\nDue date: 2026-10-20\nTeam: Cubesat')),
        new LabelBuilder().setLabel('Or upload the full list').setDescription('A UTF-8 .txt or .md file, up to 256 KiB and 250 tasks. You will review a preview first.')
            .setFileUploadComponent(new FileUploadBuilder().setCustomId('file').setRequired(false).setMinValues(0).setMaxValues(1))
    );
}

module.exports = { buildBoardComponents, buildMoreMenu, buildTaskPicker, buildTeamPicker, buildIssueComponents, buildAddModal, buildEditModal, buildTeamSetup, buildTeamSetupModal, buildImportModal, filterTasks, pageSize };
