const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection, MessageFlags, PermissionsBitField, PermissionFlagsBits, ModalSubmitFields, ModalSubmitInteraction } = require('discord.js');

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-flows-'));
process.env.BOT_DATA_DIR = temporaryDir;
const TaskStorage = require('../taskStorage');
const board = require('../commands/board');
const { handleBoardInteraction } = require('../utils/boardInteractions');
const { buildBoardComponents, buildMoreMenu, buildTaskPicker, buildTeamPicker, buildIssueComponents, buildAddModal, buildEditModal, buildTeamSetup, buildTeamSetupModal, buildImportModal, pageSize } = require('../utils/boardComponents');
const { getTaskStatus } = require('../utils/kanban');
const { getTaskTag } = require('../utils/taskTags');
const { saveTeams, getConfiguredTeams } = require('../utils/teams');
const { prepareImport } = require('../utils/taskImport');
const importCommand = require('../commands/import');
const teamsCommand = require('../commands/teams');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
let sequence = 0;

function fixture({ manager = false, userId = 'alice', task = {} } = {}) {
    const member = { pending: false, permissions: new PermissionsBitField(manager ? [PermissionFlagsBits.ManageGuild] : []), roles: { cache: new Collection() } };
    const members = new Map([[userId, member]]);
    const guild = { id: `flow-guild-${++sequence}`, name: 'Rocket Club', roles: { cache: new Collection() }, members: { fetch: async options => members.get(options.user || options) || member } };
    const client = { taskStorage: new TaskStorage(path.join(temporaryDir, guild.id)), serverConfigs: {}, guilds: { cache: new Collection([[guild.id, guild]]) }, pendingVerifications: new Map() };
    const actor = { client, guild, member, author: { id: userId }, channelId: 'channel' };
    const initial = { id: 'stable-task', issueKey: 'RC-1', title: 'Build payload', description: 'Keep all details.', priority: 'high', dueDate: '2026-10-12', status: 'todo', completed: false, createdBy: 'bob', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', userId: null, assignedToRole: null, ...task };
    client.taskStorage.addTask(guild.id, initial);
    assert.equal(saveTeams(actor, ['Cubesat', 'Software']), null);
    return { client, guild, actor, member, members, initial };
}

const componentsJSON = payload => (payload.components || []).map(row => row.toJSON ? row.toJSON() : row);
const controls = payload => componentsJSON(payload).flatMap(row => row.components);
const ids = payload => controls(payload).map(component => component.custom_id);
const taskNow = f => f.client.taskStorage.getAllTasks(f.guild.id)[0];

function validateMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    assert.ok((payload.content || '').length <= 2000);
    const rows = componentsJSON(payload);
    assert.ok(rows.length <= 5);
    const all = rows.flatMap(row => row.components);
    assert.equal(new Set(all.map(c => c.custom_id)).size, all.length, 'custom IDs must be unique within the message');
    for (const row of rows) {
        assert.ok(row.components.length >= 1 && row.components.length <= 5);
        if (row.components.some(c => c.type !== 2)) assert.equal(row.components.length, 1);
        for (const c of row.components) {
            assert.ok(c.custom_id.length >= 1 && c.custom_id.length <= 100);
            if (c.type === 2) assert.ok(c.label.length <= 80);
            if (c.options) {
                assert.ok(c.options.length >= 1 && c.options.length <= 25);
                assert.equal(new Set(c.options.map(o => o.value)).size, c.options.length);
                for (const option of c.options) {
                    assert.ok(option.label.length <= 100 && option.value.length <= 100);
                    assert.ok((option.description || '').length <= 100);
                }
            }
        }
    }
    let embedChars = 0;
    for (const builder of payload.embeds || []) {
        const embed = builder.toJSON ? builder.toJSON() : builder;
        assert.ok((embed.title || '').length <= 256 && (embed.description || '').length <= 4096);
        assert.ok((embed.fields || []).length <= 25);
        embedChars += (embed.title || '').length + (embed.description || '').length + (embed.footer?.text || '').length + (embed.author?.name || '').length;
        for (const field of embed.fields || []) {
            assert.ok(field.name.length >= 1 && field.name.length <= 256 && field.value.length >= 1 && field.value.length <= 1024);
            embedChars += field.name.length + field.value.length;
        }
    }
    assert.ok(embedChars <= 6000);
}

function validateModal(modal) {
    const json = modal.toJSON();
    assert.ok(json.custom_id.length <= 100 && json.title.length <= 45);
    assert.ok(json.components.length >= 1 && json.components.length <= 5);
    assert.equal(new Set(json.components.map(label => label.component.custom_id)).size, json.components.length);
    for (const label of json.components) {
        assert.ok(label.label.length <= 45);
        if (label.component.type === 4) {
            assert.ok(label.component.max_length <= 4000);
            assert.ok((label.component.value || '').length <= label.component.max_length);
        }
    }
}

async function interact(f, customId, { type = 'button', values = [], fields, userId = f.actor.author.id, channelId = f.actor.channelId, privateMessage = true, inGuild = true, member = f.members.get(userId) || f.member, guildId = f.guild.id } = {}) {
    const responses = [];
    const interaction = {
        customId, guildId, guild: f.guild, client: f.client, channelId, user: { id: userId }, member, memberPermissions: member.permissions, values, fields,
        message: { flags: { has: flag => privateMessage && flag === MessageFlags.Ephemeral }, edit: async payload => { validateMessage(payload); responses.push(['messageEdit', payload]); } },
        inGuild: () => inGuild, isButton: () => type === 'button', isStringSelectMenu: () => type === 'select', isRoleSelectMenu: () => false, isModalSubmit: () => type === 'modal',
        reply: async payload => { validateMessage(payload); responses.push(['reply', payload]); },
        editReply: async payload => { validateMessage(payload); responses.push(['editReply', payload]); },
        deferReply: async payload => responses.push(['deferReply', payload]), deferUpdate: async () => responses.push(['deferUpdate']),
        showModal: async modal => { validateModal(modal); responses.push(['modal', modal]); }
    };
    const handled = await handleBoardInteraction(interaction);
    if (handled) assert.equal(responses.filter(([name]) => ['reply', 'deferReply', 'deferUpdate', 'modal'].includes(name)).length, 1, 'acknowledge exactly once');
    return { handled, responses, payload: responses.at(-1)?.[1], kind: responses.at(-1)?.[0] };
}

function modalFields(modal, values) {
    const components = modal.toJSON().components.map(label => ({ ...label, component: {
        ...label.component, ...(label.component.type === 4 ? { value: values[label.component.custom_id] ?? label.component.value ?? '' } : { values: values[label.component.custom_id] ? [values[label.component.custom_id]] : [] })
    } }));
    return new ModalSubmitFields(components.map(c => ModalSubmitInteraction.transformComponent(c, {})));
}

