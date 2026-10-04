const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection, MessageFlags, escapeMarkdown } = require('discord.js');
const { execFileSync } = require('child_process');

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-board-display-'));
process.env.BOT_DATA_DIR = temporaryDir;
const TaskStorage = require('../taskStorage');
const board = require('../commands/board');
const { getTaskTag } = require('../utils/taskTags');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
let counter = 0;

function fixture(count = 73, { longTitles = false, mixed = false } = {}) {
    const guild = { id: `display-guild-${++counter}`, name: 'Rocket Club', roles: { cache: new Collection() } };
    const client = { user: { id: 'bot' }, guilds: { cache: new Collection([[guild.id, guild]]) }, serverConfigs: {}, taskStorage: new TaskStorage(path.join(temporaryDir, guild.id)) };
    const tasks = Array.from({ length: count }, (_, i) => ({
        id: `task-${i}`, issueKey: `RC-${i + 1}`, title: longTitles ? `${i} ` + '*'.repeat(195) : `[STM32] Complete task ${i} with its full title and details`,
        description: 'Details', priority: ['urgent', 'high', 'medium', 'low'][i % 4], dueDate: '2026-10-12', createdAt: '2026-10-01T00:00:00Z',
        status: mixed ? ['todo', 'progress', 'review', 'done'][i % 4] : 'todo', completed: mixed && i % 4 === 3,
        userId: i % 3 ? null : '123456789012345678', teamId: 'cubesat', teamName: 'Cubesat'
    }));
    client.taskStorage.saveTasks(guild.id, tasks);
    return { client, guild, tasks };
}

function validate(payloads, tasks) {
    const text = payloads.map(payload => {
        const embed = payload.embeds[0].toJSON();
        const fields = embed.fields || [];
        assert.ok(embed.title.length <= 256);
        assert.ok(fields.length <= 25);
        assert.ok(payload.content.length <= 2000);
        const length = embed.title.length + embed.description.length + embed.footer.text.length + fields.reduce((n, field) => {
            assert.ok(field.name.length <= 256);
            assert.ok(field.value.length > 0 && field.value.length <= 1024);
            return n + field.name.length + field.value.length;
        }, 0);
        assert.ok(length <= 6000);
        const ids = payload.components.flatMap(row => row.toJSON().components.map(component => component.custom_id));
        assert.equal(ids.length, new Set(ids).size);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        return fields.map(field => `${field.name}\n${field.value}`).join('\n');
    }).join('\n');
    assert.ok(!text.includes(' more'));
    for (const task of tasks) assert.equal(text.split('`' + task.issueKey + '`').length - 1, 1, `${task.issueKey} appears exactly once`);
    return text;
}

test('all 73 tasks and full titles appear exactly once instead of a hidden-task count', () => {
    const f = fixture();
    const pages = board.generateBoardMessages(f.client, f.guild.id);
    assert.ok(pages.length > 1);
    const text = validate(pages, f.tasks);
    for (const task of f.tasks) assert.ok(text.includes(escapeMarkdown(task.title.replace(/^\[STM32\]\s*/, ''))));
    assert.ok(pages[0].embeds[0].toJSON().description.includes('Cubesat'));
    assert.ok(text.includes('<@123456789012345678>'));
    assert.ok(text.includes('12 Oct 2026'));
    assert.match(pages[0].embeds[0].toJSON().description, /73 tasks/);
});

test('empty boards and all four statuses fit; large and maximum-title boards retain every task', () => {
    for (const count of [0, 1, 73, 250, 1000]) {
        const f = fixture(count, { mixed: true, longTitles: true });
        const pages = board.generateBoardMessages(f.client, f.guild.id);
        const text = validate(pages, f.tasks);
        assert.ok(pages.every((page, index) => pages.length === 1 || page.embeds[0].toJSON().title.endsWith(`${index + 1}/${pages.length}`)));
        if (!count) assert.match(pages[0].embeds[0].toJSON().description, /No tasks yet/);
        if (count >= 4) for (const status of ['To Do', 'In Progress', 'Review', 'Done']) assert.ok(text.includes(status));
    }
});

test('unusually long legacy titles are preserved across fields without breaking Unicode characters', () => {
    const f = fixture(1);
    f.tasks[0].title = '🌙'.repeat(1500);
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    const pages = board.generateBoardMessages(f.client, f.guild.id);
    validate(pages, f.tasks);
    const fields = pages.flatMap(page => page.embeds[0].toJSON().fields);
    const text = fields.map(field => field.value).join('');
    assert.equal(text.split('🌙').length - 1, 1500);
    for (const field of fields) assert.ok(!/[\uD800-\uDBFF]$/.test(field.value) && !/^[\uDC00-\uDFFF]/.test(field.value));
});

