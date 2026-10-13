const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection, MessageFlags, PermissionsBitField, PermissionFlagsBits, ModalSubmitFields, ModalSubmitInteraction } = require('discord.js');

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-tasks-'));
process.env.BOT_DATA_DIR = temporaryDir;
const TaskStorage = require('../taskStorage');
const board = require('../commands/board');
const { handleBoardInteraction } = require('../utils/boardInteractions');
const { buildBoardComponents, buildTaskModal } = require('../utils/boardComponents');
const { renderBoard } = require('../utils/boardDisplay');
const { getTaskStatus } = require('../utils/kanban');
const { parseTaskList, prepareImport } = require('../utils/taskImport');
const { parseMessageCommand } = require('../utils/commandRouter');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
let sequence = 0;

function fixture({ task = {} } = {}) {
    const guild = { id: `guild-${++sequence}`, name: 'Rocket Club', roles: { cache: new Collection() } };
    const client = { taskStorage: new TaskStorage(path.join(temporaryDir, guild.id)), serverConfigs: {}, guilds: { cache: new Collection([[guild.id, guild]]) } };
    const initial = { id: 'task-1', issueKey: 'RC-1', title: '[POWER] Check battery', description: 'Details', status: 'todo', completed: false, createdBy: 'bob', createdAt: '2026-10-01T00:00:00Z', userId: null, ...task };
    client.taskStorage.addTask(guild.id, initial);
    return { client, guild, initial, task: () => client.taskStorage.getAllTasks(guild.id).find(item => item.id === initial.id) };
}

const json = payload => (payload.components || []).map(row => row.toJSON ? row.toJSON() : row);
const labels = payload => json(payload).flatMap(row => row.components).map(c => c.label).filter(Boolean);

function validateMessage(payload) {
    assert.ok((payload.content || '').length <= 2000);
    const rows = json(payload);
    assert.ok(rows.length <= 5);
    const ids = rows.flatMap(row => row.components).map(c => c.custom_id);
    assert.equal(new Set(ids).size, ids.length, `duplicate custom IDs: ${ids}`);
    let chars = 0;
    for (const builder of payload.embeds || []) {
        const embed = builder.toJSON ? builder.toJSON() : builder;
        assert.ok((embed.title || '').length <= 256 && (embed.description || '').length <= 4096);
        chars += (embed.title || '').length + (embed.description || '').length + (embed.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    }
    assert.ok(chars <= 6000);
    for (const option of rows.flatMap(row => row.components).flatMap(c => c.options || [])) assert.ok(option.label.length <= 100);
}

async function interact(f, customId, { type = 'button', values = [], fields, userId = 'alice', manager = false, privateMessage = true } = {}) {
    const responses = [];
    const permissions = new PermissionsBitField(manager ? [PermissionFlagsBits.ManageGuild] : []);
    const interaction = {
        customId, guildId: f.guild.id, guild: f.guild, client: f.client, channelId: 'channel', user: { id: userId },
        member: { pending: false, permissions }, memberPermissions: permissions, values, fields,
        message: { flags: { has: flag => privateMessage && flag === MessageFlags.Ephemeral } },
        inGuild: () => true, isButton: () => type === 'button', isStringSelectMenu: () => type === 'select', isModalSubmit: () => type === 'modal',
        reply: async payload => { validateMessage(payload); responses.push(['reply', payload]); },
        editReply: async payload => { validateMessage(payload); responses.push(['editReply', payload]); },
        deferReply: async () => responses.push(['deferReply']), deferUpdate: async () => responses.push(['deferUpdate']),
        showModal: async modal => responses.push(['modal', modal])
    };
    assert.equal(await handleBoardInteraction(interaction), true);
    assert.equal(responses.filter(([name]) => ['reply', 'deferReply', 'deferUpdate', 'modal'].includes(name)).length, 1, 'acknowledge exactly once');
    return { kind: responses.at(-1)[0], payload: responses.at(-1)[1] };
}

function modalFields(modal, values) {
    return new ModalSubmitFields(modal.toJSON().components.map(label => ModalSubmitInteraction.transformComponent({
        ...label, component: { ...label.component, value: values[label.component.custom_id] ?? label.component.value ?? '' }
    }, {})));
}

test('the shared board has three buttons and lists open work grouped by tag', () => {
    assert.deepEqual(labels({ components: buildBoardComponents() }), ['Find Work', 'My Tasks', 'Add Task']);
    const tasks = [
        { id: 'a', issueKey: 'RC-1', title: '[POWER] Battery', status: 'todo' },
        { id: 'b', issueKey: 'RC-2', title: '[STM32] Pin map', status: 'progress', userId: 'alice' },
        { id: 'c', issueKey: 'RC-3', title: 'Old review task', status: 'review' },
        { id: 'd', issueKey: 'RC-4', title: 'Shipped already', status: 'done', completed: true }
    ];
    const [payload, ...rest] = renderBoard(tasks, 'Board');
    assert.equal(rest.length, 0);
    const text = payload.embeds[0].toJSON().description;
    assert.match(text, /To Do: \*\*1\*\* · 🔧 In Progress: \*\*2\*\* · ✅ Done: \*\*1\*\*/);
    assert.match(text, /__POWER__\n`RC-1` Battery/);
    assert.match(text, /`RC-2` \[STM32\] Pin map — <@alice>/);
    assert.doesNotMatch(text, /Shipped already/);
});

test('large boards split across messages within Discord limits and keep every open task', () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, issueKey: `RC-${i}`, title: `[TAG${i % 7}] ${'x'.repeat(150)} ${i}`, status: 'todo' }));
    const payloads = renderBoard(tasks, 'Board');
    assert.ok(payloads.length > 1);
    payloads.forEach(validateMessage);
    const all = payloads.map(p => p.embeds[0].toJSON().description).join('\n');
    for (let i = 0; i < 300; i++) assert.ok(all.includes(`\`RC-${i}\``));
});