async function openEdit(f, options) {
    const result = await interact(f, `kanban:edit:${f.initial.id}`, options);
    assert.equal(result.kind, 'modal');
    return result.payload;
}

async function submitEdit(f, modal, values = {}, options = {}) {
    return interact(f, modal.toJSON().custom_id, { ...options, type: 'modal', fields: modalFields(modal, values) });
}

test('shared board stays simple and More privately hides every manager control from members', async () => {
    const member = fixture();
    assert.deepEqual(controls({ components: buildBoardComponents() }).map(c => c.label), ['Add Task', 'Available Tasks', 'My Tasks', 'Team Tasks', 'More']);
    const result = await interact(member, 'kanban:more', { privateMessage: false });
    assert.equal(result.responses[0][1].flags, MessageFlags.Ephemeral);
    assert.deepEqual(controls(result.payload).map(c => c.label), ['Browse Tasks', 'Add Task']);
    const admin = fixture({ manager: true });
    const privateMenu = (await interact(admin, 'kanban:more', { privateMessage: false })).payload;
    assert.deepEqual(controls(privateMenu).map(c => c.label), ['Browse Tasks', 'Import Tasks', 'Setup Teams', 'Refresh Board', 'Add Task', 'Blocked Tasks']);
    for (const payload of [buildTeamPicker([], admin.actor), buildTaskPicker([], 'all', 0, admin.actor), { components: buildBoardComponents() }]) {
        assert.ok(!ids(payload).some(id => /kanban:(teamsetup|import|refresh)/.test(id)));
    }
});

for (const action of ['kanban:import', 'kanban:teamsetup', 'kanban:teamsetup:edit', 'kanban:teamsetup:clear', 'kanban:refresh']) {
    test(`members cannot invoke hidden manager action ${action} from an older message`, async () => {
        const f = fixture();
        const before = taskNow(f);
        const result = await interact(f, action);
        assert.match(result.payload.content, /Manage Server/);
        assert.deepEqual(taskNow(f), before);
        assert.equal(getConfiguredTeams(f.actor).length, 2);
    });
}

test('manager menu, Refresh Board, and Setup Teams support both Manage Server and Administrator', async () => {
    for (const permission of [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator]) {
        const f = fixture();
        f.member.permissions.add(permission);
        const menu = (await interact(f, 'kanban:more')).payload;
        assert.ok(ids(menu).includes('kanban:teamsetup'));
        assert.match((await interact(f, 'kanban:refresh')).payload.content, /Board refreshed/);
        assert.match((await interact(f, 'kanban:teamsetup')).payload.content, /Current teams: Cubesat, Software/);
        const modal = (await interact(f, 'kanban:teamsetup:edit')).payload;
        await interact(f, modal.toJSON().custom_id, { type: 'modal', fields: modalFields(modal, { names: 'Cubesat\nSoftware\nMechanical' }) });
        assert.equal(getConfiguredTeams(f.actor).length, 3);
        assert.match((await interact(f, 'kanban:teamsetup:clear')).payload.content, /cleared/);
        assert.equal(getConfiguredTeams(f.actor).length, 0);
    }
});

test('non-managers cannot import through a form, preview page, confirmation, or text command', async () => {
    const f = fixture();
    for (const [id, type] of [['kanban:importpreview', 'modal'], ['kanban:importpage:fake:1', 'button'], ['kanban:importconfirm:fake', 'button']]) {
        assert.match((await interact(f, id, { type })).payload.content, /Manage Server/);
    }
    const sent = [];
    await importCommand.execute({ ...f.actor, channel: { id: f.actor.channelId }, content: '!task import\nTitle: Unwanted', attachments: new Collection(), reply: async value => sent.push(value) });
    assert.match(sent.at(-1), /Manage Server/);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.initial]);
});

test('import confirmation rechecks demoted manager permission and still permits cancellation', async () => {
    const f = fixture({ manager: true });
    const { draft } = prepareImport(f.actor, 'Title: Imported');
    f.member.permissions.remove(PermissionFlagsBits.ManageGuild);
    assert.match((await interact(f, `kanban:importconfirm:${draft.id}`)).payload.content, /Manage Server/);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.initial]);
    assert.match((await interact(f, `kanban:importcancel:${draft.id}`)).payload.content, /cancelled/);
    assert.equal(f.client.taskImports.size, 0);
});

test('all members can use Add Task, including its native team dropdown, then edit their new task', async () => {
    const f = fixture();
    const add = (await interact(f, 'kanban:add', { privateMessage: false })).payload;
    const team = getConfiguredTeams(f.actor)[0];
    const result = await interact(f, add.toJSON().custom_id, { type: 'modal', fields: modalFields(add, { title: 'New work', description: 'First details', priority: 'urgent', due: '2028-02-29', team: team.id }) });
    const created = f.client.taskStorage.getAllTasks(f.guild.id)[1];
    assert.equal(created.createdBy, 'alice');
    assert.equal(created.teamId, team.id);
    assert.equal(created.userId, null);
    assert.ok(ids(result.payload).includes(`kanban:edit:${created.id}`));
    const modal = (await interact(f, `kanban:edit:${created.id}`)).payload;
    await submitEdit(f, modal, { title: 'Updated new work', description: '' });
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[1].title, 'Updated new work');
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[1].description, '');
});

test('edit appears for creators, assignees, managers, and assigned-role members; unrelated members cannot open it', async () => {
    for (const scenario of ['creator', 'assignee', 'manager', 'role', 'unrelated']) {
        const f = fixture({ manager: scenario === 'manager', task: scenario === 'creator' ? { createdBy: 'alice' } : scenario === 'assignee' ? { userId: 'alice' } : scenario === 'role' ? { assignedToRole: 'engineering' } : {} });
        if (scenario === 'role') f.member.roles.cache.set('engineering', { id: 'engineering' });
        const buttons = ids({ components: buildIssueComponents(taskNow(f), f.actor) });
        assert.equal(buttons.includes('kanban:edit:stable-task'), scenario !== 'unrelated');
        const result = await interact(f, 'kanban:edit:stable-task');
        if (scenario === 'unrelated') assert.match(result.payload.content, /permission/);
        else assert.equal(result.kind, 'modal');
    }
});

