const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PermissionFlagsBits, MessageFlags, Collection, ModalSubmitFields, ModalSubmitInteraction } = require('discord.js');

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-kanban-'));
process.env.BOT_DATA_DIR = temporaryDir;
const TaskStorage = require('../taskStorage');
const board = require('../commands/board');
const { handleBoardInteraction } = require('../utils/boardInteractions');
const { buildTaskPicker, buildIssueComponents, buildBoardComponents, buildAddModal, buildTeamSetup, buildTeamSetupModal, buildTeamPicker, filterTasks } = require('../utils/boardComponents');
const { claimError, releaseError, getTaskStatus } = require('../utils/kanban');
const { getConfiguredTeams, saveTeams, validateTeam, getTaskTeam, listTaskTeams, setTaskTeam, maxTeams, maxTeamNameLength } = require('../utils/teams');
const { loadServerConfig } = require('../utils/serverConfig');
const teamsCommand = require('../commands/teams');
const { parseMessageCommand } = require('../utils/commandRouter');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
let fixtureNumber = 0;

function fixture({ userId = 'alice', roles = [], manager = false, privateMessage = false } = {}) {
    const guild = { id: `guild-${++fixtureNumber}`, name: 'Rocket Club' };
    guild.roles = { cache: new Collection(), fetch: async () => guild.roles.cache };
    const member = { permissions: { has: flag => manager && [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild].includes(flag) }, roles: { cache: new Set(roles) }, pending: false };
    guild.members = { fetch: async () => member };
    const client = { taskStorage: new TaskStorage(path.join(temporaryDir, guild.id)), serverConfigs: {}, guilds: { cache: new Map([[guild.id, guild]]) }, pendingVerifications: new Map() };
    const actor = { client, guild, author: { id: userId }, member };
    const task = { id: 'stable-task', issueKey: 'RC-1', title: 'Build payload', userId: null, assignedToRole: null, createdBy: 'bob', priority: 'medium', status: 'todo', completed: false };
    client.taskStorage.addTask(guild.id, task);
    const responses = [];
    const interaction = {
        customId: 'kanban:claim:stable-task', guildId: guild.id, channelId: 'channel', guild, client, user: actor.author, memberPermissions: member.permissions,
        message: { flags: { has: flag => privateMessage && flag === MessageFlags.Ephemeral }, edit: async payload => responses.push(['messageEdit', payload]) },
        inGuild: () => true, isButton: () => true, isStringSelectMenu: () => false, isRoleSelectMenu: () => false, isModalSubmit: () => false,
        deferReply: async payload => responses.push(['deferReply', payload]), deferUpdate: async () => responses.push(['deferUpdate']),
        reply: async payload => responses.push(['reply', payload]), editReply: async payload => responses.push(['editReply', payload]),
        showModal: async modal => responses.push(['modal', modal])
    };
    return { guild, client, actor, task, interaction, responses };
}

test('new tasks default to available; --me and explicit mentions still assign', async () => {
    for (const [args, mentionedUser, expectedUser] of [
        [['add', 'Test', 'task'], null, null],
        [['add', 'Test', 'task', '--me'], null, 'alice'],
        [['add', 'Test', 'task', '<@bob>'], { id: 'bob' }, 'bob'],
        [['add', 'Test', 'task', '<@bob>', '--unassigned'], { id: 'bob' }, null]
    ]) {
        const f = fixture({ manager: true });
        const message = { ...f.actor, mentions: { users: { first: () => mentionedUser }, roles: { first: () => null } }, reply: async () => {}, channel: { send: async () => {} } };
        await board.execute(message, args);
        const task = f.client.taskStorage.getAllTasks(f.guild.id).at(-1);
        assert.equal(task.userId, expectedUser);
        assert.equal(task.title, 'Test task');
        assert.ok(task.issueKey);
    }
});

test('claim and start assign the clicking member; release returns task to To Do', async () => {
    const f = fixture({ privateMessage: true });
    await handleBoardInteraction(f.interaction);
    assert.equal(f.responses[0][0], 'deferUpdate');
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].userId, 'alice');
    f.interaction.customId = 'kanban:start:stable-task';
    await handleBoardInteraction(f.interaction);
    assert.equal(getTaskStatus(f.client.taskStorage.getAllTasks(f.guild.id)[0]), 'progress');
    f.interaction.customId = 'kanban:release:stable-task';
    await handleBoardInteraction(f.interaction);
    const task = f.client.taskStorage.getAllTasks(f.guild.id)[0];
    assert.equal(task.userId, null);
    assert.equal(task.assignedBy, null);
    assert.equal(getTaskStatus(task), 'todo');
});