test('a member can find, claim, finish, and reopen a task with buttons', async () => {
    const f = fixture();
    const found = await interact(f, 'kanban:find:0', { privateMessage: false });
    assert.equal(json(found.payload)[0].components[0].options[0].value, 'task-1');
    const view = await interact(f, 'kanban:select', { type: 'select', values: ['task-1'] });
    assert.deepEqual(labels(view.payload), ['Claim', 'Find Work', 'My Tasks']);
    const claimed = await interact(f, 'kanban:claim:task-1');
    assert.equal(f.task().userId, 'alice');
    assert.equal(getTaskStatus(f.task()), 'progress');
    assert.deepEqual(labels(claimed.payload), ['Mark Done', 'Unclaim', 'Edit', 'Delete', 'Find Work', 'My Tasks']);
    const mine = await interact(f, 'kanban:mine:0');
    assert.equal(json(mine.payload)[0].components[0].options.length, 1);
    await interact(f, 'kanban:done:task-1');
    assert.equal(getTaskStatus(f.task()), 'done');
    await interact(f, 'kanban:reopen:task-1');
    assert.equal(getTaskStatus(f.task()), 'progress');
    await interact(f, 'kanban:unclaim:task-1');
    assert.equal(f.task().userId, null);
    assert.equal(getTaskStatus(f.task()), 'todo');
});

test('Find Work pages through every open task without duplicate button IDs', async () => {
    const f = fixture();
    const extra = Array.from({ length: 72 }, (_, i) => ({ id: `t${i}`, issueKey: `RC-${i + 2}`, title: `Task ${i}`, status: 'todo', createdAt: `2026-10-02T00:00:${String(i % 60).padStart(2, '0')}Z` }));
    f.client.taskStorage.saveTasks(f.guild.id, [f.task(), ...extra]);
    const seen = new Set();
    for (const customId of ['kanban:find:0', 'kanban:find:1:page', 'kanban:find:2:page']) {
        const { payload } = await interact(f, customId);
        for (const option of json(payload)[0].components[0].options) seen.add(option.value);
    }
    assert.equal(seen.size, 73);
    assert.match((await interact(f, 'kanban:find:1:page')).payload.content, /page 2\/3/);
});

test('a claimed task cannot be taken or changed by someone else; managers can', async () => {
    const f = fixture();
    await interact(f, 'kanban:claim:task-1', { userId: 'alice' });
    const stolen = await interact(f, 'kanban:claim:task-1', { userId: 'carol' });
    assert.match(stolen.payload.content, /already working/);
    assert.deepEqual(labels(stolen.payload), ['Find Work', 'My Tasks']);
    await interact(f, 'kanban:done:task-1', { userId: 'carol' });
    assert.equal(getTaskStatus(f.task()), 'progress');
    await interact(f, 'kanban:done:task-1', { userId: 'carol', manager: true });
    assert.equal(getTaskStatus(f.task()), 'done');
});

