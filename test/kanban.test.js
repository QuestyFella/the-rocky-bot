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
const { buildTaskPicker, buildIssueComponents, buildBoardComponents, buildAddModal, buildTeamSetup, filterTasks } = require('../utils/boardComponents');
const { claimError, releaseError, getTaskStatus, getTaskTeamRoleId } = require('../utils/kanban');
const { getConfiguredTeams, saveTeams, validateTeam, maxTeams } = require('../utils/teams');
const { loadServerConfig } = require('../utils/serverConfig');
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
        customId: 'kanban:claim:stable-task', guildId: guild.id, channelId: 'channel', guild, client, user: actor.author,
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
    for (const command of ['mine', 'available', 'myteams', 'team', 'start', 'release', 'unclaim']) {
        assert.deepEqual(parseMessageCommand(`!task ${command} RC-1`), { commandName: 'board', args: [command, 'RC-1'], restricted: true });
    }
});

const avionicsId = '111111111111111111';
const softwareId = '222222222222222222';
function configureTeams(f, ids = [avionicsId, softwareId]) {
    for (const id of ids) f.guild.roles.cache.set(id, { id, name: id === avionicsId ? 'Avionics' : 'Software', managed: false });
    assert.equal(saveTeams(f.actor, ids), null);
}

test('Setup Teams uses a role picker and only server managers can save or clear it', async () => {
    const f = fixture();
    f.guild.roles.cache.set(avionicsId, { id: avionicsId, name: 'Avionics', managed: false });
    f.interaction.customId = 'kanban:teamsetup:save';
    f.interaction.values = [avionicsId];
    f.interaction.isButton = () => false;
    f.interaction.isRoleSelectMenu = () => true;
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /Manage Server/);
    assert.equal(getConfiguredTeams(f.actor).length, 0);
    f.actor.member.permissions.has = () => true;
    await handleBoardInteraction(f.interaction);
    assert.deepEqual(getConfiguredTeams(f.actor).map(role => role.id), [avionicsId]);
    const setup = f.responses.at(-1)[1];
    assert.equal(setup.components[0].toJSON().components[0].type, 6);
    assert.equal(setup.components[0].toJSON().components[0].default_values[0].id, avionicsId);
    f.interaction.customId = 'kanban:teamsetup:clear';
    await handleBoardInteraction(f.interaction);
    assert.equal(getConfiguredTeams(f.actor).length, 0);
    assert.match(f.responses.at(-1)[1].content, /cleared/);
});

test('team setup is persistent and separate for each server and rejects invalid roles', () => {
    const a = fixture();
    const b = fixture();
    configureTeams(a, [avionicsId]);
    configureTeams(b, [softwareId]);
    a.client.serverConfigs = {};
    b.client.serverConfigs = {};
    assert.deepEqual(getConfiguredTeams(a.actor).map(role => role.id), [avionicsId]);
    assert.deepEqual(getConfiguredTeams(b.actor).map(role => role.id), [softwareId]);
    assert.ok(saveTeams(a.actor, [softwareId]));
    a.guild.roles.cache.set(a.guild.id, { id: a.guild.id, managed: false });
    assert.ok(saveTeams(a.actor, [a.guild.id]));
    a.guild.roles.cache.set('bot-role', { id: 'bot-role', managed: true });
    assert.ok(saveTeams(a.actor, ['bot-role']));
    assert.ok(saveTeams(a.actor, Array.from({ length: maxTeams + 1 }, (_, i) => String(i))));
    assert.deepEqual(loadServerConfig(a.guild.id).teamRoleIds, [avionicsId]);
    a.guild.roles.cache.delete(avionicsId);
    assert.equal(getConfiguredTeams(a.actor).length, 0);
    assert.ok(validateTeam(a.actor, avionicsId));
});