test('concurrent claims cannot steal a task, including by its creator', async () => {
    const f = fixture();
    const second = { ...f.interaction, user: { id: 'bob' } };
    await Promise.all([handleBoardInteraction(f.interaction), handleBoardInteraction(second)]);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].userId, 'alice');
    assert.ok(f.responses.some(([, payload]) => payload?.content?.includes('already claimed')));
});

test('role tasks require membership, completed tasks cannot be claimed, and release requires ownership', () => {
    const f = fixture();
    assert.ok(claimError(f.actor, { ...f.task, assignedToRole: 'engineering' }));
    f.actor.member.roles.cache.add('engineering');
    assert.equal(claimError(f.actor, { ...f.task, assignedToRole: 'engineering' }), null);
    assert.ok(claimError(f.actor, { ...f.task, completed: true }));
    assert.ok(releaseError(f.actor, { ...f.task, userId: 'bob' }));
});

test('private task views and available/my filters use the clicking user', async () => {
    const f = fixture();
    f.interaction.customId = 'kanban:list:available:0';
    await handleBoardInteraction(f.interaction);
    assert.equal(f.responses[0][1].flags, MessageFlags.Ephemeral);
    assert.equal(filterTasks([{ ...f.task, userId: 'alice' }, { ...f.task, userId: 'bob' }], 'mine', f.actor).length, 1);
    assert.equal(filterTasks([{ ...f.task, assignedToRole: 'restricted' }, f.task], 'available', f.actor).length, 1);
});

test('deleted IDs cannot resolve to another task or another guild', async () => {
    const f = fixture();
    f.client.taskStorage.deleteTask(f.guild.id, f.task.id);
    f.client.taskStorage.addTask('other-guild', f.task);
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /no longer exists/);
    assert.equal(f.client.taskStorage.getAllTasks('other-guild')[0].userId, null);
});

test('channel restrictions, verification, and status permissions apply to components', async () => {
    const f = fixture();
    f.client.serverConfigs[f.guild.id] = { allowedChannelIds: ['other-channel'] };
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /disabled/);
    f.client.serverConfigs[f.guild.id] = { allowedChannelIds: [] };
    f.client.pendingVerifications.set(`${f.guild.id}:alice`, {});
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /verification/);
    f.client.pendingVerifications.clear();
    f.interaction.customId = 'kanban:status:stable-task';
    f.interaction.values = ['done'];
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /permission/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].status, 'todo');
});

test('component payloads respect Discord limits and paginate every task', () => {
    const f = fixture();
    const tasks = Array.from({ length: 61 }, (_, index) => ({ ...f.task, id: String(index), title: 'x'.repeat(300) }));
    const seen = [];
    for (let page = 0; page < 3; page++) {
        const payload = buildTaskPicker(tasks, 'all', page);
        const rows = payload.components.map(row => row.toJSON());
        const options = rows[0].components[0].options;
        assert.ok(options.length <= 25);
        assert.ok(options.every(option => option.label.length <= 100));
        seen.push(...options.map(option => option.value));
        assert.ok(rows.length <= 5);
    }
    assert.equal(new Set(seen).size, 61);
    for (const row of [...buildBoardComponents(), ...buildIssueComponents(f.task, f.actor)]) assert.ok(row.toJSON().components.length <= 5);
    assert.equal(buildAddModal().toJSON().components.length, 4);
    assert.equal(buildTaskPicker([], 'all').components.length, 1);
});

test('modal validates dates and priority and creates an unassigned task', async () => {
    const f = fixture();
    const fields = { title: 'New task', description: 'Details', priority: 'high', due: '2026-02-30' };
    f.interaction.customId = 'kanban:create';
    f.interaction.isButton = () => false;
    f.interaction.isModalSubmit = () => true;
    f.interaction.fields = { getTextInputValue: id => fields[id] };
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 1);
    assert.match(f.responses.at(-1)[1].content, /real due date/);
    fields.due = '2026-12-01';
    await handleBoardInteraction(f.interaction);
    const created = f.client.taskStorage.getAllTasks(f.guild.id).at(-1);
    assert.equal(created.title, 'New task');
    assert.equal(created.userId, null);
    assert.equal(created.priority, 'high');
    assert.equal(created.dueDate, '2026-12-01');
});

