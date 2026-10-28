const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection, MessageFlags, PermissionsBitField, PermissionFlagsBits, ModalSubmitFields, ModalSubmitInteraction } = require('discord.js');

// Set this before importing any application module: never read or write live data.
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-named-boards-'));
process.env.BOT_DATA_DIR = temporaryDir;
const TaskStorage = require('../taskStorage');
const board = require('../commands/board');
const { handleBoardInteraction } = require('../utils/boardInteractions');
const { getTaskBoard, getTaskStatus, isBoardName } = require('../utils/kanban');
const { prepareImport, buildImportPreview } = require('../utils/taskImport');
const { applyPlan, summarize } = require('../scripts/apply-board-plan');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));

const names = ['main', 'exec', 'liquid-rocket', 'rocketry'];
const configFile = path.join(temporaryDir, 'kanbanBoards.json');
const disk = () => fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
const components = payload => (payload.components || []).flatMap(row => (row.toJSON ? row.toJSON() : row).components);
const boardText = payloads => payloads.flatMap(payload => payload.embeds || []).map(embed => {
    const value = embed.toJSON ? embed.toJSON() : embed;
    return [value.title, value.description, ...(value.fields || []).flatMap(field => [field.name, field.value])].filter(Boolean).join('\n');
}).join('\n');
let sequence = 0;

function fixture() {
    const guild = { id: `named-guild-${++sequence}`, name: 'Rocket Club', roles: { cache: new Collection() } };
    const channels = new Map();
    const events = [];
    const client = {
        user: { id: 'bot' }, taskStorage: new TaskStorage(path.join(temporaryDir, guild.id)), serverConfigs: {},
        guilds: { cache: new Collection([[guild.id, guild]]) },
        channels: { fetch: async id => { assert.ok(channels.has(id), `unknown channel ${id}`); return channels.get(id); } }
    };
    function channel(name) {
        const id = `${guild.id}-${name}`;
        if (!channels.has(id)) {
            const sent = new Map();
            let nextId = 0;
            channels.set(id, {
                id, sent,
                messages: { fetch: async messageId => {
                    if (!sent.has(messageId)) throw Object.assign(new Error('Unknown message'), { code: 10008 });
                    return sent.get(messageId);
                } },
                send: async payload => {
                    const message = {
                        id: `${id}-m${++nextId}`, author: client.user, payload,
                        edit: async value => { events.push(['edit', message.id]); message.payload = value; },
                        delete: async () => { events.push(['delete', message.id]); sent.delete(message.id); }
                    };
                    sent.set(message.id, message);
                    events.push(['send', message.id]);
                    return message;
                }
            });
        }
        return channels.get(id);
    }
    async function run(name, args, { manager = true, userId = 'admin', content = `!task ${args.join(' ')}` } = {}) {
        const replies = [];
        await board.execute({
            client, guild, channel: channel(name), content, author: { id: userId },
            member: { permissions: new PermissionsBitField(manager ? [PermissionFlagsBits.ManageGuild] : []) },
            mentions: { users: new Collection() }, reply: async payload => replies.push(payload)
        }, [...args]);
        return replies.at(-1);
    }
    return {
        client, guild, channel, run, events,
        setup: async (boards = names) => { for (const name of boards) await run(name, name === 'main' ? ['setup'] : ['setup', name]); },
        config: () => JSON.parse(disk())[guild.id],
        tasks: () => client.taskStorage.getAllTasks(guild.id),
        payloads: name => [...channel(name).sent.values()].map(message => message.payload)
    };
}

// Pause only the first send, before posting anything. Later sends remain observable
// so an unqueued competing setup cannot accidentally hide behind the same barrier.
function deferNextSend(channel) {
    let entered, release, reject;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    const send = channel.send.bind(channel);
    channel.send = async payload => {
        channel.send = send;
        entered();
        await pending;
        return send(payload);
    };
    return { started, release, reject };
}