test('edit pre-fills every field, makes no writes when opened or cancelled, and saves only editable details', async () => {
    const f = fixture({ task: { createdBy: 'alice', userId: 'bob', status: 'review', teamId: 'old-team', teamName: 'Original group', extraMetadata: 'keep me' } });
    const before = taskNow(f);
    const modal = await openEdit(f);
    const json = modal.toJSON();
    const values = Object.fromEntries(json.components.map(label => [label.component.custom_id, label.component.value || '']));
    assert.deepEqual(values, { title: before.title, description: before.description, priority: before.priority, due: before.dueDate, dependencies: '' });
    assert.deepEqual(taskNow(f), before);
    const result = await submitEdit(f, modal, { title: '  Updated title  ', description: 'New °C details\nSecond line.', priority: 'urgent', due: '2028-02-29' });
    assert.match(result.payload.content, /saved/);
    const after = taskNow(f);
    assert.equal(after.title, 'Updated title');
    assert.equal(after.description, 'New °C details\nSecond line.');
    assert.equal(after.priority, 'urgent');
    assert.equal(after.dueDate, '2028-02-29');
    for (const key of ['id', 'issueKey', 'createdBy', 'createdAt', 'userId', 'status', 'completed', 'teamId', 'teamName', 'extraMetadata']) assert.equal(after[key], before[key]);
    assert.notEqual(after.updatedAt, before.updatedAt);
    assert.ok(ids(result.payload).includes('kanban:edit:stable-task'));
});

test('editing can clear description and date; blank priority returns to medium', async () => {
    const f = fixture({ task: { userId: 'alice' } });
    const modal = await openEdit(f);
    await submitEdit(f, modal, { description: '', priority: '', due: '' });
    assert.equal(taskNow(f).description, '');
    assert.equal(taskNow(f).dueDate, null);
    assert.equal(taskNow(f).priority, 'medium');
});

for (const [values, expected] of [
    [{ title: '  ' }, /title/], [{ title: 'x'.repeat(201) }, /title/], [{ description: 'x'.repeat(2001) }, /description/],
    [{ priority: 'invalid' }, /priority/], [{ due: '2026-02-29' }, /real due date/], [{ due: '2026-13-01' }, /real due date/],
    [{ due: '2026-04-31' }, /real due date/], [{ due: 'October 8' }, /real due date/]
]) {
    test(`invalid edit ${Object.keys(values)[0]}=${Object.values(values)[0].slice(0, 25)} leaves stored details unchanged and offers retry`, async () => {
        const f = fixture({ task: { createdBy: 'alice' } });
        const before = taskNow(f);
        const result = await submitEdit(f, await openEdit(f), values);
        assert.match(result.payload.content, expected);
        assert.deepEqual(taskNow(f), before);
        assert.ok(ids(result.payload).includes('kanban:edit:stable-task'));
    });
}

test('editing existing longer text keeps it complete and does not silently truncate it', async () => {
    const f = fixture({ task: { createdBy: 'alice', title: 't'.repeat(300), description: 'd'.repeat(3000) } });
    const modal = await openEdit(f);
    await submitEdit(f, modal, { priority: 'low' });
    assert.equal(taskNow(f).title.length, 300);
    assert.equal(taskNow(f).description.length, 3000);
    assert.equal(taskNow(f).priority, 'low');
});

test('edit respects current ownership and role changes at submission', async () => {
    for (const scenario of ['assignee', 'manager', 'role']) {
        const f = fixture({ manager: scenario === 'manager', task: scenario === 'assignee' ? { userId: 'alice' } : scenario === 'role' ? { assignedToRole: 'engineering' } : {} });
        if (scenario === 'role') f.member.roles.cache.set('engineering', { id: 'engineering' });
        const modal = await openEdit(f);
        if (scenario === 'assignee') f.client.taskStorage.updateTask(f.guild.id, f.initial.id, { ...taskNow(f), userId: 'charlie' });
        else if (scenario === 'manager') f.member.permissions.remove(PermissionFlagsBits.ManageGuild);
        else f.member.roles.cache.clear();
        const before = taskNow(f);
        assert.match((await submitEdit(f, modal, { title: 'Denied' })).payload.content, /permission/);
        assert.deepEqual(taskNow(f), before);
    }
});

test('edit form owner, channel, and server checks prevent forged submissions', async () => {
    for (const options of [{ userId: 'mallory' }, { channelId: 'another-channel' }, { guildId: 'another-guild' }]) {
        const f = fixture({ task: { createdBy: 'alice' } });
        const modal = await openEdit(f);
        // A different guild is represented by a different actor, as in real interactions.
        const originalId = f.guild.id;
        if (options.guildId) f.guild.id = options.guildId;
        const result = await submitEdit(f, modal, { title: 'Forged' }, options);
        assert.match(result.payload.content, /Only the person/);
        f.guild.id = originalId;
        assert.deepEqual(taskNow(f), f.initial);
    }
});

test('expired, replayed, and pre-restart edit forms never overwrite tasks', async () => {
    for (const scenario of ['expired', 'replay', 'restart']) {
        const f = fixture({ task: { createdBy: 'alice' } });
        const modal = await openEdit(f);
        if (scenario === 'expired') [...f.client.taskEdits.values()][0].expiresAt = Date.now() - 1;
        else if (scenario === 'restart') delete f.client.taskEdits;
        else await submitEdit(f, modal, { title: 'Saved once' });
        const before = taskNow(f);
        assert.match((await submitEdit(f, modal, { title: 'Should not save' })).payload.content, /expired|already saved/);
        assert.deepEqual(taskNow(f), before);
    }
});

test('deleted task edit IDs never resolve to a replacement task', async () => {
    const f = fixture({ task: { createdBy: 'alice' } });
    const modal = await openEdit(f);
    f.client.taskStorage.deleteTask(f.guild.id, f.initial.id);
    f.client.taskStorage.addTask(f.guild.id, { ...f.initial, id: 'replacement' });
    assert.match((await submitEdit(f, modal, { title: 'Wrong task' })).payload.content, /no longer exists/);
    assert.equal(taskNow(f).title, f.initial.title);
    assert.match((await interact(f, 'kanban:edit:stable-task')).payload.content, /no longer exists/);
});

test('two editors cannot overwrite each other with stale details', async () => {
    const f = fixture({ manager: true, task: { createdBy: 'bob' } });
    const alice = await openEdit(f);
    f.members.set('bob', { pending: false, permissions: new PermissionsBitField(), roles: { cache: new Collection() } });
    const bob = await openEdit(f, { userId: 'bob' });
    const results = await Promise.all([submitEdit(f, alice, { title: 'Alice update' }), submitEdit(f, bob, { description: 'Bob update' }, { userId: 'bob' })]);
    assert.equal(results.filter(result => /details saved/.test(result.payload.content)).length, 1);
    assert.equal(results.filter(result => /changed while/.test(result.payload.content)).length, 1);
    assert.equal(taskNow(f).title, 'Alice update');
    assert.equal(taskNow(f).description, f.initial.description);
});

test('edit preserves intervening claim, status, team, and assignment changes', async () => {
    const f = fixture({ task: { createdBy: 'alice' } });
    const modal = await openEdit(f);
    await interact(f, 'kanban:start:stable-task', { userId: 'bob' });
    const team = getConfiguredTeams(f.actor)[1];
    await interact(f, 'kanban:team:stable-task', { type: 'select', values: [team.id] });
    await interact(f, 'kanban:status:stable-task', { type: 'select', values: ['review'] });
    await submitEdit(f, modal, { title: 'Details only' });
    const after = taskNow(f);
    assert.equal(after.userId, 'bob');
    assert.equal(after.assignedBy, 'bob');
    assert.equal(after.status, 'review');
    assert.equal(after.teamId, team.id);
    assert.equal(after.title, 'Details only');
});