test('a failed team setup write preserves the previous configuration and disk file', () => {
    const f = fixture();
    configureTeams(f, [avionicsId]);
    f.guild.roles.cache.set(softwareId, { id: softwareId, name: 'Software', managed: false });
    const rename = fs.renameSync;
    const logError = console.error;
    try {
        fs.renameSync = () => { throw new Error('simulated disk failure'); };
        console.error = () => {};
        assert.ok(saveTeams(f.actor, [softwareId]));
    } finally {
        fs.renameSync = rename;
        console.error = logError;
    }
    assert.deepEqual(getConfiguredTeams(f.actor).map(role => role.id), [avionicsId]);
    assert.deepEqual(loadServerConfig(f.guild.id).teamRoleIds, [avionicsId]);
});

test('My Teams includes active tasks across all member teams, including claimed and legacy role tasks', async () => {
    const f = fixture({ roles: [avionicsId, softwareId] });
    configureTeams(f);
    const tasks = [
        { ...f.task, id: 'avionics', teamRoleId: avionicsId },
        { ...f.task, id: 'software', teamRoleId: softwareId, userId: 'someone-else' },
        { ...f.task, id: 'legacy', assignedToRole: avionicsId },
        { ...f.task, id: 'done', teamRoleId: avionicsId, completed: true },
        { ...f.task, id: 'other', teamRoleId: 'other-team' },
        { ...f.task, id: 'cleared', assignedToRole: avionicsId, teamRoleId: null },
        { ...f.task, id: 'untagged' }
    ];
    assert.deepEqual(filterTasks(tasks, 'teams', f.actor).map(task => task.id), ['avionics', 'software', 'legacy']);
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    f.interaction.customId = 'kanban:list:teams:0';
    await handleBoardInteraction(f.interaction);
    const payload = f.responses.at(-1)[1];
    assert.match(payload.content, /My Teams.*3 task/);
    const options = payload.components[0].toJSON().components[0].options;
    assert.ok(options.some(option => option.description.includes('Avionics')));
    assert.ok(options.some(option => option.description.includes('Software')));
});

test('new and legacy team tags survive claiming, status updates, release, and user reassignment', async () => {
    for (const legacy of [true, false]) {
        const f = fixture({ roles: [avionicsId], manager: true });
        configureTeams(f, [avionicsId]);
        const task = { ...f.task, ...(legacy ? { assignedToRole: avionicsId } : { teamRoleId: avionicsId }) };
        f.client.taskStorage.updateTask(f.guild.id, task.id, task);
        for (const action of ['claim', 'start', 'status', 'release']) {
            f.interaction.customId = `kanban:${action}:${task.id}`;
            f.interaction.values = ['review'];
            await handleBoardInteraction(f.interaction);
            assert.equal(getTaskTeamRoleId(f.client.taskStorage.getAllTasks(f.guild.id)[0]), avionicsId);
        }
        const message = { ...f.actor, mentions: { users: { first: () => ({ id: 'bob' }) }, roles: { first: () => null } }, reply: async () => {} };
        await board.execute(message, ['assign', task.issueKey, '<@bob>']);
        const saved = f.client.taskStorage.getAllTasks(f.guild.id)[0];
        assert.equal(saved.userId, 'bob');
        assert.equal(saved.teamRoleId, avionicsId);
    }
});

test('team tags can be edited or cleared independently of the assignee, with permission checks', async () => {
    const f = fixture();
    configureTeams(f);
    const task = { ...f.task, userId: 'alice', teamRoleId: avionicsId };
    f.client.taskStorage.updateTask(f.guild.id, task.id, task);
    f.interaction.customId = 'kanban:team:stable-task';
    f.interaction.values = [softwareId];
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamRoleId, softwareId);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].userId, 'alice');
    f.interaction.values = ['foreign-team'];
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /no longer set up/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamRoleId, softwareId);
    f.interaction.values = ['none'];
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamRoleId, null);
    f.interaction.user = { id: 'stranger' };
    f.interaction.values = [avionicsId];
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /permission/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamRoleId, null);
});