test('storage copies prevent mutations and failed writes from changing cached ownership', () => {
    const f = fixture();
    const tasks = f.client.taskStorage.getAllTasks(f.guild.id);
    tasks[0].userId = 'bob';
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].userId, null);
    const originalDir = f.client.taskStorage.tasksDir;
    f.client.taskStorage.tasksDir = '/dev/null/not-a-directory';
    const originalError = console.error;
    try {
        console.error = () => {};
        assert.equal(f.client.taskStorage.updateTask(f.guild.id, tasks[0].id, tasks[0]), false);
    } finally {
        console.error = originalError;
        f.client.taskStorage.tasksDir = originalDir;
    }
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].userId, null);
});

test('new text commands route to the Kanban module', () => {
    for (const command of ['mine', 'available', 'myteams', 'teamtasks', 'team', 'start', 'release', 'unclaim']) {
        assert.deepEqual(parseMessageCommand(`!task ${command} RC-1`), { commandName: 'board', args: [command, 'RC-1'], restricted: true });
    }
});

function configureTeams(f, names = ['Avionics', 'Software']) {
    assert.equal(saveTeams(f.actor, names), null);
    return getConfiguredTeams(f.actor);
}

function tagged(task, team) {
    const copy = { ...task };
    setTaskTeam(copy, team);
    return copy;
}

test('Setup Teams uses a names form and checks manager permissions on opening and submitting', async () => {
    const f = fixture();
    f.interaction.customId = 'kanban:teamsetup:edit';
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /Manage Server/);
    f.actor.member.permissions.has = () => true;
    await handleBoardInteraction(f.interaction);
    const modal = f.responses.at(-1)[1].toJSON();
    assert.equal(modal.components[0].component.type, 4);
    f.interaction.customId = modal.custom_id;
    f.interaction.isButton = () => false;
    f.interaction.isModalSubmit = () => true;
    f.interaction.fields = { getTextInputValue: () => 'Avionics\nSoftware\n\n' };
    f.actor.member.permissions.has = () => false;
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /Manage Server/);
    assert.equal(getConfiguredTeams(f.actor).length, 0);
    f.actor.member.permissions.has = () => true;
    await handleBoardInteraction(f.interaction);
    assert.deepEqual(getConfiguredTeams(f.actor).map(team => team.name), ['Avionics', 'Software']);
    assert.match(buildTeamSetupModal(f.actor).toJSON().components[0].component.value, /Avionics\nSoftware/);
    f.interaction.customId = 'kanban:teamsetup:clear';
    f.actor.member.permissions.has = () => false;
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /Manage Server/);
    assert.equal(getConfiguredTeams(f.actor).length, 2);
    f.actor.member.permissions.has = () => true;
    await handleBoardInteraction(f.interaction);
    assert.equal(getConfiguredTeams(f.actor).length, 0);
    assert.match(f.responses.at(-1)[1].content, /cleared/);
});

test('team names persist separately for each server without roles; validation and reordering keep IDs', () => {
    const a = fixture();
    const b = fixture();
    const [avionics, software] = configureTeams(a);
    configureTeams(b, ['Mechanical']);
    a.client.serverConfigs = {};
    b.client.serverConfigs = {};
    assert.deepEqual(getConfiguredTeams(a.actor).map(team => team.name), ['Avionics', 'Software']);
    assert.deepEqual(getConfiguredTeams(b.actor).map(team => team.name), ['Mechanical']);
    assert.equal(validateTeam(b.actor, avionics.id)?.includes('no longer set up'), true);
    assert.equal(saveTeams(a.actor, ['Software', 'Avionics', 'avionics', ' ']), null);
    assert.deepEqual(getConfiguredTeams(a.actor).map(team => team.id), [software.id, avionics.id]);
    assert.ok(saveTeams(a.actor, ['x'.repeat(maxTeamNameLength + 1)]));
    assert.ok(saveTeams(a.actor, ['line\nbreak']));
    assert.ok(saveTeams(a.actor, Array.from({ length: maxTeams + 1 }, (_, i) => `Team ${i}`)));
    assert.ok(saveTeams(a.actor, [null]));
    assert.deepEqual(loadServerConfig(a.guild.id).teams.map(team => team.id), [software.id, avionics.id]);
    assert.equal(a.guild.roles.cache.size, 0);
});

