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
// Every title, description, and field of a board's cards, as one string.
const boardText = payloads => [].concat(payloads).flatMap(p => p.embeds.map(e => e.toJSON()))
    .map(e => [e.title, e.description, ...(e.fields || []).flatMap(f => [f.name, f.value])].filter(Boolean).join('\n')).join('\n');
const taskOptions = payload => json(payload).flatMap(row => row.components).find(c => c.custom_id === 'kanban:select').options;
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
        assert.ok((embed.fields || []).length <= 25 && (embed.fields || []).every(f => f.name.length <= 256 && f.value && f.value.length <= 1024));
        chars += (embed.title || '').length + (embed.description || '').length + (embed.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    }
    assert.ok((payload.embeds || []).length <= 10);
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
    const text = boardText(payload);
    assert.match(text, /📥 \*\*1\*\* ready to claim  ·  🔧 \*\*2\*\* in progress  ·  ✅ \*\*1\*\* done/);
    const cards = payload.embeds.map(e => e.toJSON());
    assert.deepEqual(cards.map(c => c.title), ['🚀 Board', '🔧 In Progress', '⚡ POWER']);
    assert.deepEqual(cards[2].fields.map(f => f.name), ['RC-1 · Battery']);
    assert.match(text, /RC-2 · 📁 Pin map\n👤 <@alice>/);
    assert.doesNotMatch(text, /Shipped already/);
});

test('large boards split across messages within Discord limits and keep every open task', () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, issueKey: `RC-${i}`, title: `[TAG${i % 7}] ${'x'.repeat(150)} ${i}`, status: 'todo' }));
    const payloads = renderBoard(tasks, 'Board');
    assert.ok(payloads.length > 1);
    payloads.forEach(validateMessage);
    const all = boardText(payloads);
    for (let i = 0; i < 300; i++) assert.ok(all.includes(`RC-${i} ·`));
    assert.deepEqual(payloads.map(p => p.components.length), [...payloads.slice(1).map(() => 0), 1], 'buttons only on the last message');
});

test('the task view shows its category, summary, and details, and the dropdown marks each category', async () => {
    const f = fixture({ task: { description: 'Build the battery pack.\n\nDetails: 2S Li-ion, 5 A fuse.' } });
    const option = taskOptions((await interact(f, 'kanban:find:0')).payload)[0];
    assert.equal(option.emoji.name, '⚡');
    const view = (await interact(f, 'kanban:select', { type: 'select', values: ['task-1'] })).payload.embeds[0].toJSON();
    assert.equal(view.author.name, '⚡ POWER');
    assert.equal(view.title, 'RC-1 · Check battery');
    assert.equal(view.description, 'Build the battery pack.\n\n**Details:** 2S Li-ion, 5 A fuse.');
    const card = renderBoard(f.client.taskStorage.getAllTasks(f.guild.id), 'Board')[0].embeds[1].toJSON();
    assert.deepEqual(card.fields[0], { name: 'RC-1 · Check battery', value: 'Build the battery pack.' });
});