async function interact(f, name, customId, { type = 'button', userId = 'alice', manager = false, values = [], fields, privateMessage = true } = {}) {
    const responses = [];
    const permissions = new PermissionsBitField(manager ? [PermissionFlagsBits.ManageGuild] : []);
    const interaction = {
        customId, client: f.client, guild: f.guild, guildId: f.guild.id, channelId: f.channel(name).id,
        user: { id: userId }, member: { pending: false, permissions }, memberPermissions: permissions, values, fields,
        message: { flags: { has: flag => privateMessage && flag === MessageFlags.Ephemeral } },
        inGuild: () => true, isButton: () => type === 'button', isStringSelectMenu: () => type === 'select', isModalSubmit: () => type === 'modal',
        reply: async payload => responses.push(['reply', payload]), editReply: async payload => responses.push(['editReply', payload]),
        deferReply: async () => responses.push(['deferReply']), deferUpdate: async () => responses.push(['deferUpdate']),
        showModal: async modal => responses.push(['modal', modal])
    };
    assert.equal(await handleBoardInteraction(interaction), true);
    assert.equal(responses.filter(([kind]) => ['reply', 'deferReply', 'deferUpdate', 'modal'].includes(kind)).length, 1, 'acknowledge exactly once');
    return { kind: responses.at(-1)[0], payload: responses.at(-1)[1] };
}

function modalFields(modal, values) {
    return new ModalSubmitFields(modal.toJSON().components.map(label => ModalSubmitInteraction.transformComponent({
        ...label, component: { ...label.component, value: values[label.component.custom_id] ?? label.component.value ?? '' }
    }, {})));
}

test('task board identity preserves named and legacy strings, with main as the default', () => {
    assert.equal(getTaskBoard({}), 'main');
    for (const name of [...names, 'archived-project']) assert.equal(getTaskBoard({ board: name }), name);
});

test('setup persists two named boards without replacing main or exec, and repeating setup reuses messages', async () => {
    const f = fixture();
    assert.equal(board.boardForChannel(f.guild.id, f.channel('liquid-rocket').id), 'main');
    await f.setup(['main', 'exec']);
    const legacy = f.config();
    await f.run('liquid-rocket', ['setup', 'LIQUID-ROCKET']);
    await f.setup(['rocketry']);
    const config = f.config();
    assert.equal(config.channelId, legacy.channelId);
    assert.equal(config.messageId, legacy.messageId);
    assert.deepEqual(config.messageIds, legacy.messageIds);
    assert.deepEqual(config.boards.exec, legacy.boards.exec);
    assert.equal(config.projectKey, legacy.projectKey);
    assert.equal(config.title, legacy.title);
    assert.deepEqual(Object.keys(config.boards).sort(), ['exec', 'liquid-rocket', 'rocketry']);
    for (const name of names) {
        const slot = name === 'main' ? config : config.boards[name];
        assert.equal(slot.channelId, f.channel(name).id);
        assert.deepEqual(slot.messageIds, [...f.channel(name).sent.keys()]);
        assert.equal(slot.messageId, slot.messageIds[0]);
        assert.equal(board.boardForChannel(f.guild.id, slot.channelId), name);
    }
    assert.equal(board.boardForChannel(f.guild.id, 'unconfigured-channel'), 'main');
    assert.equal(board.boardForChannel('another-guild', f.channel('rocketry').id), 'main');
    const sends = f.events.filter(([event]) => event === 'send').length;
    await f.setup();
    assert.equal(f.events.filter(([event]) => event === 'send').length, sends, 'setup must not orphan existing messages');
    assert.deepEqual(f.config(), config);
});

test('setup refuses duplicate names and occupied channels without writes or Discord changes', async () => {
    const f = fixture();
    await f.setup();
    const before = disk();
    const eventCount = f.events.length;
    for (const [channel, name] of [
        ['spare', 'liquid-rocket'], ['spare', 'rocketry'], ['spare', 'main'], ['spare', 'exec'],
        ['liquid-rocket', 'new-project'], ['liquid-rocket', 'rocketry'], ['rocketry', 'main'], ['main', 'new-project'], ['exec', 'new-project']
    ]) {
        const reply = await f.run(channel, ['setup', name]);
        assert.match(reply, /already|different channel|in use|occupied/i);
        assert.equal(disk(), before, `${channel}/${name} changed persisted config`);
        assert.equal(f.events.length, eventCount, `${channel}/${name} changed Discord messages`);
    }
});