test('a failed team setup write preserves the previous configuration and disk file', () => {
    const f = fixture();
    const [avionics] = configureTeams(f, ['Avionics']);
    const rename = fs.renameSync;
    const logError = console.error;
    try {
        fs.renameSync = () => { throw new Error('simulated disk failure'); };
        console.error = () => {};
        assert.ok(saveTeams(f.actor, ['Software']));
    } finally {
        fs.renameSync = rename;
        console.error = logError;
    }
    assert.deepEqual(getConfiguredTeams(f.actor), [avionics]);
    assert.deepEqual(loadServerConfig(f.guild.id).teams, [avionics]);
});

test('any member can choose a team and browse its active tasks, with no role or membership requirement', async () => {
    const f = fixture();
    const [avionics, software] = configureTeams(f);
    const tasks = [
        tagged({ ...f.task, id: 'avionics' }, avionics),
        tagged({ ...f.task, id: 'claimed', userId: 'someone-else' }, avionics),
        tagged({ ...f.task, id: 'software' }, software),
        tagged({ ...f.task, id: 'done', completed: true }, avionics),
        { ...f.task, id: 'untagged' }
    ];
    assert.deepEqual(filterTasks(tasks, 'teams', f.actor, avionics.id).map(task => task.id), ['avionics', 'claimed']);
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    f.interaction.customId = 'kanban:list:teams:0';
    await handleBoardInteraction(f.interaction);
    let payload = f.responses.at(-1)[1];
    assert.match(payload.content, /Anyone can view any team/);
    assert.equal(payload.components[0].toJSON().components[0].options.length, 2);
    f.interaction.customId = 'kanban:teamview';
    f.interaction.values = [avionics.id];
    await handleBoardInteraction(f.interaction);
    payload = f.responses.at(-1)[1];
    assert.match(payload.content, /Team Tasks: Avionics.*2 task/);
    assert.deepEqual(payload.components[0].toJSON().components[0].options.map(option => option.value), ['avionics', 'claimed']);
    assert.ok(payload.components[0].toJSON().components[0].options.every(option => option.description.includes('Avionics')));
    assert.equal(claimError(f.actor, tasks[0]), null);
    assert.ok(claimError(f.actor, tasks[1]));
    assert.equal(f.actor.member.roles.cache.size, 0);
    f.interaction.values = ['foreign-team'];
    await handleBoardInteraction(f.interaction);
    assert.equal(f.responses.at(-1)[1].components[0].toJSON().components[0].custom_id, 'kanban:teamview');
});

test('team labels survive claiming, status updates, release, and user reassignment', async () => {
    const f = fixture({ manager: true });
    const [avionics] = configureTeams(f, ['Avionics']);
    f.client.taskStorage.updateTask(f.guild.id, f.task.id, tagged(f.task, avionics));
    for (const action of ['claim', 'start', 'status', 'release']) {
        f.interaction.customId = `kanban:${action}:${f.task.id}`;
        f.interaction.values = ['review'];
        await handleBoardInteraction(f.interaction);
        assert.deepEqual(getTaskTeam(f.client.taskStorage.getAllTasks(f.guild.id)[0]), avionics);
    }
    const message = { ...f.actor, mentions: { users: { first: () => ({ id: 'bob' }) }, roles: { first: () => null } }, reply: async () => {} };
    await board.execute(message, ['assign', f.task.issueKey, '<@bob>']);
    const saved = f.client.taskStorage.getAllTasks(f.guild.id)[0];
    assert.equal(saved.userId, 'bob');
    assert.deepEqual(getTaskTeam(saved), avionics);
});

test('removing a team keeps task labels and browsing; restoring its name keeps existing task links', async () => {
    const f = fixture();
    const [avionics] = configureTeams(f, ['Avionics']);
    const task = tagged(f.task, avionics);
    f.client.taskStorage.updateTask(f.guild.id, task.id, task);
    saveTeams(f.actor, []);
    assert.deepEqual(listTaskTeams([task], f.actor), [avionics]);
    assert.match(board.buildIssueEmbed(task, 0, f.actor).toJSON().fields.find(field => field.name === 'Team').value, /Avionics/);
    f.interaction.customId = 'kanban:teamview';
    f.interaction.values = [avionics.id];
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /Avionics.*1 task/);
    saveTeams(f.actor, ['Avionics']);
    assert.deepEqual(getConfiguredTeams(f.actor), [avionics]);
});