function fakeChannel(f) {
    const messages = new Map();
    const edits = [];
    const deleted = [];
    let sent = 0;
    let failSendAfter = Infinity;
    const channel = {
        id: 'board-channel',
        send: async payload => {
            if (sent >= failSendAfter) throw new Error('Temporary send failure');
            const id = `message-${++sent}`;
            const message = { id, author: { id: 'bot' }, payload, edit: async next => { message.payload = next; edits.push(id); }, delete: async () => { deleted.push(id); messages.delete(id); } };
            messages.set(id, message);
            return message;
        },
        messages: { fetch: async id => {
            if (!messages.has(id)) throw Object.assign(new Error('Unknown message'), { code: 10008 });
            return messages.get(id);
        } }
    };
    f.client.channels = { fetch: async id => { assert.equal(id, channel.id); return channel; } };
    const actor = { guild: f.guild, client: f.client, author: { id: 'admin' }, member: { permissions: { has: () => true }, roles: { cache: new Set() } }, channel, reply: async () => {} };
    return { channel, actor, messages, edits, deleted, get sent() { return sent; }, set failSendAfter(value) { failSendAfter = value; } };
}

const config = f => JSON.parse(fs.readFileSync(path.join(temporaryDir, 'kanbanBoards.json')))[f.guild.id];

test('live setup creates all parts, adds navigation links, and tracks their IDs for updates and restart', async () => {
    const f = fixture();
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const state = config(f);
    const expected = board.generateBoardMessages(f.client, f.guild.id);
    assert.equal(state.messageIds.length, expected.length);
    assert.equal(state.messageId, state.messageIds[0]);
    for (const [index, id] of state.messageIds.entries()) {
        const payload = network.messages.get(id).payload;
        if (index > 0) assert.ok(payload.content.includes(`/channels/${f.guild.id}/board-channel/${state.messageIds[index - 1]}`));
        if (index < expected.length - 1) assert.ok(payload.content.includes(`/channels/${f.guild.id}/board-channel/${state.messageIds[index + 1]}`));
    }
    validate([...network.messages.values()].map(message => message.payload), f.tasks);
    const before = network.sent;
    await board.updateBoard(f.client, f.guild.id);
    assert.equal(network.sent, before);
    assert.deepEqual(config(f).messageIds, state.messageIds);
});

test('concurrent board updates serialize so each needed part is sent once', async () => {
    const f = fixture(1);
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const tasks = fixture(73).tasks;
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    const expected = board.generateBoardMessages(f.client, f.guild.id).length;
    await Promise.all(Array.from({ length: 8 }, () => board.updateBoard(f.client, f.guild.id)));
    assert.equal(network.sent, expected);
    assert.equal(network.messages.size, expected);
    validate([...network.messages.values()].map(message => message.payload), tasks);
});

test('shrinking a board deletes only its extra bot messages and keeps the original anchor', async () => {
    const f = fixture();
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const original = config(f).messageId;
    await network.channel.send({ content: 'Unrelated bot message' });
    const unrelatedId = `message-${network.sent}`;
    f.client.taskStorage.saveTasks(f.guild.id, []);
    await board.updateBoard(f.client, f.guild.id);
    assert.deepEqual(config(f).messageIds, [original]);
    assert.ok(network.messages.has(unrelatedId));
    assert.ok(network.messages.has(original));
    assert.ok(!network.deleted.includes(unrelatedId));
    validate([network.messages.get(original).payload], []);
});

test('deleted board parts, including the anchor, are recovered without creating duplicates', async () => {
    const f = fixture();
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    for (const index of [1, 0]) {
        const before = config(f);
        const old = before.messageIds[index];
        network.messages.delete(old);
        await board.updateBoard(f.client, f.guild.id);
        assert.notEqual(config(f).messageIds[index], old);
        assert.equal(network.messages.size, before.messageIds.length);
        validate(config(f).messageIds.map(id => network.messages.get(id).payload), f.tasks);
    }
});

test('failed sends preserve already-created IDs and the next update retries without orphan messages', async () => {
    const f = fixture(1);
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const tasks = fixture(250).tasks;
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    network.failSendAfter = 2;
    const originalError = console.error;
    try { console.error = () => {}; await board.updateBoard(f.client, f.guild.id); }
    finally { console.error = originalError; }
    assert.equal(network.sent, 2);
    assert.equal(config(f).messageIds.length, 2);
    network.failSendAfter = Infinity;
    await board.updateBoard(f.client, f.guild.id);
    assert.equal(network.sent, board.generateBoardMessages(f.client, f.guild.id).length);
    validate(config(f).messageIds.map(id => network.messages.get(id).payload), tasks);
});