test('Add Task and Edit use one short form and validate the due date', async () => {
    const f = fixture();
    const opened = await interact(f, 'kanban:add', { privateMessage: false });
    assert.equal(opened.kind, 'modal');
    const modal = opened.payload;
    const bad = await interact(f, 'kanban:create', { type: 'modal', fields: modalFields(modal, { title: 'New', due: '2026-02-30' }) });
    assert.match(bad.payload.content, /due date/);
    const created = await interact(f, 'kanban:create', { type: 'modal', fields: modalFields(modal, { title: '[POWER] New task', due: '2026-12-01' }) });
    assert.match(created.payload.content, /Created \*\*RC-1\*\*/);
    const task = f.client.taskStorage.getAllTasks(f.guild.id).find(item => item.title === '[POWER] New task');
    assert.equal(task.userId, null);
    assert.equal(task.dueDate, '2026-12-01');

    const edit = await interact(f, `kanban:edit:${task.id}`, { userId: 'carol' });
    assert.equal(edit.kind, 'reply');
    const editModal = (await interact(f, `kanban:edit:${task.id}`)).payload;
    await interact(f, editModal.toJSON().custom_id, { type: 'modal', fields: modalFields(editModal, { title: 'Renamed', due: '' }) });
    const saved = f.client.taskStorage.getAllTasks(f.guild.id).find(item => item.id === task.id);
    assert.equal(saved.title, 'Renamed');
    assert.equal(saved.dueDate, null);
});

test('delete asks once to confirm and respects permissions', async () => {
    const f = fixture();
    const denied = await interact(f, 'kanban:delete:task-1', { userId: 'carol' });
    assert.match(denied.payload.content, /Only the person/);
    const confirm = await interact(f, 'kanban:delete:task-1', { userId: 'bob' });
    assert.deepEqual(labels(confirm.payload), ['Delete permanently', 'Cancel']);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 1);
    await interact(f, 'kanban:deleteconfirm:task-1', { userId: 'bob' });
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 0);
});

test('buttons from older bot versions get a clear message instead of an error', async () => {
    const f = fixture();
    assert.match((await interact(f, 'kanban:more', { privateMessage: false })).payload.content, /out of date/);
    assert.match((await interact(f, 'kanban:list:ready:0')).payload.content, /Find Work/);
    assert.match((await interact(f, 'kanban:status:task-1', { type: 'select', values: ['done'] })).payload.content, /out of date/);
});

test('imports accept older lists, skip duplicates, and only the importer can confirm', async () => {
    const parsed = parseTaskList('HAB TASKS (2)\n=====\nSTM32\n=====\n1.\nTitle: [STM32] Pin map\nDescription: Line one\nline two\nPriority: high\nDue date: 2026-10-12\nTeam: Cubesat\n\n2.\nTitle: [POWER] Check battery\nDue date: none\n');
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.tasks[0], { title: '[STM32] Pin map', description: 'Line one\nline two', dueDate: '2026-10-12' });
    assert.match(parseTaskList('Title: X\nDue date: tomorrow').errors[0], /YYYY-MM-DD/);

    const f = fixture();
    const actor = { client: f.client, guild: f.guild, author: { id: 'admin' } };
    const { draft } = prepareImport(actor, 'Title: [STM32] Pin map\nTitle: [power]  check battery\nTitle: [power] check battery');
    const other = await interact(f, `kanban:importconfirm:${draft.id}`, { userId: 'carol', privateMessage: false });
    assert.equal(other.kind, 'reply');
    const done = await interact(f, `kanban:importconfirm:${draft.id}`, { userId: 'admin', privateMessage: false });
    assert.match(done.payload.content, /Imported \*\*1 task/);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 2);
});

test('text commands route to the simple command set', () => {
    assert.deepEqual(parseMessageCommand('!task'), { commandName: 'board', args: ['board'], restricted: true });
    assert.deepEqual(parseMessageCommand('!task claim RC-1').args, ['claim', 'RC-1']);
    assert.equal(parseMessageCommand('!task import').commandName, 'import');
    assert.equal(parseMessageCommand('!task depends RC-1 RC-2').commandName, 'depends');
});