test('concurrent setup of different names in one channel keeps only the first board', async () => {
    const f = fixture();
    await f.setup(['main', 'exec']);
    const before = f.config();
    const channel = f.channel('liquid-rocket');
    const barrier = deferNextSend(channel);
    const first = f.run('liquid-rocket', ['setup', 'liquid-rocket']);
    await barrier.started;
    const second = f.run('liquid-rocket', ['setup', 'rocketry']);
    barrier.release();
    const [created, rejected] = await Promise.all([first, second]);
    assert.match(created, /board created/i);
    assert.match(rejected, /already.*liquid-rocket/i);
    assert.equal(channel.sent.size, 1, 'the rejected board must not post a message');
    const [id] = channel.sent.keys();
    assert.deepEqual(f.config(), {
        ...before,
        boards: { ...before.boards, 'liquid-rocket': { channelId: channel.id, messageId: id, messageIds: [id] } }
    });
    assert.equal(board.boardForChannel(f.guild.id, channel.id), 'liquid-rocket');
});

test('concurrent setup of one name in different channels keeps the first channel', async () => {
    const f = fixture();
    await f.setup(['main', 'exec']);
    const before = f.config();
    const channel = f.channel('liquid-rocket');
    const barrier = deferNextSend(channel);
    const first = f.run('liquid-rocket', ['setup', 'liquid-rocket']);
    await barrier.started;
    const second = f.run('spare', ['setup', 'liquid-rocket']);
    barrier.release();
    const [created, rejected] = await Promise.all([first, second]);
    assert.match(created, /board created/i);
    assert.match(rejected, /already/i);
    assert.ok(rejected.includes(`<#${channel.id}>`), 'rejection must identify the winning channel');
    assert.equal(channel.sent.size, 1);
    assert.equal(f.channel('spare').sent.size, 0, 'the rejected channel must not get an orphan board');
    const [id] = channel.sent.keys();
    assert.deepEqual(f.config(), {
        ...before,
        boards: { ...before.boards, 'liquid-rocket': { channelId: channel.id, messageId: id, messageIds: [id] } }
    });
    assert.equal(board.boardForChannel(f.guild.id, channel.id), 'liquid-rocket');
    assert.equal(board.boardForChannel(f.guild.id, f.channel('spare').id), 'main');
});

for (const args of [['setup', 'liquid-rocket'], ['setup']]) {
    test(`concurrent ${args.join(' ')} in the same channel refreshes the newly created board without duplicates`, async () => {
        const f = fixture();
        await f.setup(['main', 'exec']);
        const before = f.config();
        const channel = f.channel('liquid-rocket');
        const eventCount = f.events.length;
        const barrier = deferNextSend(channel);
        const first = f.run('liquid-rocket', ['setup', 'liquid-rocket']);
        await barrier.started;
        const second = f.run('liquid-rocket', args);
        barrier.release();
        const [created, refreshed] = await Promise.all([first, second]);
        assert.match(created, /board created/i);
        assert.match(refreshed, /refreshed/i);
        assert.equal(channel.sent.size, 1);
        assert.equal(f.events.slice(eventCount).filter(([event]) => event === 'send').length, 1, 'only the initial setup may send');
        assert.equal(f.events.slice(eventCount).filter(([event]) => event === 'delete').length, 0, 'refresh must not replace the original message');
        const [id] = channel.sent.keys();
        assert.deepEqual(f.config(), {
            ...before,
            boards: { ...before.boards, 'liquid-rocket': { channelId: channel.id, messageId: id, messageIds: [id] } }
        });
        assert.equal(board.boardForChannel(f.guild.id, channel.id), 'liquid-rocket');
    });
}

test('a rejected setup send does not poison the queue or reserve the name or channel', async () => {
    const f = fixture();
    await f.setup(['main', 'exec']);
    const before = f.config();
    const channel = f.channel('liquid-rocket');
    const barrier = deferNextSend(channel);
    const first = f.run('liquid-rocket', ['setup', 'liquid-rocket']);
    const failed = assert.rejects(first, { message: 'Discord send failed' });
    await barrier.started;
    const second = f.run('spare', ['setup', 'liquid-rocket']);
    barrier.reject(new Error('Discord send failed'));
    const [, created] = await Promise.all([failed, second]);
    assert.match(created, /board created/i);
    assert.equal(channel.sent.size, 0, 'the failed send must not leave a board message');
    const winner = f.channel('spare');
    assert.equal(winner.sent.size, 1);
    const [id] = winner.sent.keys();
    assert.deepEqual(f.config(), {
        ...before,
        boards: { ...before.boards, 'liquid-rocket': { channelId: winner.id, messageId: id, messageIds: [id] } }
    });
    assert.equal(board.boardForChannel(f.guild.id, channel.id), 'main');
    assert.equal(board.boardForChannel(f.guild.id, winner.id), 'liquid-rocket');
    assert.match(await f.run('spare', ['setup']), /refreshed/i);
    assert.equal(winner.sent.size, 1);
    assert.match(await f.run('liquid-rocket', ['setup', 'rocketry']), /board created/i);
    assert.equal(board.boardForChannel(f.guild.id, channel.id), 'rocketry', 'the failed setup must not reserve its channel');
});