test('Find Work can be narrowed to one category, and paging keeps the category', async () => {
    const f = fixture();
    const extra = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, issueKey: `RC-${i + 10}`, title: `[RADIO] Job ${i}`, status: 'todo', createdAt: `2026-10-${String(i + 1).padStart(2, '0')}` }));
    f.client.taskStorage.saveTasks(f.guild.id, [f.task(), ...extra]);
    const all = (await interact(f, 'kanban:find:0')).payload;
    const filter = json(all)[0].components[0];
    assert.equal(filter.custom_id, 'kanban:filter:find');
    assert.deepEqual(filter.options.map(o => [o.label, o.default]), [['All categories (31)', true], ['POWER (1)', false], ['RADIO (30)', false]]);
    const radioId = filter.options[2].value;
    const radio = (await interact(f, 'kanban:filter:find', { type: 'select', values: [radioId] })).payload;
    assert.match(radio.content, /30 task\(s\) in 📡 RADIO · page 1\/2/);
    assert.ok(taskOptions(radio).every(o => o.emoji.name === '📡'));
    const next = json(radio).flatMap(row => row.components).find(c => c.label === 'Next').custom_id;
    assert.equal(next, `kanban:find:1:page:${radioId}`);
    const page2 = (await interact(f, next)).payload;
    assert.equal(taskOptions(page2).length, 5);
    assert.ok(taskOptions(page2).every(o => o.emoji.name === '📡'));
    await interact(f, 'kanban:claim:task-1');
    const power = filter.options[1].value;
    const empty = (await interact(f, 'kanban:filter:find', { type: 'select', values: [power] })).payload;
    assert.match(empty.content, /Nothing in POWER is open right now/);
    assert.ok(json(empty)[0].components[0].options.find(o => o.value === power).default);
});

test('a member can find, claim, finish, and reopen a task with buttons', async () => {
    const f = fixture();
    const found = await interact(f, 'kanban:find:0', { privateMessage: false });
    assert.equal(taskOptions(found.payload)[0].value, 'task-1');
    const view = await interact(f, 'kanban:select', { type: 'select', values: ['task-1'] });
    assert.deepEqual(labels(view.payload), ['Claim', 'Find Work', 'My Tasks']);
    const claimed = await interact(f, 'kanban:claim:task-1');
    assert.deepEqual(f.task().userIds, ['alice']);
    assert.equal(getTaskStatus(f.task()), 'progress');
    assert.deepEqual(labels(claimed.payload), ['Mark Done', 'Unclaim', 'Edit', 'Delete', 'Find Work', 'My Tasks']);
    const mine = await interact(f, 'kanban:mine:0');
    assert.equal(taskOptions(mine.payload).length, 1);
    await interact(f, 'kanban:done:task-1');
    assert.equal(getTaskStatus(f.task()), 'done');
    await interact(f, 'kanban:reopen:task-1');
    assert.equal(getTaskStatus(f.task()), 'progress');
    await interact(f, 'kanban:unclaim:task-1');
    assert.deepEqual(f.task().userIds, []);
    assert.equal(getTaskStatus(f.task()), 'todo');
});

test('Find Work options show the due date and the start of the plain-language summary', async () => {
    const f = fixture({ task: { dueDate: '2026-11-01', description: 'Start the code for the BMP280 pressure sensor, which tells us altitude: set up the driver and check the chip answers with the right ID.\n\nDetails: Chip ID 0x58.' } });
    const option = taskOptions((await interact(f, 'kanban:find:0')).payload)[0];
    assert.match(option.description, /^due 1 Nov 2026 · Start the code for the BMP280 pressure sensor/);
    assert.match(option.description, /…$/);
    assert.ok(option.description.length <= 100);
    assert.doesNotMatch(option.description, /Details|0x58/);
    await interact(f, 'kanban:claim:task-1');
    const mine = taskOptions((await interact(f, 'kanban:mine:0')).payload)[0];
    assert.match(mine.description, /^In Progress · due 1 Nov 2026 · Start the code/);
    const bare = fixture({ task: { description: '' } });
    assert.equal(taskOptions((await interact(bare, 'kanban:find:0')).payload)[0].description, 'To Do');
});

test('Find Work pages through every open task without duplicate button IDs', async () => {
    const f = fixture();
    const extra = Array.from({ length: 72 }, (_, i) => ({ id: `t${i}`, issueKey: `RC-${i + 2}`, title: `Task ${i}`, status: 'todo', createdAt: `2026-10-02T00:00:${String(i % 60).padStart(2, '0')}Z` }));
    f.client.taskStorage.saveTasks(f.guild.id, [f.task(), ...extra]);
    const seen = new Set();
    for (const customId of ['kanban:find:0', 'kanban:find:1:page', 'kanban:find:2:page']) {
        const { payload } = await interact(f, customId);
        for (const option of taskOptions(payload)) seen.add(option.value);
    }
    assert.equal(seen.size, 73);
    assert.match((await interact(f, 'kanban:find:1:page')).payload.content, /page 2\/3/);
});