test('failed edit storage writes do not change disk or cached task data', async () => {
    const f = fixture({ task: { createdBy: 'alice' } });
    const modal = await openEdit(f);
    const file = f.client.taskStorage.getFilePath(f.guild.id);
    const beforeBytes = fs.readFileSync(file, 'utf8');
    const originalDir = f.client.taskStorage.tasksDir;
    const originalError = console.error;
    try {
        console.error = () => {};
        f.client.taskStorage.tasksDir = '/dev/null/unwritable';
        assert.match((await submitEdit(f, modal, { title: 'Not saved' })).payload.content, /Failed to save/);
    } finally { console.error = originalError; f.client.taskStorage.tasksDir = originalDir; }
    assert.deepEqual(taskNow(f), f.initial);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeBytes);
});

test('claim, start, edit, status, team, done, reopen, and release form a complete member workflow', async () => {
    const f = fixture();
    const team = getConfiguredTeams(f.actor)[0];
    let page = (await interact(f, 'kanban:list:available:0', { privateMessage: false })).payload;
    assert.ok(controls(page).some(c => c.custom_id === 'kanban:select'));
    let detail = (await interact(f, 'kanban:select', { type: 'select', values: [f.initial.id] })).payload;
    assert.ok(ids(detail).includes('kanban:claim:stable-task'));
    assert.ok(!ids(detail).includes('kanban:edit:stable-task'));
    detail = (await interact(f, 'kanban:claim:stable-task')).payload;
    assert.equal(taskNow(f).userId, 'alice');
    assert.ok(!ids(detail).includes('kanban:claim:stable-task'));
    await interact(f, 'kanban:start:stable-task');
    assert.equal(getTaskStatus(taskNow(f)), 'progress');
    await submitEdit(f, await openEdit(f), { description: 'New acceptance criteria' });
    await interact(f, 'kanban:team:stable-task', { type: 'select', values: [team.id] });
    assert.equal(taskNow(f).teamId, team.id);
    for (const status of ['review', 'done', 'todo']) {
        await interact(f, 'kanban:status:stable-task', { type: 'select', values: [status] });
        assert.equal(getTaskStatus(taskNow(f)), status);
        page = (await interact(f, 'kanban:list:mine:0')).payload;
        assert.match(page.content, status === 'done' ? /0 task/ : /1 task/);
    }
    detail = (await interact(f, 'kanban:details:stable-task')).payload;
    assert.ok(detail.embeds[0].toJSON().description.includes('New acceptance criteria'));
    await interact(f, 'kanban:team:stable-task', { type: 'select', values: ['none'] });
    assert.equal(taskNow(f).teamId, null);
    await interact(f, 'kanban:release:stable-task');
    assert.equal(taskNow(f).userId, null);
    assert.equal(getTaskStatus(taskNow(f)), 'todo');
});

test('read-only viewers see no unavailable task actions and forged mutation clicks are denied', async () => {
    const f = fixture({ task: { userId: 'bob' } });
    const before = taskNow(f);
    assert.deepEqual(controls({ components: buildIssueComponents(before, f.actor) }).map(c => c.label), ['Refresh', 'My Tasks']);
    for (const action of ['claim', 'start', 'release', 'edit', 'status', 'team']) {
        const result = await interact(f, `kanban:${action}:stable-task`, { type: ['status', 'team'].includes(action) ? 'select' : 'button', values: [action === 'team' ? 'none' : 'done'] });
        assert.match(result.payload.content, /permission|already claimed|only release/);
        assert.deepEqual(taskNow(f), before);
    }
});

test('pagination navigates every page for all filters, keeps team selection, and handles empty and stale pages', async () => {
    const f = fixture({ task: { createdBy: 'alice' } });
    const team = getConfiguredTeams(f.actor)[0];
    const tasks = Array.from({ length: 73 }, (_, i) => ({ ...f.initial, id: `task-${i}`, issueKey: `RC-${i + 1}`, userId: i % 2 ? 'alice' : null, teamId: team.id, teamName: team.name }));
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    for (const [filter, count] of [['available', 37], ['mine', 36], ['all', 73], ['teams', 73]]) {
        let result = await interact(f, filter === 'teams' ? 'kanban:teamview' : `kanban:list:${filter}:0`, { type: filter === 'teams' ? 'select' : 'button', values: [team.id] });
        const seen = [];
        for (let page = 0; page < Math.ceil(count / pageSize); page++) {
            seen.push(...controls(result.payload).find(c => c.custom_id === 'kanban:select').options.map(option => option.value));
            const next = controls(result.payload).find(c => c.label === 'Next');
            assert.equal(next.disabled, page === Math.ceil(count / pageSize) - 1);
            if (!next.disabled) result = await interact(f, next.custom_id);
        }
        assert.equal(new Set(seen).size, count);
        const previous = controls(result.payload).find(c => c.label === 'Previous');
        result = await interact(f, previous.custom_id);
        if (filter === 'teams') assert.match(result.payload.content, /Cubesat/);
        assert.match(result.payload.content, /Page/);
    }
    f.client.taskStorage.saveTasks(f.guild.id, []);
    assert.match((await interact(f, 'kanban:page:all:99')).payload.content, /0 task/);
    assert.match((await interact(f, 'kanban:teamview', { type: 'select', values: ['removed-team'] })).payload.content, /Choose a group/);
    assert.match((await interact(f, 'kanban:teamlist:99')).payload.content, /Choose a group/);
});

test('Open Tasks privately browses every page of one tag, including completed and assigned tasks', async () => {
    const f = fixture();
    const tasks = Array.from({ length: 37 }, (_, i) => ({ ...f.initial, id: `tag-task-${i}`, issueKey: `RC-${i + 1}`, title: `[${i < 27 ? 'POWER' : 'STM32'}] Task ${i}`, status: i % 3 ? 'todo' : 'done', completed: i % 3 === 0, userId: i % 2 ? 'bob' : null }));
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    const tagId = getTaskTag(tasks[0]).id;
    let result = await interact(f, `kanban:list:tag:0:${tagId}`, { privateMessage: false });
    assert.equal(result.responses[0][1].flags, MessageFlags.Ephemeral);
    const seen = [];
    for (let page = 0; page < 3; page++) {
        assert.match(result.payload.content, /Tasks: POWER/);
        const select = controls(result.payload).find(c => c.custom_id === 'kanban:select');
        seen.push(...select.options.map(option => option.value));
        const next = controls(result.payload).find(c => c.label === 'Next');
        assert.equal(next.disabled, page === 2);
        assert.ok(next.custom_id.endsWith(':' + tagId));
        if (!next.disabled) result = await interact(f, next.custom_id);
    }
    assert.deepEqual(new Set(seen), new Set(tasks.slice(0, 27).map(task => task.id)));
    const previous = controls(result.payload).find(c => c.label === 'Previous');
    assert.ok(previous.custom_id.endsWith(':' + tagId));
    result = await interact(f, previous.custom_id);
    assert.match(result.payload.content, /Page 2\/3/);
    const detail = await interact(f, 'kanban:select', { type: 'select', values: ['tag-task-2'] });
    assert.ok(ids(detail.payload).includes('kanban:claim:tag-task-2'));
    await interact(f, 'kanban:claim:tag-task-2');
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).find(task => task.id === 'tag-task-2').userId, 'alice');
    f.client.taskStorage.saveTasks(f.guild.id, tasks.filter(task => getTaskTag(task).id !== tagId));
    result = await interact(f, previous.custom_id);
    assert.match(result.payload.content, /tag no longer has tasks/);
    assert.ok(ids(result.payload).includes('kanban:list:all:0'));
});