test('updates route all four task lists to separate titles and keep buttons on the last message', async () => {
    const f = fixture();
    await f.setup();
    for (const name of names) await f.run(name, ['add', `[TEST] Work for ${name}`]);
    const tasks = f.tasks();
    assert.deepEqual(tasks.map(getTaskBoard), names);
    assert.deepEqual(new TaskStorage(f.client.taskStorage.tasksDir).getAllTasks(f.guild.id), tasks, 'board identity survives disk reload');
    await board.updateBoard(f.client, f.guild.id);
    const titles = names.map(name => f.payloads(name)[0].embeds[0].toJSON().title);
    assert.equal(titles[0], '🚀 Rocket Club Task Board');
    assert.equal(titles[1], '🚀 Rocket Club Exec Board');
    assert.match(titles[2], /liquid[ -]rocket/i);
    assert.match(titles[3], /rocketry/i);
    assert.equal(new Set(titles).size, 4);
    for (const name of names) {
        const text = boardText(f.payloads(name));
        for (const task of tasks) assert.equal(text.includes(task.title.replace('[TEST] ', '')), getTaskBoard(task) === name);
        assert.deepEqual(components(f.payloads(name).at(-1)).map(component => component.custom_id), ['kanban:find:0', 'kanban:mine:0', 'kanban:add']);
        const found = await interact(f, name, 'kanban:find:0', { privateMessage: false });
        assert.deepEqual(components(found.payload).find(component => component.custom_id === 'kanban:select').options.map(option => option.value), tasks.filter(task => getTaskBoard(task) === name).map(task => task.id));
    }
    const originalIds = Object.fromEntries(names.map(name => [name, [...f.channel(name).sent.keys()]]));
    const extra = Array.from({ length: 150 }, (_, i) => ({ id: `extra-${i}`, issueKey: `X-${i}`, title: 'x'.repeat(150), board: 'liquid-rocket', status: 'todo' }));
    assert.equal(f.client.taskStorage.saveTasks(f.guild.id, [...tasks, ...extra]), true);
    await board.updateBoard(f.client, f.guild.id);
    assert.ok(f.payloads('liquid-rocket').length > 1);
    assert.ok(f.payloads('liquid-rocket').slice(0, -1).every(payload => components(payload).length === 0));
    assert.equal(components(f.payloads('liquid-rocket').at(-1)).length, 3);
    for (const name of ['main', 'exec', 'rocketry']) assert.deepEqual([...f.channel(name).sent.keys()], originalIds[name]);
    assert.equal(f.client.taskStorage.saveTasks(f.guild.id, tasks), true);
    await board.updateBoard(f.client, f.guild.id);
    assert.deepEqual([...f.channel('liquid-rocket').sent.keys()], originalIds['liquid-rocket']);
});