test('several people can claim one task, and each unclaims only themselves', async () => {
    const f = fixture();
    await interact(f, 'kanban:claim:task-1', { userId: 'alice' });
    assert.match((await interact(f, 'kanban:find:0', { userId: 'alice' })).payload.content, /Find Work\*\* — 0 task/);
    const found = await interact(f, 'kanban:find:0', { userId: 'carol' });
    assert.match(taskOptions(found.payload)[0].description, /^1 working on it · Details/);
    assert.deepEqual(labels((await interact(f, 'kanban:view:task-1', { userId: 'carol' })).payload), ['Join', 'Find Work', 'My Tasks']);
    const joined = await interact(f, 'kanban:claim:task-1', { userId: 'carol' });
    assert.match(joined.payload.content, /You joined RC-1\. 1 other is working on it too/);
    assert.deepEqual(labels(joined.payload), ['Mark Done', 'Unclaim', 'Edit', 'Delete', 'Find Work', 'My Tasks']);
    assert.deepEqual(f.task().userIds, ['alice', 'carol']);
    assert.match((await interact(f, 'kanban:claim:task-1', { userId: 'carol' })).payload.content, /already working/);
    assert.deepEqual(f.task().userIds, ['alice', 'carol']);
    assert.match(boardText(renderBoard([f.task()], 'Board')), /RC-1 · ⚡ Check battery\nDetails\n👥 <@alice>, <@carol>/);
    assert.match((await interact(f, 'kanban:unclaim:task-1', { userId: 'alice' })).payload.content, /You left RC-1\. The others are still on it/);
    assert.deepEqual(f.task().userIds, ['carol']);
    assert.equal(getTaskStatus(f.task()), 'progress');
    await interact(f, 'kanban:done:task-1', { userId: 'dave' });
    assert.equal(getTaskStatus(f.task()), 'progress');
    await interact(f, 'kanban:done:task-1', { userId: 'carol' });
    assert.equal(getTaskStatus(f.task()), 'done');
});

test('a task saved with one owner still works, and its creator can take everyone off it', async () => {
    const f = fixture({ task: { status: 'progress', userId: 'alice' } });
    assert.equal(taskOptions((await interact(f, 'kanban:mine:0', { userId: 'alice' })).payload).length, 1);
    await interact(f, 'kanban:claim:task-1', { userId: 'carol' });
    assert.deepEqual(f.task().userIds, ['alice', 'carol']);
    assert.equal(f.task().userId, undefined);
    const creator = await interact(f, 'kanban:view:task-1', { userId: 'bob' });
    assert.deepEqual(labels(creator.payload), ['Join', 'Mark Done', 'Unclaim everyone', 'Edit', 'Delete', 'Find Work', 'My Tasks']);
    assert.match((await interact(f, 'kanban:unclaim:task-1', { userId: 'bob' })).payload.content, /Everyone was taken off RC-1\. It is back in To Do/);
    assert.deepEqual(f.task().userIds, []);
    assert.equal(getTaskStatus(f.task()), 'todo');
});

