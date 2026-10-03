const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, escapeMarkdown
} = require('discord.js');
const { columns, priorities, getTaskStatus, getTaskPriority, getIssueKey, claimError, releaseError, userCanManageIssue } = require('./kanban');
const { getConfiguredTeams, getTaskTeam, listTaskTeams, maxTeams, maxTeamNameLength } = require('./teams');

const pageSize = 25;
const short = (text, length) => String(text || '').slice(0, length);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function buildBoardComponents() {
    return [new ActionRowBuilder().addComponents(
        button('kanban:add', 'Add Task', ButtonStyle.Primary),
        button('kanban:list:available:0', 'Available Tasks', ButtonStyle.Success),
        button('kanban:list:mine:0', 'My Tasks'),
        button('kanban:list:all:0', 'Browse Tasks'),
        button('kanban:refresh', 'Refresh')
    ), new ActionRowBuilder().addComponents(
        button('kanban:list:teams:0', 'Team Tasks'),
        button('kanban:teamsetup', 'Setup Teams')
    )];
}

function filterTasks(tasks, filter, actor, teamId = null) {
    return tasks.filter(task => {
        if (filter === 'mine') return task.userId === actor.author.id && getTaskStatus(task) !== 'done';
        if (filter === 'available') return !task.userId && !claimError(actor, task);
        if (filter === 'teams') return getTaskStatus(task) !== 'done' && Boolean(getTaskTeam(task, actor)) && (!teamId || getTaskTeam(task, actor).id === teamId);
        return true;
    });
}

function buildTaskPicker(tasks, filter, requestedPage = 0, actor = null, teamId = null) {
    const pageCount = Math.max(1, Math.ceil(tasks.length / pageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
    const visible = tasks.slice(page * pageSize, (page + 1) * pageSize);
    const team = listTaskTeams(tasks, actor).find(team => team.id === teamId);
    const labels = { available: 'Available Tasks', mine: 'My Tasks', all: 'All Tasks', teams: team ? `Team Tasks: ${escapeMarkdown(team.name)}` : 'Team Tasks' };
    const components = [];
    if (visible.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId('kanban:select')
            .setPlaceholder('Choose a task to view or update it')
            .addOptions(visible.map(task => ({
                label: short(`${getIssueKey(task) || task.id}: ${task.title}`, 100),
                value: String(task.id),
                description: short(`${getTaskTeam(task, actor) ? `${getTaskTeam(task, actor).name} · ` : ''}${columns.find(c => c.id === getTaskStatus(task)).name} · ${priorities[getTaskPriority(task)].label} priority · ${task.userId ? 'Assigned' : 'Available'}`, 100)
            })));
        components.push(new ActionRowBuilder().addComponents(select));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            button(`kanban:list:${filter}:${page - 1}${teamId ? `:${teamId}` : ''}`, 'Previous').setDisabled(page === 0),
            button(`kanban:list:${filter}:${page + 1}${teamId ? `:${teamId}` : ''}`, 'Next').setDisabled(page === pageCount - 1)
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        button('kanban:list:available:0', 'Available Tasks'),
        button('kanban:list:mine:0', 'My Tasks'),
        button('kanban:list:teams:0', 'Team Tasks'),
        button('kanban:list:all:0', 'Browse Tasks'),
        button('kanban:add', 'Add Task', ButtonStyle.Primary)
    ));
    return {
        content: `**${labels[filter] || labels.all}** — ${tasks.length} task(s)${pageCount > 1 ? ` · Page ${page + 1}/${pageCount}` : ''}\n${visible.length ? 'Choose a task below.' : filter === 'teams' ? 'No active tasks for this team.' : 'No tasks here yet.'}`,
        embeds: [], components, allowedMentions: { parse: [] }
    };
}

function buildTeamPicker(tasks, actor, requestedPage = 0) {
    const teams = listTaskTeams(tasks, actor);
    const pageCount = Math.max(1, Math.ceil(teams.length / pageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
    const components = [];
    if (teams.length) components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('kanban:teamview').setPlaceholder('Choose the team you want to see')
        .addOptions(teams.slice(page * pageSize, (page + 1) * pageSize).map(team => ({
            label: short(team.name, 100), value: team.id,
            description: `${filterTasks(tasks, 'teams', actor, team.id).length} active task(s)`
        })))));
    if (pageCount > 1) components.push(new ActionRowBuilder().addComponents(
        button(`kanban:teamlist:${page - 1}`, 'Previous').setDisabled(page === 0),
        button(`kanban:teamlist:${page + 1}`, 'Next').setDisabled(page === pageCount - 1)
    ));
    components.push(new ActionRowBuilder().addComponents(
        button('kanban:list:all:0', 'Browse Tasks'), button('kanban:add', 'Add Task', ButtonStyle.Primary),
        button('kanban:teamsetup', 'Setup Teams')
    ));
    return {
        content: `**Team Tasks**${pageCount > 1 ? ` · Page ${page + 1}/${pageCount}` : ''}\n${teams.length ? 'Choose a group to see its active tasks. Anyone can view any team.' : 'No teams yet. A server manager can use Setup Teams to enter team names.'}`,
        embeds: [], components, allowedMentions: { parse: [] }
    };
}

function buildIssueComponents(task, actor) {
    const id = String(task.id);
    const components = [new ActionRowBuilder().addComponents(
        button(`kanban:claim:${id}`, 'Claim', ButtonStyle.Success).setDisabled(Boolean(claimError(actor, task))),
        button(`kanban:start:${id}`, 'Start Work', ButtonStyle.Primary).setDisabled(Boolean(claimError(actor, task)) || getTaskStatus(task) === 'progress'),
        button(`kanban:release:${id}`, 'Release').setDisabled(!task.userId || Boolean(releaseError(actor, task))),
        button(`kanban:details:${id}`, 'Refresh'),
        button('kanban:list:mine:0', 'My Tasks')
    )];
    if (userCanManageIssue(actor, task)) {
        components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`kanban:status:${id}`)
            .setPlaceholder('Change task status')
            .addOptions(columns.map(column => ({ label: column.name, value: column.id, emoji: column.icon, default: column.id === getTaskStatus(task) })))));
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
        ['title', 'Task title', TextInputStyle.Short, true, 200, 'What needs to be done?'],
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
            .addOptions([{ label: 'No team', value: 'none', default: true }, ...teams.map(team => ({ label: short(team.name, 100), value: team.id }))])));
    }
    return modal;
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

module.exports = { buildBoardComponents, buildTaskPicker, buildTeamPicker, buildIssueComponents, buildAddModal, buildTeamSetup, buildTeamSetupModal, filterTasks, pageSize };