test('named-board modal creation, claim and done work, but other boards cannot view or change the task', async () => {
    const f = fixture();
    await f.setup();
    const opened = await interact(f, 'liquid-rocket', 'kanban:add', { privateMessage: false });
    assert.equal(opened.kind, 'modal');
    await interact(f, 'liquid-rocket', opened.payload.toJSON().custom_id, {
        type: 'modal', fields: modalFields(opened.payload, { title: '[ENGINE] Pressure test', description: 'Named board only', due: '2026-12-01' })
    });
    const task = f.tasks()[0];
    assert.equal(task.board, 'liquid-rocket');
    assert.equal(task.title, '[ENGINE] Pressure test');
    assert.equal(task.dueDate, '2026-12-01');
    const before = JSON.stringify(f.tasks());
    for (const name of ['main', 'exec', 'rocketry']) {
        assert.match(await f.run(name, ['claim', task.issueKey]), /could not find/i);
        for (const action of ['view', 'claim', 'done', 'edit', 'deleteconfirm']) {
            const denied = await interact(f, name, `kanban:${action}:${task.id}`, { manager: true });
            assert.match(denied.payload.content, /no longer exists|not found|different board/i);
            assert.doesNotMatch(boardText([denied.payload]), /Pressure test|Named board only/);
        }
        const denied = await interact(f, name, 'kanban:select', { type: 'select', values: [task.id] });
        assert.match(denied.payload.content, /no longer exists|not found|different board/i);
        assert.equal(JSON.stringify(f.tasks()), before);
    }
    assert.match((await interact(f, 'liquid-rocket', `kanban:done:${task.id}`, { userId: 'carol' })).payload.content, /Only the people/);
    assert.equal(getTaskStatus(f.tasks()[0]), 'todo');
    await interact(f, 'liquid-rocket', `kanban:claim:${task.id}`, { userId: 'bob' });
    assert.deepEqual(f.tasks()[0].userIds, ['bob']);
    assert.equal(getTaskStatus(f.tasks()[0]), 'progress');
    await interact(f, 'liquid-rocket', `kanban:done:${task.id}`, { userId: 'bob' });
    assert.equal(getTaskStatus(f.tasks()[0]), 'done');
    assert.equal(f.tasks()[0].board, 'liquid-rocket');
});

test('imports deduplicate within each board and reject confirmations from another board or person', async () => {
    const f = fixture();
    await f.setup();
    const actor = name => ({ client: f.client, guild: f.guild, author: { id: 'admin' }, board: name });
    for (const name of names) {
        const { draft } = prepareImport(actor(name), 'Title: [TEST] Shared title\nTitle: [test]  shared title');
        assert.equal(draft.board, name);
        assert.match(buildImportPreview(actor(name), draft).content, /1 new task\(s\)/);
        const result = await interact(f, name, `kanban:importconfirm:${draft.id}`, { userId: 'admin', privateMessage: false });
        assert.match(result.payload.content, /Imported \*\*1 task/);
    }
    assert.deepEqual(f.tasks().map(getTaskBoard), names);
    const { draft } = prepareImport(actor('liquid-rocket'), 'Title: [TEST] Shared title\nTitle: [TEST] New import');
    const before = JSON.stringify(f.tasks());
    const beforeDisk = disk();
    for (const [name, userId] of [['rocketry', 'admin'], ['main', 'admin'], ['liquid-rocket', 'carol']]) {
        const denied = await interact(f, name, `kanban:importconfirm:${draft.id}`, { userId, privateMessage: false });
        assert.equal(denied.kind, 'reply');
        assert.equal(denied.payload.flags, MessageFlags.Ephemeral);
        assert.match(denied.payload.content, /board|channel|Only the person/i);
        assert.equal(JSON.stringify(f.tasks()), before);
        assert.equal(disk(), beforeDisk);
        assert.ok(f.client.taskImports.has(draft.id), 'denial must not consume the draft');
    }
    const result = await interact(f, 'liquid-rocket', `kanban:importconfirm:${draft.id}`, { userId: 'admin', privateMessage: false });
    assert.match(result.payload.content, /Imported \*\*1 task/);
    assert.match(result.payload.content, /Skipped 1 duplicate/);
    assert.equal(f.tasks().at(-1).board, 'liquid-rocket');
    assert.equal(f.client.taskImports.has(draft.id), false);
});

test('named-board notices are scoped and require Manage Server permission', async () => {
    const f = fixture();
    await f.setup();
    await f.run('liquid-rocket', ['notice', 'set'], { content: '!task notice set # Liquid team\nCheck the pressure limits.' });
    await f.run('rocketry', ['notice', 'on']);
    assert.equal(f.config().boards['liquid-rocket'].noticeText, '# Liquid team\nCheck the pressure limits.');
    assert.match(boardText(f.payloads('liquid-rocket')), /Liquid team\nCheck the pressure limits/);
    assert.match(boardText(f.payloads('rocketry')), /How this board works/);
    for (const name of ['main', 'exec', 'rocketry']) assert.doesNotMatch(boardText(f.payloads(name)), /Liquid team|pressure limits/);
    for (const name of ['main', 'exec']) assert.doesNotMatch(boardText(f.payloads(name)), /How this board works/);
    const before = disk();
    const events = f.events.length;
    assert.match(await f.run('liquid-rocket', ['notice', 'off'], { manager: false }), /Manage Server/);
    assert.equal(disk(), before);
    assert.equal(f.events.length, events);
    await f.run('liquid-rocket', ['notice', 'off']);
    assert.doesNotMatch(boardText(f.payloads('liquid-rocket')), /Liquid team/);
    assert.match(boardText(f.payloads('rocketry')), /How this board works/);
    await f.run('liquid-rocket', ['notice', 'on']);
    assert.match(boardText(f.payloads('liquid-rocket')), /Liquid team/);
});