test('clicks at the same moment never undo each other', async () => {
    const f = fixture();
    const [alice, carol] = await Promise.all([
        interact(f, 'kanban:claim:task-1', { userId: 'alice' }),
        interact(f, 'kanban:claim:task-1', { userId: 'carol' })
    ]);
    assert.match(alice.payload.content, /RC-1 is yours/);
    assert.match(carol.payload.content, /You joined RC-1/);
    assert.deepEqual(f.task().userIds, ['alice', 'carol']);

    // Saving the edit form keeps someone who joined at the same moment.
    const editModal = (await interact(f, 'kanban:edit:task-1', { userId: 'bob' })).payload;
    await Promise.all([
        interact(f, 'kanban:claim:task-1', { userId: 'dave' }),
        interact(f, editModal.toJSON().custom_id, { type: 'modal', userId: 'bob', fields: modalFields(editModal, { title: '[POWER] Check battery pack' }) })
    ]);
    assert.deepEqual(f.task().userIds, ['alice', 'carol', 'dave']);
    assert.equal(f.task().title, '[POWER] Check battery pack');

    // A late Join cannot reopen a task that was just marked done.
    const [done, late] = await Promise.all([
        interact(f, 'kanban:done:task-1', { userId: 'carol' }),
        interact(f, 'kanban:claim:task-1', { userId: 'erin' })
    ]);
    assert.match(done.payload.content, /marked done/);
    assert.match(late.payload.content, /already done/);
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
    assert.deepEqual(task.userIds, []);
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
    assert.match(denied.payload.content, /Only the people/);
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
    assert.match(boardText(sent.get('m1').payload), /Check battery/);
});

test('blocked tasks stay hidden until same-category blockers are done; other categories never block', async () => {
    const f = fixture();
    const base = { status: 'todo', completed: false, createdBy: 'bob', userId: null };
    f.client.taskStorage.saveTasks(f.guild.id, [
        f.task(),
        { ...base, id: 'b', issueKey: 'RC-2', title: '[POWER] Regulator test', blockedBy: ['task-1'] },
        { ...base, id: 'c', issueKey: 'RC-3', title: '[RADIO] Driver', blockedBy: ['task-1'] }
    ]);
    const text = () => boardText(board.generateBoardMessages(f.client, f.guild.id));
    assert.doesNotMatch(text(), /Regulator test/);
    assert.match(text(), /⚡ POWER\n\*\*1\*\* ready to claim  ·  🔒 1 more unlock as these finish/);
    assert.match(text(), /RC-3/, 'a blocker in another category is ignored');
    const options = async () => taskOptions((await interact(f, 'kanban:find:0')).payload).map(o => o.value);
    assert.deepEqual((await options()).sort(), ['c', 'task-1']);
    assert.match((await interact(f, 'kanban:claim:b')).payload.content, /unlocks after RC-1/);
    await interact(f, 'kanban:claim:task-1');
    await interact(f, 'kanban:done:task-1');
    assert.match(text(), /Regulator test/);
    assert.ok((await options()).includes('b'));
});

