const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { createBridge, bridgeConfig, discordToIrcLines, splitBytes, stripIrcFormatting } = require('../utils/ircBridge');

// A tiny IRC server: records what the bridge sends, answers registration and JOIN like ngircd.
async function fakeIrc({ takenNicks = [] } = {}) {
    const lines = [];
    const sockets = new Set();
    const waiters = [];
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', data => {
            buffer += data;
            const parts = buffer.split('\r\n');
            buffer = parts.pop();
            for (const line of parts) {
                lines.push(line);
                const [command, arg] = line.split(' ');
                if (command === 'NICK') {
                    if (takenNicks.includes(arg)) socket.write(`:irc 433 * ${arg} :Nickname already in use\r\n`);
                    else { socket.nick = arg; socket.write(`:irc 001 ${arg} :Welcome\r\n`); }
                }
                if (command === 'JOIN') socket.write(`:${socket.nick}!u@localhost JOIN ${arg}\r\n`);
                for (const waiter of [...waiters]) if (waiter.match(line)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(line); }
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port, lines,
        send: text => { for (const socket of sockets) socket.write(`${text}\r\n`); },
        drop: () => { for (const socket of sockets) socket.destroy(); },
        waitFor: pattern => {
            const found = lines.find(line => pattern.test(line));
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), 5000);
                waiters.push({ match: line => pattern.test(line), resolve: line => { clearTimeout(timer); resolve(line); } });
            });
        },
        close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); })
    };
}

function fakeDiscord({ webhooks = true } = {}) {
    const posted = [];
    const created = [];
    const channel = {
        id: '1234567890',
        send: async payload => posted.push({ via: 'bot', ...payload }),
        fetchWebhooks: async () => {
            if (!webhooks) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
            return { find: fn => created.find(fn) };
        },
        createWebhook: async ({ name }) => {
            const hook = { name, owner: { id: 'bot' }, send: async payload => posted.push({ via: 'webhook', ...payload }) };
            created.push(hook);
            return hook;
        }
    };
    return { posted, created, client: { user: { id: 'bot' }, channels: { fetch: async id => { assert.equal(id, channel.id); return channel; } } } };
}

const until = async check => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(check(), 'condition not reached');
};

function setup(t, irc, discord, extra = {}) {
    const bridge = createBridge(discord.client, { channelId: '1234567890', host: '127.0.0.1', port: irc.port, nick: 'rocky', ircChannel: '#lobby', ...extra }, { reconnectMs: 50 });
    t.after(() => bridge.stop());
    bridge.start();
    return bridge;
}

const discordMessage = (content, extra = {}) => ({
    channelId: '1234567890', content, cleanContent: content, author: { bot: false, username: 'sohum', globalName: 'Sohum' },
    member: { displayName: 'Sohum K' }, attachments: new Map(), ...extra
});

test('the bridge is off unless a Discord channel ID is configured', () => {
    assert.equal(bridgeConfig({}), null);
    assert.equal(bridgeConfig({ APOLLO_BRIDGE_CHANNEL_ID: 'general' }), null);
    assert.equal(createBridge({}, null), null);
    assert.deepEqual(bridgeConfig({ APOLLO_BRIDGE_CHANNEL_ID: '1234567890' }),
        { channelId: '1234567890', host: '127.0.0.1', port: 6667, nick: 'rocky', ircChannel: '#lobby' });
});