test('setup validates board names and permissions before changing config or posting', async () => {
    const f = fixture();
    await f.setup();
    const before = disk();
    const events = f.events.length;
    assert.match(await f.run('spare', ['setup', 'new-project'], { manager: false }), /Manage Server/);
    assert.equal(disk(), before);
    assert.equal(f.events.length, events);
    for (const name of ['-bad', 'bad_name', 'bad.name', 'bad/name', 'a:b', 'équipe', 'a'.repeat(41), '__proto__', 'prototype', 'constructor', 'CONSTRUCTOR']) {
        const reply = await f.run('spare', ['setup', name]);
        assert.equal(typeof reply, 'string');
        assert.match(reply, /name|invalid|reserved|letters|characters/i);
        assert.equal(disk(), before, `invalid name ${name} changed config`);
        assert.equal(f.events.length, events, `invalid name ${name} changed messages`);
    }
    for (const name of ['', 'has space', 'UPPERCASE']) assert.equal(isBoardName(name), false);
    for (const name of ['a', '7', '1-engine', 'a'.repeat(40)]) {
        assert.equal(isBoardName(name), true);
        await f.run(name, ['setup', name]);
        assert.equal(f.config().boards[name].channelId, f.channel(name).id);
    }
});

test('board plans accept and summarize named boards without mutating input tasks', () => {
    const tasks = [{ id: '1', issueKey: 'RC-1', title: '[ENGINE] Existing' }];
    const result = applyPlan(tasks, [
        { key: 'RC-1', board: 'liquid-rocket' },
        { new: 'flight', title: '[FLIGHT] Launch', board: 'rocketry' }
    ], { projectKey: 'RC', nextIssueNumber: 2 });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tasks.map(getTaskBoard), ['liquid-rocket', 'rocketry']);
    assert.equal(tasks[0].board, undefined);
    const summary = summarize(result);
    assert.match(summary, /liquid-rocket board \(1 tasks\)/);
    assert.match(summary, /rocketry board \(1 tasks\)/);
    assert.match(summary, /RC-1.*Existing/);
    assert.match(summary, /RC-2.*Launch/);
    for (const name of ['constructor', '__proto__', '-bad', 'a'.repeat(41)]) assert.ok(applyPlan(tasks, [{ key: 'RC-1', board: name }]).errors.length);
});

test('launch countdown: managers set and clear it, everyone can see it', async () => {
    const f = fixture();
    assert.match(await f.run('main', ['launch']), /No launch countdown/);
    assert.match(await f.run('main', ['launch', 'set', '2026-12-01', 'HAB'], { manager: false }), /Manage Server/);
    assert.equal(f.config()?.launch, undefined);
    assert.match(await f.run('main', ['launch', 'set', '2026-12-01', '14:30', 'HAB', 'launch', 'window']), /Countdown set: \*\*HAB launch window\*\* on 2026-12-01 at 14:30/);
    assert.deepEqual(f.config().launch, { date: '2026-12-01', time: '14:30', name: 'HAB launch window', setBy: 'admin' });
    assert.match(await f.run('main', ['launch'], { manager: false }), /HAB launch window/);
    await f.run('main', ['launch', 'set', '2027-03-10']);
    assert.deepEqual(f.config().launch, { date: '2027-03-10', time: null, name: 'Launch', setBy: 'admin' });
    for (const bad of [['set', '2026-13-01'], ['set'], ['set', '2026-12-01', '25:00', 'x'], ['soon']]) {
        assert.match(await f.run('main', ['launch', ...bad]), /Usage/);
    }
    assert.match(await f.run('main', ['launch', 'clear']), /cleared/);
    assert.equal(f.config().launch, undefined);
});
