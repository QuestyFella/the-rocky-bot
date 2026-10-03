const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, RoleSelectMenuBuilder
} = require('discord.js');
const { columns, priorities, getTaskStatus, getTaskPriority, getIssueKey, claimError, releaseError, userCanManageIssue, getTaskTeamRoleId } = require('./kanban');
const { getConfiguredTeams, maxTeams } = require('./teams');

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
        button('kanban:list:teams:0', 'My Teams'),
        button('kanban:teamsetup', 'Setup Teams')
    )];
}

function filterTasks(tasks, filter, actor) {
    return tasks.filter(task => {
        if (filter === 'mine') return task.userId === actor.author.id && getTaskStatus(task) !== 'done';
        if (filter === 'available') return !task.userId && !claimError(actor, task);
        if (filter === 'teams') return getTaskStatus(task) !== 'done' && Boolean(getTaskTeamRoleId(task) && actor.member.roles.cache.has(getTaskTeamRoleId(task)));
        return true;
    });
}

function buildTaskPicker(tasks, filter, requestedPage = 0, actor = null) {
    const pageCount = Math.max(1, Math.ceil(tasks.length / pageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
    const visible = tasks.slice(page * pageSize, (page + 1) * pageSize);
    const labels = { available: 'Available Tasks', mine: 'My Tasks', all: 'All Tasks', teams: 'My Teams' };
    const components = [];
    if (visible.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId('kanban:select')
            .setPlaceholder('Choose a task to view or update it')
            .addOptions(visible.map(task => ({
                label: short(`${getIssueKey(task) || task.id}: ${task.title}`, 100),
                value: String(task.id),
                description: short(`${getTaskTeamRoleId(task) ? `${actor?.guild.roles.cache.get(getTaskTeamRoleId(task))?.name || 'Team'} · ` : ''}${columns.find(c => c.id === getTaskStatus(task)).name} · ${priorities[getTaskPriority(task)].label} priority · ${task.userId ? 'Assigned' : 'Available'}`, 100)
            })));
        components.push(new ActionRowBuilder().addComponents(select));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            button(`kanban:list:${filter}:${page - 1}`, 'Previous').setDisabled(page === 0),
            button(`kanban:list:${filter}:${page + 1}`, 'Next').setDisabled(page === pageCount - 1)
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        button('kanban:list:available:0', 'Available Tasks'),
        button('kanban:list:mine:0', 'My Tasks'),
        button('kanban:list:teams:0', 'My Teams'),
        button('kanban:list:all:0', 'Browse Tasks'),
        button('kanban:add', 'Add Task', ButtonStyle.Primary)
    ));
    return {
        content: `**${labels[filter] || labels.all}** — ${tasks.length} task(s)${pageCount > 1 ? ` · Page ${page + 1}/${pageCount}` : ''}\n${visible.length ? 'Choose a task below.' : filter === 'teams' ? 'No active tasks for your team roles. Ask a server manager to use Setup Teams and add you to the right Discord role.' : 'No tasks here yet.'}`,
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
        if (teams.length || getTaskTeamRoleId(task)) {
            const teamId = getTaskTeamRoleId(task);
            components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
                .setCustomId(`kanban:team:${id}`)
                .setPlaceholder('Change team tag')
                .addOptions([
                    { label: 'No team', value: 'none', default: !teamId },
                    ...teams.map(role => ({ label: short(role.name, 100), value: role.id, default: role.id === teamId }))
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
            .addOptions([{ label: 'No team', value: 'none', default: true }, ...teams.map(role => ({ label: short(role.name, 100), value: role.id }))])));
    }
    return modal;
}

function buildTeamSetup(actor, content = '') {
    const teams = getConfiguredTeams(actor);
    const select = new RoleSelectMenuBuilder().setCustomId('kanban:teamsetup:save')
        .setPlaceholder('Choose your team roles').setMinValues(1).setMaxValues(maxTeams);
    if (teams.length) select.setDefaultRoles(teams.map(role => role.id));
    return {
        content: `${content ? `${content}\n\n` : ''}**Setup Teams**\nChoose the Discord roles that represent your teams (up to ${maxTeams}). The selection saves immediately. Add members to those roles in Discord; their tasks appear under **My Teams**.\nCurrent teams: ${teams.length ? teams.map(role => `<@&${role.id}>`).join(', ') : 'None yet.'}\nExisting task tags are kept when you change this setup.`,
        embeds: [],
        components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(
            button('kanban:teamsetup:clear', 'Clear Team Setup'),
            button('kanban:list:teams:0', 'My Teams'),
            button('kanban:add', 'Add Task', ButtonStyle.Primary)
        )],
        allowedMentions: { parse: [] }
    };
}

module.exports = { buildBoardComponents, buildTaskPicker, buildIssueComponents, buildAddModal, buildTeamSetup, filterTasks, pageSize };