test('adding and editing a title prefix moves its group while keeping team, owner, and status', async () => {
    const f = fixture({ task: { createdBy: 'alice', title: '[POWER] Battery test', userId: 'alice', status: 'progress' } });
    const team = getConfiguredTeams(f.actor)[0];
    await interact(f, 'kanban:team:stable-task', { type: 'select', values: [team.id] });
    const before = taskNow(f);
    const oldTag = getTaskTag(before).id;
    await submitEdit(f, await openEdit(f), { title: '[TEST] Battery cold test' });
    const saved = taskNow(f);
    assert.equal(getTaskTag(saved).name, 'TEST');
    for (const field of ['teamId', 'teamName', 'userId', 'status', 'issueKey', 'id']) assert.equal(saved[field], before[field]);
    assert.match((await interact(f, `kanban:list:tag:0:${oldTag}`)).payload.content, /tag no longer has tasks/);
    assert.match((await interact(f, `kanban:list:tag:0:${getTaskTag(saved).id}`)).payload.content, /Tasks: TEST/);
    const modal = (await interact(f, 'kanban:add')).payload;
    assert.match(modal.toJSON().components[0].label, /\[TAG\]/);
    await interact(f, modal.toJSON().custom_id, { type: 'modal', fields: modalFields(modal, { title: '[POWER] New battery task', description: '', priority: 'high', due: '2026-10-16', team: team.id }) });
    const added = f.client.taskStorage.getAllTasks(f.guild.id).find(task => task.id !== saved.id);
    assert.equal(getTaskTag(added).name, 'POWER');
    assert.equal(added.teamId, team.id);
    assert.equal(added.userId, null);
    assert.equal(getTaskStatus(added), 'todo');
    assert.match((await interact(f, `kanban:list:tag:0:${oldTag}`)).payload.content, /Tasks: POWER/);
});

function addPrerequisites(f, count = 2) {
    const prerequisites = Array.from({ length: count }, (_, i) => ({ ...f.initial, id: `prerequisite-${i}`, issueKey: `RC-${i + 2}`, title: `[POWER] Prerequisite ${i}`, createdBy: 'alice', userId: null, status: 'todo', completed: false, dependsOn: [] }));
    f.client.taskStorage.saveTasks(f.guild.id, [taskNow(f), ...prerequisites]);
    return prerequisites;
}

test('admin sets multiple prerequisites in Edit Task and each must finish before a task unlocks', async () => {
    const f = fixture({ manager: true, task: { title: '[TEST] Final payload test' } });
    const prerequisites = addPrerequisites(f);
    const result = await submitEdit(f, await openEdit(f), { dependencies: 'RC-2, rc-3' });
    assert.match(result.payload.content, /saved/);
    assert.deepEqual(taskNow(f).dependsOn, prerequisites.map(task => task.id));
    assert.ok(result.payload.embeds[0].toJSON().fields.some(field => field.name.includes('Blocked by') && field.value.includes('RC-2') && field.value.includes('RC-3')));
    assert.ok(!ids(result.payload).includes('kanban:claim:stable-task'));
    assert.ok(!ids(result.payload).includes('kanban:start:stable-task'));
    const statuses = controls(result.payload).find(control => control.custom_id === 'kanban:status:stable-task');
    assert.deepEqual(statuses.options.map(option => option.value), ['todo']);
    const reopened = await openEdit(f);
    assert.equal(reopened.toJSON().components.find(label => label.component.custom_id === 'dependencies').component.value, 'RC-2, RC-3');
    let blocked = await interact(f, 'kanban:list:blocked:0', { privateMessage: false });
    assert.equal(blocked.responses[0][1].flags, MessageFlags.Ephemeral);
    assert.deepEqual(controls(blocked.payload).find(c => c.custom_id === 'kanban:select').options.map(option => option.value), ['stable-task']);
    await interact(f, `kanban:status:${prerequisites[0].id}`, { type: 'select', values: ['done'] });
    assert.match((await interact(f, 'kanban:list:blocked:0')).payload.content, /1 task/);
    await interact(f, `kanban:status:${prerequisites[1].id}`, { type: 'select', values: ['done'] });
    assert.match((await interact(f, 'kanban:list:blocked:0')).payload.content, /0 task/);
    const member = f.members.get('alice');
    member.permissions.remove(PermissionFlagsBits.ManageGuild);
    const available = await interact(f, 'kanban:list:available:0');
    assert.deepEqual(controls(available.payload).find(c => c.custom_id === 'kanban:select').options.map(option => option.value), ['stable-task']);
    await interact(f, 'kanban:start:stable-task');
    assert.equal(taskNow(f).userId, 'alice');
    assert.equal(getTaskStatus(taskNow(f)), 'progress');
    assert.deepEqual(taskNow(f).dependsOn, prerequisites.map(task => task.id));
});