test('the live board edits its messages, adds parts as it grows, and removes extras when it shrinks', async () => {
    const f = fixture();
    const sent = new Map();
    let nextId = 1;
    const makeMessage = payload => {
        const message = { id: `m${nextId++}`, author: { id: 'bot' }, payload, edit: async p => { message.payload = p; }, delete: async () => sent.delete(message.id) };
        sent.set(message.id, message);
        return message;
    };
    const channel = { id: 'board-channel',
        send: async payload => makeMessage(payload),
        messages: { fetch: async id => sent.get(id) || Promise.reject(Object.assign(new Error('Unknown'), { code: 10008 })) }
    };
    f.client.user = { id: 'bot' };
    f.client.channels = { fetch: async () => channel };
    const message = { client: f.client, guild: f.guild, channel, member: { permissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]) }, author: { id: 'admin' }, reply: async () => {}, mentions: { users: new Collection() } };
    await board.execute(message, ['setup']);
    assert.equal(sent.size, 1);

    const many = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, issueKey: `RC-${i + 2}`, title: 'y'.repeat(150), status: 'todo' }));
    f.client.taskStorage.saveTasks(f.guild.id, [f.task(), ...many]);
    await board.updateBoard(f.client, f.guild.id);
    assert.ok(sent.size > 1);
    assert.ok(sent.has('m1'), 'the original board message is kept');

    f.client.taskStorage.saveTasks(f.guild.id, [f.task()]);
    await board.updateBoard(f.client, f.guild.id);
    assert.deepEqual([...sent.keys()], ['m1']);
    assert.match(sent.get('m1').payload.embeds[0].toJSON().description, /Check battery/);
});

test('blocked tasks stay hidden until same-category blockers are done; other categories never block', async () => {
    const f = fixture();
    const base = { status: 'todo', completed: false, createdBy: 'bob', userId: null };
    f.client.taskStorage.saveTasks(f.guild.id, [
        f.task(),
        { ...base, id: 'b', issueKey: 'RC-2', title: '[POWER] Regulator test', blockedBy: ['task-1'] },
        { ...base, id: 'c', issueKey: 'RC-3', title: '[RADIO] Driver', blockedBy: ['task-1'] }
    ]);
    const text = () => board.generateBoardMessages(f.client, f.guild.id)[0].embeds[0].toJSON().description;
    assert.doesNotMatch(text(), /Regulator test/);
    assert.match(text(), /__POWER__ · 🔒 1 more unlock as these finish/);
    assert.match(text(), /RC-3/, 'a blocker in another category is ignored');
    const options = async () => json((await interact(f, 'kanban:find:0')).payload)[0].components[0].options.map(o => o.value);
    assert.deepEqual((await options()).sort(), ['c', 'task-1']);
    assert.match((await interact(f, 'kanban:claim:b')).payload.content, /unlocks after RC-1/);
    await interact(f, 'kanban:claim:task-1');
    await interact(f, 'kanban:done:task-1');
    assert.match(text(), /Regulator test/);
    assert.ok((await options()).includes('b'));
});

test('the exec board keeps its tasks separate from the main board', async () => {
    const f = fixture();
    const sent = [];
    const channel = id => ({ id, send: async payload => { const m = { id: `${id}-m${sent.length}`, author: { id: 'bot' }, edit: async () => {} }; sent.push(payload); return m; }, messages: { fetch: async () => { throw Object.assign(new Error('Unknown'), { code: 10008 }); } } });
    f.client.user = { id: 'bot' };
    f.client.channels = { fetch: async id => channel(id) };
    const replies = [];
    const message = (channelId, userId = 'admin') => ({ client: f.client, guild: f.guild, channel: channel(channelId), member: { permissions: new PermissionsBitField(userId === 'admin' ? [PermissionFlagsBits.ManageGuild] : []) }, author: { id: userId }, reply: async text => replies.push(text), mentions: { users: new Collection() } });
    await board.execute(message('exec-channel'), ['setup', 'exec']);
    await board.execute(message('exec-channel'), ['add', '[LEGAL]', 'Request', 'NOTAM']);
    const execTask = f.client.taskStorage.getAllTasks(f.guild.id).find(task => task.title === '[LEGAL] Request NOTAM');
    assert.equal(execTask.board, 'exec');
    assert.doesNotMatch(board.generateBoardMessages(f.client, f.guild.id).map(p => p.embeds[0].toJSON().description).join(), /NOTAM/);
    assert.match(board.generateBoardMessages(f.client, f.guild.id, 'exec')[0].embeds[0].toJSON().description, /NOTAM/);
    await board.execute(message('main-channel', 'carol'), ['claim', execTask.id]);
    assert.match(replies.at(-1), /could not find/);
    const fromMain = await interact(f, `kanban:claim:${execTask.id}`);
    assert.match(fromMain.payload.content, /no longer exists/);
});

