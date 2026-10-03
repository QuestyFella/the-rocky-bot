const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PermissionFlagsBits, MessageFlags } = require('discord.js');

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-kanban-'));
process.env.BOT_DATA_DIR = temporaryDir;
const TaskStorage = require('../taskStorage');
const board = require('../commands/board');
const { handleBoardInteraction } = require('../utils/boardInteractions');
const { buildTaskPicker, buildIssueComponents, buildBoardComponents, buildAddModal, filterTasks } = require('../utils/boardComponents');
const { claimError, releaseError, getTaskStatus } = require('../utils/kanban');
const { parseMessageCommand } = require('../utils/commandRouter');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
let fixtureNumber = 0;

function fixture({ userId = 'alice', roles = [], manager = false, privateMessage = false } = {}) {
    const guild = { id: `guild-${++fixtureNumber}`, name: 'Rocket Club' };
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
        inGuild: () => true, isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
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
    for (const command of ['mine', 'available', 'start', 'release', 'unclaim']) {
        assert.deepEqual(parseMessageCommand(`!task ${command} RC-1`), { commandName: 'board', args: [command, 'RC-1'], restricted: true });
    }
});