test('members never see blocked work in any list, details, edit form, or stale action', async () => {
    const f = fixture({ task: { createdBy: 'alice', userId: 'alice', title: '[TEST] Hidden target' } });
    const prerequisites = addPrerequisites(f, 1);
    const team = getConfiguredTeams(f.actor)[0];
    f.client.taskStorage.updateTask(f.guild.id, f.initial.id, { ...taskNow(f), teamId: team.id, teamName: team.name, dependsOn: [prerequisites[0].id] });
    const before = taskNow(f);
    for (const filter of ['available', 'mine', 'all', 'teams', 'tag']) {
        const groupId = filter === 'teams' ? team.id : filter === 'tag' ? getTaskTag(before).id : null;
        const result = await interact(f, `kanban:list:${filter}:0${groupId ? ':' + groupId : ''}`, { privateMessage: false });
        assert.ok(!JSON.stringify(result.payload).includes('Hidden target'));
        assert.ok(!controls(result.payload).some(c => c.options?.some(option => option.value === before.id)));
    }
    assert.match((await interact(f, 'kanban:list:blocked:0')).payload.content, /Only server managers/);
    assert.match((await interact(f, 'kanban:page:blocked:1')).payload.content, /Only server managers/);
    for (const action of ['details', 'claim', 'start', 'release', 'edit', 'status', 'team']) {
        const result = await interact(f, `kanban:${action}:stable-task`, { type: ['status', 'team'].includes(action) ? 'select' : 'button', values: [action === 'team' ? 'none' : 'done'] });
        assert.match(result.payload.content, /blocked/);
        assert.ok(!JSON.stringify(result.payload).includes('Hidden target'));
        assert.deepEqual(taskNow(f), before);
    }
    assert.match((await interact(f, 'kanban:select', { type: 'select', values: [before.id] })).payload.content, /blocked/);
    const replies = [];
    for (const args of [['details', 'RC-1'], ['done', 'RC-1'], ['depends', 'RC-1', 'none']]) await board.execute({ ...f.actor, reply: async payload => replies.push(payload), channel: { send: async () => assert.fail('blocked task must not be posted publicly') } }, args);
    assert.ok(replies.every(reply => /could not find/.test(reply)));
    assert.deepEqual(taskNow(f), before);
});

test('admins cannot bypass prerequisites through stale buttons or commands, and can clear them', async () => {
    const f = fixture({ manager: true });
    addPrerequisites(f, 1);
    await submitEdit(f, await openEdit(f), { dependencies: 'RC-2' });
    const before = taskNow(f);
    for (const [action, options] of [['claim', {}], ['start', {}], ['status', { type: 'select', values: ['progress'] }], ['status', { type: 'select', values: ['review'] }], ['status', { type: 'select', values: ['done'] }]]) {
        assert.match((await interact(f, `kanban:${action}:stable-task`, options)).payload.content, /blocked by/);
        assert.deepEqual(taskNow(f), before);
    }
    const replies = [];
    const message = { ...f.actor, reply: async payload => replies.push(payload), channel: { send: async () => assert.fail('blocked details must stay private') } };
    for (const args of [['claim', 'RC-1'], ['start', 'RC-1'], ['done', 'RC-1'], ['move', 'RC-1', 'review']]) {
        await board.execute(message, args);
        assert.match(replies.at(-1), /blocked by/);
        assert.deepEqual(taskNow(f), before);
    }
    await board.execute(message, ['details', 'RC-1']);
    assert.match(replies.at(-1), /privately/);
    await submitEdit(f, await openEdit(f), { dependencies: '' });
    assert.deepEqual(taskNow(f).dependsOn, []);
    await interact(f, 'kanban:start:stable-task');
    assert.equal(getTaskStatus(taskNow(f)), 'progress');
});

test('invalid dependency edits preserve data and reject cycles, self references, unknown keys, and foreign keys', async () => {
    for (const [input, expected] of [['RC-1', /itself/], ['RC-999', /this server/], ['FOREIGN-1', /this server/], ['RC-2', /circular/]]) {
        const f = fixture({ manager: true });
        const [prerequisite] = addPrerequisites(f, 1);
        f.client.taskStorage.updateTask(f.guild.id, prerequisite.id, { ...prerequisite, dependsOn: [f.initial.id] });
        const before = taskNow(f);
        assert.match((await submitEdit(f, await openEdit(f), { dependencies: input })).payload.content, expected);
        assert.deepEqual(taskNow(f), before);
    }
});

test('dependency changes conflict with stale edits, while old forms preserve unchanged dependencies', async () => {
    const f = fixture({ manager: true });
    addPrerequisites(f, 1);
    const stale = await openEdit(f);
    const replies = [];
    await board.execute({ ...f.actor, reply: async payload => replies.push(payload) }, ['depends', 'RC-1', 'RC-2']);
    assert.match(replies.at(-1), /Prerequisites saved/);
    assert.match((await submitEdit(f, stale, { title: 'Stale title' })).payload.content, /changed while/);
    assert.equal(taskNow(f).title, f.initial.title);
    const fresh = await openEdit(f);
    const fields = modalFields(fresh, { title: 'Old form preserves requirements' });
    fields.fields.delete('dependencies');
    assert.match((await interact(f, fresh.toJSON().custom_id, { type: 'modal', fields })).payload.content, /saved/);
    assert.deepEqual(taskNow(f).dependsOn, ['prerequisite-0']);
});

test('blocked-task pagination remains private, handles deletion, and blocks a demoted admin', async () => {
    const f = fixture({ manager: true });
    const tasks = Array.from({ length: 27 }, (_, i) => ({ ...f.initial, id: `waiting-${i}`, issueKey: `RC-${i + 1}`, title: `Waiting task ${i}`, dependsOn: ['missing-task'] }));
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    let result = await interact(f, 'kanban:list:blocked:0', { privateMessage: false });
    const seen = [];
    for (let page = 0; page < 3; page++) {
        assert.match(result.payload.embeds[0].toJSON().fields[0].value, /Deleted task missing-task/);
        seen.push(...controls(result.payload).find(c => c.custom_id === 'kanban:select').options.map(option => option.value));
        const next = controls(result.payload).find(c => c.label === 'Next');
        assert.equal(next.disabled, page === 2);
        if (!next.disabled) result = await interact(f, next.custom_id);
    }
    assert.equal(new Set(seen).size, 27);
    const previous = controls(result.payload).find(c => c.label === 'Previous').custom_id;
    const modal = (await interact(f, 'kanban:edit:waiting-0')).payload;
    f.member.permissions.remove(PermissionFlagsBits.ManageGuild);
    assert.match((await interact(f, previous)).payload.content, /Only server managers/);
    assert.match((await submitEdit(f, modal, { dependencies: '' })).payload.content, /blocked/);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), tasks);
});

test('a member can add prerequisites to their task; the saved blocked task disappears from their view', async () => {
    const f = fixture({ task: { createdBy: 'alice', title: 'Hide after setting prerequisites' } });
    addPrerequisites(f, 1);
    const result = await submitEdit(f, await openEdit(f), { dependencies: 'RC-2' });
    assert.match(result.payload.content, /Task saved.*every prerequisite/);
    assert.equal(result.payload.embeds.length, 0);
    assert.ok(!JSON.stringify(result.payload).includes('Hide after setting prerequisites'));
    assert.deepEqual(taskNow(f).dependsOn, ['prerequisite-0']);
    assert.match((await interact(f, 'kanban:edit:stable-task')).payload.content, /Only server managers/);
});