test('!task block only links tasks in the same category and refuses loops', async () => {
    const f = fixture();
    f.client.taskStorage.saveTasks(f.guild.id, [f.task(),
        { id: 'b', issueKey: 'RC-2', title: '[POWER] Regulator', status: 'todo' },
        { id: 'c', issueKey: 'RC-3', title: '[RADIO] Driver', status: 'todo' }]);
    const replies = [];
    const run = (args, manager = true) => board.execute({ client: f.client, guild: f.guild, channel: { id: 'main' }, member: { permissions: new PermissionsBitField(manager ? [PermissionFlagsBits.ManageGuild] : []) }, author: { id: 'admin' }, reply: async text => replies.push(text), mentions: { users: new Collection() } }, args);
    await run(['block', 'RC-2', 'RC-1'], false);
    assert.match(replies.at(-1), /Only managers/);
    await run(['block', 'RC-2', 'RC-3']);
    assert.match(replies.at(-1), /same category/);
    await run(['block', 'RC-2', 'RC-1']);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id).find(t => t.id === 'b').blockedBy, ['task-1']);
    await run(['block', 'RC-1', 'RC-2']);
    assert.match(replies.at(-1), /loop/);
    await run(['block', 'RC-2', 'none']);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id).find(t => t.id === 'b').blockedBy, []);
});

test('the board plan script retags, moves, and blocks tasks, and rejects cross-category blockers', () => {
    const { applyPlan } = require('../scripts/apply-board-plan');
    const tasks = [
        { id: '1', issueKey: 'U-1', title: '[STM32] Pin map', dependsOn: ['2'] },
        { id: '2', issueKey: 'U-2', title: '[BMP280] Driver' },
        { id: '3', issueKey: 'U-3', title: '[REG] NOTAM' }
    ];
    const good = applyPlan(tasks, [
        { key: 'U-1', title: '[FIRMWARE] Pin map' },
        { key: 'U-2', title: '[FIRMWARE] BMP280 driver', blockedBy: ['U-1'] },
        { key: 'U-3', title: '[LEGAL] NOTAM', board: 'exec' }
    ]);
    assert.deepEqual(good.errors, []);
    assert.equal(good.tasks[1].blockedBy[0], '1');
    assert.equal(good.tasks[2].board, 'exec');
    assert.equal(good.tasks[0].dependsOn, undefined);
    assert.equal(tasks[0].title, '[STM32] Pin map', 'the input is not modified');
    assert.match(applyPlan(tasks, [{ key: 'U-2', blockedBy: ['U-1'] }]).errors[0], /STM32, not BMP280/);
    assert.match(applyPlan(tasks, [{ key: 'U-1', title: '[A] x', blockedBy: ['U-2'] }, { key: 'U-2', title: '[A] y', blockedBy: ['U-1'] }]).errors.join(), /loop/);
});

test('the board plan script adds, deletes, dates, and describes tasks, and catches out-of-order dates', () => {
    const { applyPlan } = require('../scripts/apply-board-plan');
    const tasks = [
        { id: '1', issueKey: 'U-1', title: 'test' },
        { id: '2', issueKey: 'U-2', title: '[A] First', description: 'Old.' },
        { id: '3', issueKey: 'U-3', title: '[A] Second', blockedBy: ['1'] }
    ];
    const result = applyPlan(tasks, [
        { key: 'U-1', delete: true },
        { key: 'U-2', dueDate: '2026-11-01', description: 'Old. New.' },
        { new: 'third', title: '[A] Third', dueDate: '2026-11-08', blockedBy: ['U-2'] },
        { key: 'U-3', blockedBy: ['third'], dueDate: null }
    ], { projectKey: 'U', nextIssueNumber: 4, now: '2026-10-13T00:00:00Z' });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tasks.map(task => task.issueKey), ['U-2', 'U-3', 'U-4']);
    assert.equal(result.nextIssueNumber, 5);
    const third = result.tasks.find(task => task.issueKey === 'U-4');
    assert.deepEqual(third.blockedBy, ['2']);
    assert.deepEqual(result.tasks.find(task => task.issueKey === 'U-3').blockedBy, [third.id]);
    assert.equal(result.tasks[0].description, 'Old. New.');
    assert.equal(result.tasks[1].dueDate, null);
    assert.match(applyPlan(tasks, [{ key: 'U-3', title: '[A] Second', dueDate: '2026-10-01', blockedBy: ['U-2'] }, { key: 'U-2', dueDate: '2026-11-01' }]).errors[0], /before its blocker U-2/);
    assert.match(applyPlan(tasks, [{ key: 'U-2', delete: true }, { key: 'U-3', blockedBy: ['U-2'] }]).errors[0], /being deleted/);
});