test('managers can turn a notice on and off for each board, and write their own', async () => {
    const f = fixture();
    const channel = id => ({ id, send: async () => ({ id: `${id}-m`, author: { id: 'bot' }, edit: async () => {} }), messages: { fetch: async () => { throw Object.assign(new Error('Unknown'), { code: 10008 }); } } });
    f.client.user = { id: 'bot' };
    f.client.channels = { fetch: async id => channel(id) };
    const replies = [];
    const message = (channelId, userId = 'admin') => ({ client: f.client, guild: f.guild, channel: channel(channelId), member: { permissions: new PermissionsBitField(userId === 'admin' ? [PermissionFlagsBits.ManageGuild] : []) }, author: { id: userId }, reply: async text => replies.push(text), mentions: { users: new Collection() } });
    const titles = (board_ = 'main') => board.generateBoardMessages(f.client, f.guild.id, board_)[0].embeds.map(e => e.toJSON().title);
    await board.execute(message('main-channel'), ['setup']);
    await board.execute(message('exec-channel'), ['setup', 'exec']);
    assert.equal(titles()[0], '🚀 Rocket Club Task Board');
    assert.match(boardText(board.generateBoardMessages(f.client, f.guild.id)), /Want to help\?/);

    await board.execute(message('main-channel', 'carol'), ['notice', 'on']);
    assert.match(replies.at(-1), /Manage Server/);
    await board.execute(message('main-channel'), ['notice', 'on']);
    assert.deepEqual(titles().slice(0, 2), ['📌 How this board works', '🚀 Rocket Club Task Board']);
    assert.doesNotMatch(board.generateBoardMessages(f.client, f.guild.id)[0].embeds[1].toJSON().description, /Want to help\?/, 'the how-to is not repeated');
    assert.equal(titles('exec')[0], '🚀 Rocket Club Exec Board', 'the exec board has its own setting');
    board.generateBoardMessages(f.client, f.guild.id).forEach(validateMessage);

    await board.execute(message('main-channel'), ['notice', 'off']);
    assert.equal(titles()[0], '🚀 Rocket Club Task Board');
    await board.execute(message('main-channel'), ['notice']);
    assert.match(replies.at(-1), /The notice is \*\*off\*\*/);

    const content = '!task notice set # Welcome to GameDev\nPick a task with **Find Work**.\nQuestions? Ask a lead.';
    await board.execute({ ...message('main-channel'), content }, ['notice', 'set', '#', 'Welcome']);
    const cards = () => board.generateBoardMessages(f.client, f.guild.id)[0].embeds.map(e => e.toJSON());
    assert.equal(cards()[0].title, '📌 Welcome to GameDev');
    assert.equal(cards()[0].description, 'Pick a task with **Find Work**.\nQuestions? Ask a lead.');
    assert.match(cards()[1].description, /Want to help\?/, 'a server\'s own notice keeps the short how-to');
    await board.execute(message('main-channel'), ['notice', 'off']);
    await board.execute(message('main-channel'), ['notice', 'on']);
    assert.equal(cards()[0].title, '📌 Welcome to GameDev', 'turning it back on keeps the server\'s text');
    await board.execute({ ...message('main-channel'), content: '!task notice set Just one line' }, ['notice', 'set', 'Just', 'one', 'line']);
    assert.deepEqual([cards()[0].title, cards()[0].description], ['📌 Notice', 'Just one line']);
    await board.execute(message('main-channel'), ['notice', 'default']);
    assert.equal(cards()[0].title, '📌 How this board works');
    assert.match(cards()[0].description, /or ask an exec\.$/);
    await board.execute({ ...message('main-channel'), content: '!task notice set' }, ['notice', 'set']);
    assert.match(replies.at(-1), /Write the notice after the command/);
});

test('!task assign adds several people to a task, and none takes everyone off', async () => {
    const f = fixture({ task: { status: 'progress', userIds: ['alice'] } });
    const replies = [];
    const user = id => ({ id, toString: () => `<@${id}>` });
    const message = (mentioned, userId = 'admin') => ({
        client: f.client, guild: f.guild, channel: { id: 'channel' }, author: { id: userId }, reply: async text => replies.push(text),
        member: { permissions: new PermissionsBitField(userId === 'admin' ? [PermissionFlagsBits.ManageGuild] : []) },
        mentions: { users: new Collection(mentioned.map(id => [id, user(id)])) }
    });
    await board.execute(message(['carol', 'dave']), ['assign', 'RC-1', '<@carol>', '<@dave>']);
    assert.equal(replies.at(-1), 'RC-1 assigned to <@carol>, <@dave>.');
    assert.deepEqual(f.task().userIds, ['alice', 'carol', 'dave']);
    await board.execute(message(['erin'], 'carol'), ['assign', 'RC-1', '<@erin>']);
    assert.match(replies.at(-1), /Only managers/);
    await board.execute(message([]), ['assign', 'RC-1', 'none']);
    assert.deepEqual(f.task().userIds, []);
    assert.equal(getTaskStatus(f.task()), 'todo');
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
    assert.doesNotMatch(boardText(board.generateBoardMessages(f.client, f.guild.id)), /NOTAM/);
    assert.match(boardText(board.generateBoardMessages(f.client, f.guild.id, 'exec')), /NOTAM/);
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