test('concurrent prerequisite edits cannot create a cycle and saved dependencies survive a storage reload', async () => {
    const f = fixture({ manager: true });
    const [other] = addPrerequisites(f, 1);
    const firstModal = await openEdit(f);
    const secondModal = (await interact(f, `kanban:edit:${other.id}`)).payload;
    const results = await Promise.all([submitEdit(f, firstModal, { dependencies: 'RC-2' }), submitEdit(f, secondModal, { dependencies: 'RC-1' })]);
    assert.equal(results.filter(result => /saved/.test(result.payload.content)).length, 1);
    assert.equal(results.filter(result => /circular/.test(result.payload.content)).length, 1);
    const tasksDir = f.client.taskStorage.tasksDir;
    f.client.taskStorage = new TaskStorage(tasksDir);
    assert.deepEqual(taskNow(f).dependsOn, [other.id]);
    assert.match((await interact(f, 'kanban:list:blocked:0')).payload.content, /1 task/);
    await interact(f, `kanban:status:${other.id}`, { type: 'select', values: ['done'] });
    assert.match((await interact(f, 'kanban:list:blocked:0')).payload.content, /0 task/);
});

test('maximum prerequisite forms and task views fit the native modal and message limits', async () => {
    const f = fixture({ manager: true, task: { title: '*'.repeat(200), description: 'd'.repeat(2000) } });
    const prerequisites = addPrerequisites(f, 20).map(task => ({ ...task, issueKey: 'KEY' + task.id.padEnd(76, 'x') }));
    f.client.taskStorage.saveTasks(f.guild.id, [taskNow(f), ...prerequisites]);
    const input = prerequisites.map(task => task.issueKey).join(', ');
    const result = await submitEdit(f, await openEdit(f), { dependencies: input });
    assert.match(result.payload.content, /saved/);
    assert.equal(taskNow(f).dependsOn.length, 20);
    const modal = await openEdit(f);
    assert.equal(modal.toJSON().components.find(label => label.component.custom_id === 'dependencies').component.value, input);
    const detail = await interact(f, 'kanban:details:stable-task');
    assert.equal(detail.payload.embeds[0].toJSON().fields.filter(field => /Blocked by|Prerequisites continued/.test(field.name)).length, 2);
    await interact(f, 'kanban:list:blocked:0');
});

test('public text-command lists exclude blocked work even when a manager runs them', async () => {
    const f = fixture({ manager: true, task: { userId: 'alice', title: 'Private blocked work' } });
    const [prerequisite] = addPrerequisites(f, 1);
    const team = getConfiguredTeams(f.actor)[0];
    f.client.taskStorage.updateTask(f.guild.id, f.initial.id, { ...taskNow(f), teamId: team.id, teamName: team.name, dependsOn: [prerequisite.id] });
    const responses = [];
    // Real Discord Messages expose properties through getters rather than spreadable keys.
    const message = { channel: { send: async payload => { validateMessage(payload); responses.push(payload); } }, reply: async payload => responses.push(payload) };
    for (const [key, value] of Object.entries(f.actor)) Object.defineProperty(message, key, { get: () => value });
    for (const args of [['mine'], ['available'], ['teamtasks']]) await board.execute(message, args);
    await teamsCommand.execute(message, []);
    assert.ok(responses.every(payload => !JSON.stringify(payload).includes('Private blocked work')));
    for (const payload of responses.slice(-2)) {
        const option = controls(payload).find(c => c.custom_id === 'kanban:teamview').options.find(option => option.value === team.id);
        assert.equal(option.description, '0 active task(s)');
    }
});

test('all entry points and edit submissions obey verification, guild, and channel restrictions', async () => {
    for (const entry of ['kanban:more', 'kanban:add', 'kanban:import', 'kanban:edit:stable-task', 'kanban:teamsetup:edit', 'kanban:list:available:0']) {
        const f = fixture({ manager: true, task: { createdBy: 'alice' } });
        f.member.pending = true;
        assert.match((await interact(f, entry)).payload.content, /verification/);
        f.member.pending = false;
        f.client.pendingVerifications.set(`${f.guild.id}:alice`, {});
        assert.match((await interact(f, entry)).payload.content, /verification/);
        f.client.pendingVerifications.clear();
        f.client.serverConfigs[f.guild.id].allowedChannelIds = ['other-channel'];
        assert.match((await interact(f, entry)).payload.content, /disabled/);
        f.client.serverConfigs[f.guild.id].allowedChannelIds = [];
        assert.match((await interact(f, entry, { inGuild: false })).payload.content, /in a server/);
        assert.deepEqual(taskNow(f), f.initial);
    }
    const f = fixture({ task: { createdBy: 'alice' } });
    const modal = await openEdit(f);
    f.member.pending = true;
    assert.match((await submitEdit(f, modal, { title: 'Not saved' })).payload.content, /verification/);
    f.member.pending = false;
    f.client.serverConfigs[f.guild.id].allowedChannelIds = ['other-channel'];
    assert.match((await submitEdit(f, modal, { title: 'Not saved' })).payload.content, /disabled/);
    assert.deepEqual(taskNow(f), f.initial);
});

test('modals respond without waiting for member fetch; role IDs in API member data allow authorized edit', async () => {
    const f = fixture({ manager: true, task: { assignedToRole: 'engineering' } });
    f.guild.members.fetch = async () => { throw new Error('A modal must not wait for a fetch'); };
    for (const action of ['kanban:add', 'kanban:import', 'kanban:teamsetup:edit', 'kanban:edit:stable-task']) assert.equal((await interact(f, action)).kind, 'modal');
    const apiMember = { permissions: new PermissionsBitField(), roles: ['engineering'], pending: false };
    assert.equal((await interact(f, 'kanban:edit:stable-task', { member: apiMember })).kind, 'modal');
});

test('all rendered states and forms fit Discord limits with maximum teams and task lengths', () => {
    for (const manager of [false, true]) {
        const f = fixture({ manager });
        assert.equal(saveTeams(f.actor, Array.from({ length: 24 }, (_, i) => `${i}${'*'.repeat(48)}`)), null);
        const tasks = Array.from({ length: 73 }, (_, i) => ({ ...f.initial, id: String(i), title: 't'.repeat(200), description: 'd'.repeat(2000), teamId: getConfiguredTeams(f.actor)[0].id, teamName: getConfiguredTeams(f.actor)[0].name }));
        for (const payload of [{ components: buildBoardComponents() }, buildMoreMenu(f.actor), buildTeamSetup(f.actor), buildTeamPicker(tasks, f.actor)]) validateMessage(payload);
        for (const filter of ['available', 'mine', 'all', 'teams']) for (let page = 0; page < 8; page++) validateMessage(buildTaskPicker(tasks, filter, page, f.actor, filter === 'teams' ? tasks[0].teamId : null));
        for (const userId of [null, 'alice', 'bob']) for (const status of ['todo', 'progress', 'review', 'done']) {
            const task = { ...tasks[0], userId, status, completed: status === 'done', createdBy: userId === null ? 'alice' : 'bob' };
            validateMessage({ embeds: [board.buildIssueEmbed(task, 0, f.actor)], components: buildIssueComponents(task, f.actor) });
        }
        for (const modal of [buildAddModal(getConfiguredTeams(f.actor)), buildEditModal(tasks[0], 'draft-id'), buildTeamSetupModal(f.actor), buildImportModal()]) validateModal(modal);
        const teamOption = buildAddModal(getConfiguredTeams(f.actor)).toJSON().components[4].component.options[1];
        assert.equal(teamOption.description, getConfiguredTeams(f.actor)[0].name);
    }
});