test('growth keeps the original board anchor and suppresses new-part notifications', async () => {
    const f = fixture(1);
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const tasks = fixture(73).tasks;
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    const sends = [];
    const originalSend = network.channel.send;
    network.channel.send = async payload => { sends.push(payload); return originalSend(payload); };
    await board.updateBoard(f.client, f.guild.id);
    assert.ok(sends.length > 0);
    assert.ok(sends.every(payload => payload.flags === MessageFlags.SuppressNotifications));
    assert.equal(config(f).messageId, 'message-1');
});

test('a fresh process migrates legacy single-message config, then reuses all persisted parts after restart', async () => {
    const f = fixture(1);
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const file = path.join(temporaryDir, 'kanbanBoards.json');
    const configs = JSON.parse(fs.readFileSync(file));
    delete configs[f.guild.id].messageIds;
    delete configs[f.guild.id].sectionMessageIds;
    fs.writeFileSync(file, JSON.stringify(configs));
    const tasks = fixture(73).tasks;
    tasks.forEach((task, i) => { task.title = `[TAG ${i % 7}] Task ${i}`; });
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    const script = `
        const fs=require('fs');
        process.env.BOT_DATA_DIR=process.argv[1];
        const board=require(process.argv[2]);
        const TaskStorage=require(process.argv[3]);
        const guildId=process.argv[4];
        const file=process.env.BOT_DATA_DIR+'/kanbanBoards.json';
        const config=JSON.parse(fs.readFileSync(file))[guildId];
        const existing=new Set(config.messageIds||[config.messageId]);
        let sent=0;
        const message=id=>({id,author:{id:'bot'},edit:async()=>{}});
        const channel={messages:{fetch:async id=>{if(!existing.has(id))throw Object.assign(new Error('missing'),{code:10008});return message(id);}},send:async()=>{const id='restarted-'+existing.size;existing.add(id);sent++;return message(id);}};
        const guild={id:guildId,name:'Rocket Club',roles:{cache:new Map()}};
        const client={user:{id:'bot'},guilds:{cache:new Map([[guildId,guild]])},channels:{fetch:async()=>channel},serverConfigs:{},taskStorage:new TaskStorage(process.argv[5])};
        board.updateBoard(client,guildId).then(()=>console.log(JSON.stringify({sent,config:JSON.parse(fs.readFileSync(file))[guildId]})));
    `;
    const run = () => JSON.parse(execFileSync(process.execPath, ['-e', script, temporaryDir, require.resolve('../commands/board'), require.resolve('../taskStorage'), f.guild.id, f.client.taskStorage.tasksDir], { encoding: 'utf8' }));
    const migrated = run();
    assert.ok(migrated.sent > 0);
    assert.equal(migrated.config.messageId, 'message-1');
    assert.equal(migrated.config.messageIds.length, board.generateBoardMessages(f.client, f.guild.id).length);
    const restarted = run();
    assert.equal(restarted.sent, 0);
    assert.deepEqual(restarted.config.messageIds, migrated.config.messageIds);
});

test('extra board IDs pointing to someone else’s message are never deleted', async () => {
    const f = fixture();
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const lastId = config(f).messageIds.at(-1);
    network.messages.get(lastId).author.id = 'other-user';
    f.client.taskStorage.saveTasks(f.guild.id, []);
    const originalError = console.error;
    try { console.error = () => {}; await board.updateBoard(f.client, f.guild.id); }
    finally { console.error = originalError; }
    assert.ok(network.messages.has(lastId));
    assert.ok(!network.deleted.includes(lastId));
});

test('standalone !task displays every part without changing the saved live-board registration', async () => {
    const f = fixture();
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const before = config(f);
    const sentBefore = network.sent;
    await board.execute(network.actor, ['board']);
    assert.equal(network.sent - sentBefore, board.generateBoardMessages(f.client, f.guild.id).length);
    assert.deepEqual(config(f), before);
});