test('IRC messages reach Discord through a webhook under the IRC nick, without pinging anyone', async t => {
    const irc = await fakeIrc();
    t.after(() => irc.close());
    const discord = fakeDiscord();
    setup(t, irc, discord);
    await irc.waitFor(/^JOIN #lobby$/);
    irc.send(':ish!ish@localhost PRIVMSG #lobby :hello from \x02apollo\x02 @everyone');
    irc.send(':ish!ish@localhost PRIVMSG #lobby :\x01ACTION waves\x01');
    irc.send(':ish!ish@localhost PRIVMSG #lobby :\x01VERSION\x01');
    irc.send(':ish!ish@localhost PRIVMSG rocky :a private message');
    await until(() => discord.posted.length >= 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(discord.posted, [
        { via: 'webhook', content: 'hello from apollo @everyone', username: 'ish (apollo)', allowedMentions: { parse: [] } },
        { via: 'webhook', content: '*waves*', username: 'ish (apollo)', allowedMentions: { parse: [] } }
    ]);
    assert.equal(discord.created.length, 1, 'the webhook is created once and reused');
});

test('without Manage Webhooks the bot posts the messages itself', async t => {
    const irc = await fakeIrc();
    t.after(() => irc.close());
    const discord = fakeDiscord({ webhooks: false });
    setup(t, irc, discord);
    await irc.waitFor(/^JOIN #lobby$/);
    irc.send(':msa!msa@localhost PRIVMSG #lobby :board flashed');
    await until(() => discord.posted.length === 1);
    assert.deepEqual(discord.posted[0], { via: 'bot', content: '**msa:** board flashed', allowedMentions: { parse: [] } });
});

test('Discord messages in the bridged channel go to #lobby; bots, webhooks and other channels do not', async t => {
    const irc = await fakeIrc();
    t.after(() => irc.close());
    const bridge = setup(t, irc, fakeDiscord());
    await irc.waitFor(/^JOIN #lobby$/);
    assert.equal(bridge.fromDiscord(discordMessage('first line\nsecond line', { attachments: new Map([['1', { url: 'https://cdn/x.png' }]]) })), true);
    assert.equal(bridge.fromDiscord(discordMessage('from a bot', { author: { bot: true, username: 'b' } })), false);
    assert.equal(bridge.fromDiscord(discordMessage('relayed back', { webhookId: '9' })), false);
    assert.equal(bridge.fromDiscord(discordMessage('elsewhere', { channelId: '999' })), false);
    assert.equal(bridge.fromDiscord(discordMessage('injected\r\nQUIT :x')), true);
    await irc.waitFor(/^PRIVMSG #lobby :<Sohum_K> QUIT :x$/);
    const sent = irc.lines.filter(line => line.startsWith('PRIVMSG'));
    assert.deepEqual(sent, [
        'PRIVMSG #lobby :<Sohum_K> first line',
        'PRIVMSG #lobby :<Sohum_K> second line',
        'PRIVMSG #lobby :<Sohum_K> https://cdn/x.png',
        'PRIVMSG #lobby :<Sohum_K> injected',
        'PRIVMSG #lobby :<Sohum_K> QUIT :x'
    ]);
    assert.ok(!irc.lines.includes('QUIT :x'));
});

test('a taken nick gets an underscore, and the bridge reconnects and rejoins after a drop', async t => {
    const irc = await fakeIrc({ takenNicks: ['rocky'] });
    t.after(() => irc.close());
    const bridge = setup(t, irc, fakeDiscord());
    await irc.waitFor(/^JOIN #lobby$/);
    assert.equal(bridge.irc.nick, 'rocky_');
    irc.lines.length = 0;
    irc.drop();
    await irc.waitFor(/^JOIN #lobby$/);
    irc.send(':irc PING :12345');
    await irc.waitFor(/^PONG :12345$/);
    bridge.fromDiscord(discordMessage('still here'));
    await irc.waitFor(/still here/);
});

test('long Discord messages are split for IRC and capped', () => {
    const chunks = splitBytes('word '.repeat(200).trim(), 100);
    assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 100));
    assert.equal(chunks.join(' '), 'word '.repeat(200).trim());
    assert.ok(splitBytes('é'.repeat(300), 101).every(chunk => Buffer.byteLength(chunk) <= 101 && !chunk.includes('\uFFFD')));
    const lines = discordToIrcLines(discordMessage(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')));
    assert.equal(lines.length, 9);
    assert.equal(lines.at(-1), '<Sohum_K> (… 12 more lines on Discord)');
    assert.equal(stripIrcFormatting('\x0304,01red\x03 \x1fu\x1f'), 'red u');
});