test('native Add Task modal selects a team, persists it, and rejects a team removed while the form is open', async () => {
    const f = fixture();
    configureTeams(f);
    f.interaction.customId = 'kanban:add';
    await handleBoardInteraction(f.interaction);
    const modal = f.responses.at(-1)[1].toJSON();
    assert.equal(modal.components.length, 5);
    const components = modal.components.map(label => ({ ...label, component: label.component.type === 4
        ? { ...label.component, value: { title: 'Team task', description: 'Build flight software', priority: 'high', due: '' }[label.component.custom_id] }
        : { ...label.component, values: [softwareId] } }));
    f.interaction.fields = new ModalSubmitFields(components.map(component => ModalSubmitInteraction.transformComponent(component)));
    f.interaction.customId = 'kanban:create';
    f.interaction.isButton = () => false;
    f.interaction.isModalSubmit = () => true;
    await handleBoardInteraction(f.interaction);
    const created = f.client.taskStorage.getAllTasks(f.guild.id).at(-1);
    assert.equal(created.title, 'Team task');
    assert.equal(created.teamRoleId, softwareId);
    assert.equal(created.userId, null);
    saveTeams(f.actor, [avionicsId]);
    await handleBoardInteraction(f.interaction);
    assert.match(f.responses.at(-1)[1].content, /no longer set up/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 2);
    components.at(-1).component.values = [];
    f.interaction.fields = new ModalSubmitFields(components.map(component => ModalSubmitInteraction.transformComponent(component)));
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).at(-1).teamRoleId, null);
});

test('team forms, pickers, task controls, and setup stay within Discord component limits', () => {
    const f = fixture();
    const roleIds = Array.from({ length: maxTeams }, (_, i) => String(BigInt(avionicsId) + BigInt(i)));
    configureTeams(f, roleIds);
    const teams = getConfiguredTeams(f.actor);
    const modal = buildAddModal(teams).toJSON();
    assert.equal(modal.components.length, 5);
    assert.equal(modal.components.at(-1).component.options.length, 25);
    const issue = buildIssueComponents({ ...f.task, userId: 'alice', teamRoleId: avionicsId }, f.actor).map(row => row.toJSON());
    assert.ok(issue.length <= 5);
    assert.equal(issue.at(-1).components[0].options.length, 25);
    assert.equal(buildTeamSetup(f.actor).components[0].toJSON().components[0].max_values, 24);
    for (const row of buildBoardComponents()) assert.ok(row.toJSON().components.length <= 5);
    const tasks = Array.from({ length: 61 }, (_, i) => ({ ...f.task, id: String(i), teamRoleId: avionicsId }));
    const page = buildTaskPicker(tasks, 'teams', 2, f.actor);
    assert.match(page.content, /Page 3\/3/);
    assert.match(page.components[1].toJSON().components[0].custom_id, /list:teams:1/);
    assert.equal(page.components[0].toJSON().components[0].options.length, 11);
});

test('team tags appear on the board and detail embeds and text commands can tag existing tasks', async () => {
    const f = fixture({ manager: true });
    configureTeams(f, [avionicsId]);
    const message = { ...f.actor, mentions: { roles: { first: () => f.guild.roles.cache.get(avionicsId) } }, reply: async () => {} };
    await board.execute(message, ['team', f.task.issueKey, `<@&${avionicsId}>`]);
    const task = f.client.taskStorage.getAllTasks(f.guild.id)[0];
    assert.equal(task.teamRoleId, avionicsId);
    assert.equal(task.userId, null);
    assert.equal(board.buildIssueEmbed(task, 0).toJSON().fields.find(field => field.name === 'Team').value, `<@&${avionicsId}>`);
    assert.ok(board.generateBoardEmbed(f.client, f.guild.id).toJSON().fields.some(field => field.value.includes(`Team: <@&${avionicsId}>`)));
    await board.execute(message, ['team', f.task.issueKey, 'none']);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamRoleId, null);
});

test('the text command workflow preserves legacy team tags through claim, start, completion, and release', async () => {
    const f = fixture({ roles: [avionicsId] });
    f.client.taskStorage.updateTask(f.guild.id, f.task.id, { ...f.task, assignedToRole: avionicsId });
    const message = { ...f.actor, reply: async () => {} };
    for (const command of ['claim', 'start', 'done', 'reopen', 'release']) {
        await board.execute(message, [command, f.task.issueKey]);
        assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[0].teamRoleId, avionicsId);
    }
});