test('overview and tag cards show every task once, with readable state, ownership, due date, and teams', () => {
    const f = fixture(73, { mixed: true });
    f.tasks.forEach((task, i) => {
        task.title = i === 72 ? 'An untagged task' : `[${i % 2 ? 'POWER' : 'DECISION'}] Full task ${i}`;
        if (i === 1) { task.teamId = 'software'; task.teamName = 'Software'; }
    });
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    const payloads = board.generateBoardMessages(f.client, f.guild.id);
    validate(payloads, f.tasks);
    const overview = payloads[0].embeds[0].toJSON();
    assert.match(overview.description, /73 tasks · 3 tags/);
    assert.deepEqual(overview.fields.map(field => field.name), ['DECISION', 'POWER', 'General']);
    for (const payload of payloads.slice(1)) {
        const embed = payload.embeds[0].toJSON();
        const expected = f.tasks.filter(task => getTaskTag(task).id === payload.tagId);
        for (const field of embed.fields) {
            const task = expected.find(task => field.name.includes('`' + task.issueKey + '`'));
            assert.ok(task, 'group cards contain only their own tasks');
            assert.ok(field.name.includes(getTaskTag(task).title));
            assert.match(field.value, /To Do|In Progress|Review|Done/);
            assert.match(field.value, /Urgent|High|Medium|Low/);
            assert.match(field.value, /12 Oct 2026/);
            assert.match(field.value, /👤/);
            if (embed.title.startsWith('POWER')) assert.match(field.value, /Team: (Cubesat|Software)/);
        }
        if (embed.title.startsWith('DECISION')) assert.match(embed.description, /Team: \*\*Cubesat\*\*/);
        assert.equal(payload.components[0].toJSON().components[0].custom_id, `kanban:list:tag:0:${payload.tagId}`);
    }
});

test('large tag indexes and maximum-length escaped titles remain within Discord limits', () => {
    const f = fixture(80);
    f.tasks.forEach((task, i) => { task.title = `[TAG ${i}] ` + '*'.repeat(185); });
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    const payloads = board.generateBoardMessages(f.client, f.guild.id);
    validate(payloads, f.tasks);
    assert.equal(payloads.filter(payload => payload.indexTags).length, 4);
    assert.equal(payloads.filter(payload => payload.tagId).length, 80);
    assert.equal(payloads.filter(payload => payload.indexTags).flatMap(payload => payload.indexTags).length, 80);
});

test('tag links and message IDs survive group additions, moves, and removals without duplicates', async () => {
    const f = fixture(3);
    f.tasks.forEach(task => { task.title = '[POWER] ' + task.title; });
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const root = config(f).messageId;
    const powerId = getTaskTag(f.tasks[0]).id;
    f.tasks[0].title = '[STM32] Moved task';
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    await board.updateBoard(f.client, f.guild.id);
    let state = config(f);
    assert.equal(state.messageId, root);
    assert.equal(new Set(state.messageIds).size, state.messageIds.length);
    const stablePowerMessage = state.sectionMessageIds[`tag:${powerId}:0`];
    assert.notEqual(stablePowerMessage, root, 'a single-group root is not reused twice when an overview appears');
    const tasks = [{ ...f.tasks[0], id: 'added', issueKey: 'RC-4', title: '[DECISION] New first group' }, ...f.tasks];
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    await board.updateBoard(f.client, f.guild.id);
    state = config(f);
    assert.equal(state.sectionMessageIds[`tag:${powerId}:0`], stablePowerMessage);
    const payloads = board.generateBoardMessages(f.client, f.guild.id);
    const overview = network.messages.get(root).payload.embeds[0].toJSON();
    for (const [i, field] of overview.fields.entries()) {
        const tagId = payloads[0].indexTags[i];
        assert.ok(field.value.includes(`/channels/${f.guild.id}/board-channel/${state.sectionMessageIds[`tag:${tagId}:0`]}`));
    }
    validate(state.messageIds.map(id => network.messages.get(id).payload), tasks);
    const removedTask = tasks.shift();
    const removedId = state.sectionMessageIds[`tag:${getTaskTag(removedTask).id}:0`];
    f.client.taskStorage.saveTasks(f.guild.id, tasks);
    await board.updateBoard(f.client, f.guild.id);
    assert.ok(network.deleted.includes(removedId));
    assert.equal(config(f).sectionMessageIds[`tag:${powerId}:0`], stablePowerMessage);
    assert.equal(config(f).messageId, root);
    validate(config(f).messageIds.map(id => network.messages.get(id).payload), tasks);
});

test('unchanged boards skip edits, task changes update only affected messages, and Refresh forces all', async () => {
    const f = fixture(3);
    f.tasks.forEach((task, i) => { task.title = `[TAG ${i}] Title ${i}`; });
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    const network = fakeChannel(f);
    await board.execute(network.actor, ['setup']);
    const before = network.edits.length;
    await board.updateBoard(f.client, f.guild.id);
    assert.equal(network.edits.length, before);
    f.tasks[0].description = 'Details only appear in the task view';
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    await board.updateBoard(f.client, f.guild.id);
    assert.equal(network.edits.length, before);
    f.tasks[0].status = 'progress';
    f.client.taskStorage.saveTasks(f.guild.id, f.tasks);
    await board.updateBoard(f.client, f.guild.id);
    assert.equal(network.edits.length - before, 2, 'only the overview and changed tag are edited');
    const afterChange = network.edits.length;
    await board.updateBoard(f.client, f.guild.id, { force: true });
    assert.equal(network.edits.length - afterChange, config(f).messageIds.length);
});