test('team labels can be edited or cleared independently of the assignee, with permission checks', async () => {
    const f = fixture();
    const [avionics, software] = configureTeams(f);
    f.client.taskStorage.updateTask(f.guild.id, f.task.id, tagged({ ...f.task, userId: 'alice' }, avionics));
    f.interaction.customId = 'kanban:team:stable-task';
    f.interaction.values = [software.id];
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamId, software.id);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].userId, 'alice');
    f.interaction.values = ['foreign-team'];
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /no longer set up/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamId, software.id);
    f.interaction.values = ['none'];
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamId, null);
    f.interaction.user = { id: 'stranger' };
    f.interaction.values = [avionics.id];
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /permission/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamId, null);
});

test('a regular member can use the native Add Task modal, select a visible team, and submit without roles', async () => {
    const f = fixture();
    const [avionics, software] = configureTeams(f);
    f.interaction.customId = 'kanban:add';
    await handleBoardInteraction(f.interaction);
    const modal = f.responses.at(-1)[1].toJSON();
    assert.equal(modal.components.length, 5);
    const components = modal.components.map(label => ({ ...label, component: label.component.type === 4
        ? { ...label.component, value: { title: 'Team task', description: 'Build flight software', priority: 'high', due: '' }[label.component.custom_id] }
        : { ...label.component, values: [software.id] } }));
    f.interaction.fields = new ModalSubmitFields(components.map(component => ModalSubmitInteraction.transformComponent(component)));
    f.interaction.customId = 'kanban:create';
    f.interaction.isButton = () => false;
    f.interaction.isModalSubmit = () => true;
    await handleBoardInteraction(f.interaction);
    const created = f.client.taskStorage.getAllTasks(f.guild.id).at(-1);
    assert.equal(created.title, 'Team task');
    assert.equal(created.teamId, software.id);
    assert.equal(created.teamName, 'Software');
    assert.equal(created.userId, null);
    assert.equal(created.assignedToRole, null);
    assert.match(f.responses.at(-1)[1].embeds[0].toJSON().fields.find(field => field.name === 'Team').value, /Software/);
    saveTeams(f.actor, [avionics.name]);
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /no longer set up/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 2);
    components.at(-1).component.values = [];
    f.interaction.fields = new ModalSubmitFields(components.map(component => ModalSubmitInteraction.transformComponent(component)));
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).at(-1).teamId, null);
});

test('regular members can create tasks through text commands and team labels accept names with spaces', async () => {
    const f = fixture();
    const [team] = configureTeams(f, ['Flight Software']);
    const replies = [];
    const message = { ...f.actor, mentions: { users: { first: () => null }, roles: { first: () => null } }, reply: async content => replies.push(content) };
    await board.execute(message, ['add', 'New', 'task']);
    const created = f.client.taskStorage.getAllTasks(f.guild.id).at(-1);
    assert.equal(created.createdBy, 'alice');
    await board.execute(message, ['team', created.id, 'flight', 'software']);
    const saved = f.client.taskStorage.getAllTasks(f.guild.id).at(-1);
    assert.equal(saved.teamId, team.id);
    assert.equal(board.buildIssueEmbed(saved, 0, f.actor).toJSON().fields.find(field => field.name === 'Team').value, 'Flight Software');
    assert.ok(board.generateBoardEmbed(f.client, f.guild.id).toJSON().fields.some(field => field.value.includes('Team: Flight Software')));
    await board.execute(message, ['team', created.id, 'none']);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).at(-1).teamId, null);
    assert.equal(replies.length, 3);
});

