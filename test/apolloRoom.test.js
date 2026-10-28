const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set this before importing any application module: never read or write live data.
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-room-'));
process.env.BOT_DATA_DIR = temporaryDir;
const { createRoom, roomConfig, isBuzz } = require('../utils/apolloRoom');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));

let sequence = 0;
function fixture({ clock = { t: 1_800_000_000_000 } } = {}) {
    const dir = fs.mkdtempSync(path.join(temporaryDir, `room-${++sequence}-`));
    const config = {
        buzzChannelId: '111111', shopChannelId: '222222', roomDir: dir,
        shopRequestFile: path.join(dir, 'shop-request.json'), stateFile: path.join(dir, 'state.json'), pollMs: 10
    };
    const sent = new Map();
    const log = [];
    let nextId = 0;
    const channel = {
        send: async ({ content }) => {
            const message = { id: `m${++nextId}`, content, edit: async ({ content: value }) => { log.push(['edit', message.id, value]); message.content = value; } };
            sent.set(message.id, message);
            log.push(['send', message.id, content]);
            return message;
        },
        messages: { fetch: async id => {
            if (!sent.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
            return sent.get(id);
        } }
    };
    const client = { channels: { fetch: async id => { assert.equal(id, '222222'); return channel; } } };
    const make = () => createRoom(client, config, { now: () => clock.t });
    const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const request = (open, id) => fs.writeFileSync(config.shopRequestFile, JSON.stringify({ id, open, at: clock.t }));
    return { config, clock, sent, log, make, read, request, dir };
}

function buzzMessage(content, extra = {}) {
    const reactions = [];
    return {
        reactions, id: `b${++sequence}`, channelId: '111111', content, cleanContent: content,
        author: { bot: false, username: 'sohum' }, member: { displayName: 'Sohum K' },
        react: async emoji => reactions.push(emoji), ...extra
    };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('the room features are off unless a channel is configured', () => {
    assert.equal(roomConfig({}), null);
    assert.equal(roomConfig({ APOLLO_BUZZ_CHANNEL_ID: 'door-alarm' }), null);
    assert.equal(roomConfig({ APOLLO_BUZZ_CHANNEL_ID: '1552411621505368155' }).shopChannelId, null);
    assert.equal(createRoom({}, null), null);
    assert.ok(isBuzz('!buzz') && isBuzz('  !BUZZ at the side door') && !isBuzz('!buzzer') && !isBuzz('hey !buzz'));
});

test('!buzz in the door channel rings the room with the name and note, and reacts', async () => {
    const f = fixture();
    const room = f.make();
    const message = buzzMessage('!buzz  at the   side door');
    assert.equal(room.fromDiscord(message), true);
    await settle();
    const buzz = f.read('buzz.json');
    assert.deepEqual({ ...buzz, at: undefined }, { id: message.id, name: 'Sohum K', note: 'at the side door', at: undefined });
    assert.deepEqual(message.reactions, ['🔔']);
});

test('buzzes elsewhere, from bots, or other commands are ignored, and spam waits for the cooldown', async () => {
    const f = fixture();
    const room = f.make();
    assert.equal(room.fromDiscord(buzzMessage('!buzz', { channelId: '999' })), false);
    assert.equal(room.fromDiscord(buzzMessage('!buzz', { author: { bot: true, username: 'b' } })), false);
    assert.equal(room.fromDiscord(buzzMessage('!buzzer')), false);
    assert.ok(!fs.existsSync(path.join(f.dir, 'buzz.json')));
    const first = buzzMessage('!buzz');
    room.fromDiscord(first);
    await settle();
    const spam = buzzMessage('!buzz');
    f.clock.t += 3000;
    room.fromDiscord(spam);
    await settle();
    assert.equal(f.read('buzz.json').id, first.id);
    assert.deepEqual(spam.reactions, ['⏳']);
    f.clock.t += 8000;
    const later = buzzMessage('!buzz');
    room.fromDiscord(later);
    await settle();
    assert.equal(f.read('buzz.json').id, later.id);
});

test('the keyboard request flips one shop message, edited in place, and the monitor sees the state', async () => {
    const f = fixture();
    const room = f.make();
    await room.checkShop();
    assert.equal(f.log.length, 0, 'nothing happens without a request');
    f.request(true, 'r1');
    await room.checkShop();
    assert.deepEqual(f.log, [['send', 'm1', 'shop open :D']]);
    assert.equal(f.read('shop.json').open, true);
    await room.checkShop();
    assert.equal(f.log.length, 1, 'the same request is applied once');
    f.request(false, 'r2');
    await room.checkShop();
    assert.deepEqual(f.log.at(-1), ['edit', 'm1', 'shop closed :(']);
    assert.equal(f.read('shop.json').open, false);
    // Someone deleted the message: the next change posts a new one.
    f.sent.delete('m1');
    f.request(true, 'r3');
    await room.checkShop();
    assert.deepEqual(f.log.at(-1), ['send', 'm2', 'shop open :D']);
    // A restarted bot remembers the message and the last request.
    const restarted = f.make();
    restarted.start();
    restarted.stop();
    await restarted.checkShop();
    assert.equal(f.log.length, 3, "nothing new after a restart");
    f.request(false, 'r4');
    await restarted.checkShop();
    assert.deepEqual(f.log.at(-1), ['edit', 'm2', 'shop closed :(']);
});

test('a failed shop update is retried later instead of every poll', async () => {
    const f = fixture();
    let failures = 0;
    const room = createRoom({ channels: { fetch: async () => { failures++; throw new Error('Missing Access'); } } }, f.config, { now: () => f.clock.t });
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
        f.request(true, 'r1');
        await room.checkShop();
        await room.checkShop();
        assert.equal(failures, 1);
        f.clock.t += 31000;
        await room.checkShop();
        assert.equal(failures, 2);
    } finally {
        console.error = original;
    }
    assert.match(errors[0], /Could not update the shop message/);
});