test('unknown and foreign component actions are acknowledged safely without changing tasks', async () => {
    const f = fixture();
    const foreign = await interact(f, 'other:button');
    assert.equal(foreign.handled, false);
    assert.equal(foreign.responses.length, 0);
    assert.match((await interact(f, 'kanban:unknown:stable-task')).payload.content, /Unknown board action/);
    assert.deepEqual(taskNow(f), f.initial);
});

test('live board setup and task writes refresh the common buttons and preserve edits across storage reload', async () => {
    const f = fixture({ manager: true });
    const updates = [];
    const liveMessage = { id: 'live-board', edit: async payload => { validateMessage(payload); updates.push(payload); } };
    const channel = { id: f.actor.channelId, send: async payload => { validateMessage(payload); updates.push(payload); return liveMessage; }, messages: { fetch: async id => { assert.equal(id, liveMessage.id); return liveMessage; } } };
    f.client.channels = { fetch: async id => { assert.equal(id, channel.id); return channel; } };
    const message = { ...f.actor, channel, reply: async () => {} };
    await board.execute(message, ['setup']);
    let pending;
    f.client.taskStorage.setUpdateListener(guildId => pending = board.updateBoard(f.client, guildId));
    await interact(f, 'kanban:start:stable-task');
    await pending;
    await submitEdit(f, await openEdit(f), { title: 'Visible edited title' });
    await pending;
    assert.equal(updates.length, 3);
    assert.ok(updates.at(-1).embeds[0].toJSON().fields.some(field => field.name.includes('Visible edited title')));
    for (const payload of updates) assert.deepEqual(controls(payload).map(c => c.label), ['Open Tasks', 'Add Task', 'My Tasks', 'Team Tasks', 'More']);
    const reload = new TaskStorage(f.client.taskStorage.tasksDir).getAllTasks(f.guild.id)[0];
    assert.equal(reload.title, 'Visible edited title');
    assert.equal(reload.userId, 'alice');
    assert.equal(reload.status, 'progress');
    await interact(f, 'kanban:refresh', { privateMessage: false });
    assert.equal(updates.length, 4);
    await board.execute(message, ['board']);
    await board.execute(message, ['commands']);
});

test('fresh member fetch catches verification and permission changes after an interaction was created', async () => {
    const f = fixture({ manager: true });
    const updatedMember = { pending: true, permissions: new PermissionsBitField(), roles: { cache: new Collection() } };
    f.guild.members.fetch = async options => {
        assert.deepEqual(options, { user: 'alice', force: true });
        return updatedMember;
    };
    assert.match((await interact(f, 'kanban:more')).payload.content, /verification/);
    updatedMember.pending = false;
    const menu = (await interact(f, 'kanban:more')).payload;
    assert.ok(!ids(menu).includes('kanban:import'));
    assert.match((await interact(f, 'kanban:importconfirm:any')).payload.content, /Manage Server/);
});

test('invalid Add Task values and failed saves leave existing tasks unchanged', async () => {
    const f = fixture();
    const modal = (await interact(f, 'kanban:add')).payload;
    for (const [values, expected] of [
        [{ title: '' }, /title/], [{ title: 'x'.repeat(201) }, /title/], [{ description: 'x'.repeat(2001) }, /description/],
        [{ priority: 'invalid' }, /priority/], [{ team: 'deleted-team' }, /no longer set up/]
    ]) {
        const result = await interact(f, modal.toJSON().custom_id, { type: 'modal', fields: modalFields(modal, { title: 'New task', ...values }) });
        assert.match(result.payload.content, expected);
        assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.initial]);
    }
    const originalAdd = f.client.taskStorage.addTask;
    f.client.taskStorage.addTask = () => false;
    assert.match((await interact(f, modal.toJSON().custom_id, { type: 'modal', fields: modalFields(modal, { title: 'Will fail' }) })).payload.content, /Failed to save/);
    f.client.taskStorage.addTask = originalAdd;
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.initial]);
});

test('invalid status and removed-team changes fail without touching task state', async () => {
    const f = fixture({ task: { createdBy: 'alice' } });
    for (const [action, value, expected] of [['status', 'invalid', /valid task status/], ['team', 'deleted-team', /no longer set up/], ['team', undefined, /Choose a team/]]) {
        assert.match((await interact(f, `kanban:${action}:stable-task`, { type: 'select', values: value ? [value] : [] })).payload.content, expected);
        assert.deepEqual(taskNow(f), f.initial);
    }
});

test('task forms reject unrepresentable legacy text clearly, and newer edit forms replace older forms', async () => {
    const f = fixture({ task: { createdBy: 'alice', description: 'x'.repeat(4001) } });
    assert.match((await interact(f, 'kanban:edit:stable-task')).payload.content, /longer than the edit form/);
    assert.equal(f.client.taskEdits, undefined);
    f.client.taskStorage.updateTask(f.guild.id, f.initial.id, { ...taskNow(f), description: 'Fits now' });
    const older = await openEdit(f);
    const newer = await openEdit(f);
    assert.equal(f.client.taskEdits.size, 1);
    assert.match((await submitEdit(f, older, { title: 'Stale' })).payload.content, /expired/);
    await submitEdit(f, newer, { title: 'Newest form' });
    assert.equal(taskNow(f).title, 'Newest form');
});

test('imports handle preview navigation, removed teams, and storage failure retries through the buttons', async () => {
    const f = fixture({ manager: true });
    const source = Array.from({ length: 12 }, (_, i) => `Title: Import ${i}\nTeam: Cubesat`).join('\n\n');
    const draft = prepareImport(f.actor, source).draft;
    const page = (await interact(f, `kanban:importpage:${draft.id}:1`)).payload;
    assert.match(page.embeds[0].toJSON().footer.text, /Page 2/);
    assert.equal(saveTeams(f.actor, ['Software']), null);
    assert.match((await interact(f, `kanban:importconfirm:${draft.id}`)).payload.content, /removed/);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.initial]);
    assert.equal(saveTeams(f.actor, ['Cubesat', 'Software']), null);
    const retry = prepareImport(f.actor, source).draft;
    const originalSave = f.client.taskStorage.saveTasks;
    f.client.taskStorage.saveTasks = () => false;
    assert.match((await interact(f, `kanban:importconfirm:${retry.id}`)).payload.content, /Failed to save/);
    f.client.taskStorage.saveTasks = originalSave;
    await interact(f, `kanban:importconfirm:${retry.id}`);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 13);
});