test('team forms and controls fit Discord limits, and pagination preserves the selected team', async () => {
    const f = fixture();
    const teams = configureTeams(f, Array.from({ length: maxTeams }, (_, i) => `Team ${i}`));
    assert.equal(buildAddModal(teams).toJSON().components.at(-1).component.options.length, 25);
    const issue = buildIssueComponents(tagged({ ...f.task, userId: 'alice' }, teams[0]), f.actor).map(row => row.toJSON());
    assert.ok(issue.length <= 5);
    assert.equal(issue.at(-1).components[0].options.length, 25);
    for (const row of [...buildBoardComponents(), ...buildTeamSetup(f.actor).components]) assert.ok(row.toJSON().components.length <= 5);
    const tasks = Array.from({ length: 61 }, (_, i) => tagged({ ...f.task, id: String(i) }, teams[0]));
    tasks.push(tagged({ ...f.task, id: 'other' }, teams[1]));
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    f.interaction.customId = `kanban:list:teams:2:${teams[0].id}`;
    await handleBoardInteraction(f.interaction);
    const page = f.responses.at(-1)[1];
    assert.match(page.content, /Team 0.*61 task.*Page 3\/3/);
    assert.equal(page.components[1].toJSON().components[0].custom_id, `kanban:list:teams:1:${teams[0].id}`);
    assert.equal(page.components[0].toJSON().components[0].options.length, 11);
    const oldTeams = Array.from({ length: 61 }, (_, i) => ({ ...f.task, id: `old-${i}`, teamId: `old-team-${i}`, teamName: `Old Team ${i}` }));
    saveTeams(f.actor, []);
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push(...buildTeamPicker(oldTeams, f.actor, i).components[0].toJSON().components[0].options.map(option => option.value));
    assert.equal(new Set(seen).size, 61);
});

test('legacy role setup and task tags convert to labels that survive Discord role deletion', async () => {
    for (const legacyAssignment of [true, false]) {
        const f = fixture({ roles: ['old-role'] });
        f.guild.roles.cache.set('old-role', { id: 'old-role', name: 'Avionics' });
        f.client.serverConfigs[f.guild.id] = { allowedChannelIds: [], teamRoleIds: ['old-role'] };
        f.client.taskStorage.updateTask(f.guild.id, f.task.id, { ...f.task, ...(legacyAssignment ? { assignedToRole: 'old-role' } : { teamRoleId: 'old-role' }) });
        const message = { ...f.actor, reply: async () => {} };
        for (const command of ['claim', 'start', 'done', 'reopen', 'release']) {
            await board.execute(message, [command, f.task.issueKey]);
            assert.deepEqual(getTaskTeam(f.client.taskStorage.getAllTasks(f.guild.id)[0]), { id: 'legacy-old-role', name: 'Avionics' });
        }
        saveTeams(f.actor, ['Avionics']);
        f.guild.roles.cache.delete('old-role');
        f.actor.member.roles.cache.clear();
        assert.equal(loadServerConfig(f.guild.id).teamRoleIds, undefined);
        assert.deepEqual(getConfiguredTeams(f.actor), [{ id: 'legacy-old-role', name: 'Avionics' }]);
        const task = f.client.taskStorage.getAllTasks(f.guild.id)[0];
        assert.equal(task.teamRoleId, undefined);
        assert.equal(claimError(f.actor, task), null);
        assert.match(board.buildIssueEmbed(task, 0, f.actor).toJSON().fields.find(field => field.name === 'Team').value, /Avionics/);
        saveTeams(f.actor, []);
        assert.deepEqual(listTaskTeams([task], f.actor), [{ id: 'legacy-old-role', name: 'Avionics' }]);
    }
});

test('everyone can browse teams by text; only managers can open team setup', async () => {
    const f = fixture();
    configureTeams(f);
    const sent = [];
    const message = { ...f.actor, reply: async content => sent.push(content), channel: { send: async payload => sent.push(payload) } };
    await teamsCommand.execute(message);
    assert.match(sent.at(-1).content, /Team Tasks/);
    await teamsCommand.execute(message, ['setup']);
    assert.match(sent.at(-1), /Manage Server/);
    f.actor.member.permissions.has = () => true;
    await teamsCommand.execute(message, ['setup']);
    assert.match(sent.at(-1).content, /Setup Teams/);
});

test('long team names with Markdown characters fit setup messages and remain literal in task details', () => {
    const f = fixture();
    const teams = configureTeams(f, Array.from({ length: maxTeams }, (_, i) => `${i}${'*'.repeat(48)}`.slice(0, maxTeamNameLength)));
    assert.ok(buildTeamSetup(f.actor, 'Teams saved.').content.length <= 2000);
    assert.ok(buildTeamSetupModal(f.actor).toJSON().components[0].component.value.length <= maxTeams * (maxTeamNameLength + 1));
    const task = tagged(f.task, teams[0]);
    assert.match(board.buildIssueEmbed(task, 0).toJSON().fields.find(field => field.name === 'Team').value, /\\\*/);
});
