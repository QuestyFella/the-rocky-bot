const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// Set this before importing any application module: never read or write live data.
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-sound-'));
process.env.BOT_DATA_DIR = temporaryDir;
const { createSound, soundConfig, parseSoundCommand, speakable } = require('../utils/apolloSound');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));

let sequence = 0;
function fixture({ memberRoleId = null } = {}) {
    const soundDir = fs.mkdtempSync(path.join(temporaryDir, `sound-${++sequence}-`));
    fs.mkdirSync(path.join(soundDir, 'requests'));
    const clock = { t: 1_800_000_000_000 };
    const config = { channelIds: ['111111', '333333'], memberRoleId, soundDir, pollMs: 10 };
    const irc = Object.assign(new EventEmitter(), { said: [], say(text) { this.said.push(text); } });
    const sound = createSound({}, config, { irc, now: () => clock.t });
    // apollo-sound's side: what it has written, and the requests waiting for it
    const writeState = (fields = {}) => fs.writeFileSync(path.join(soundDir, 'state.json'),
        JSON.stringify({ updatedAt: clock.t, playing: null, queue: [], results: [], ...fields }));
    const requests = () => fs.readdirSync(path.join(soundDir, 'requests')).filter(name => !name.startsWith('.')).sort()
        .map(name => JSON.parse(fs.readFileSync(path.join(soundDir, 'requests', name), 'utf8')));
    return { clock, sound, irc, writeState, requests };
}

function discordMessage(content, extra = {}) {
    const reactions = [];
    const replies = [];
    return {
        reactions, replies, id: `m${++sequence}`, channelId: '111111', content, cleanContent: content,
        author: { id: '42', bot: false, username: 'sohum' },
        member: { displayName: 'Sohum K', roles: { cache: new Set(['member-role']) } },
        react: async emoji => reactions.push(emoji),
        reply: async ({ content: text }) => replies.push(text),
        ...extra
    };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const song = (id, title, by, byId, duration = 212) => ({ id, title, duration, by, byId, url: `https://www.youtube.com/watch?v=${id}` });

test('the speakers are off unless a room channel is configured', () => {
    assert.equal(soundConfig({}), null);
    assert.deepEqual(soundConfig({ APOLLO_BUZZ_CHANNEL_ID: '1552411621505368155', APOLLO_BRIDGE_CHANNEL_ID: '1552411621505368156' }).channelIds,
        ['1552411621505368155', '1552411621505368156']);
    assert.deepEqual(soundConfig({ APOLLO_BUZZ_CHANNEL_ID: '111111', APOLLO_SOUND_CHANNEL_IDS: '222222, 333333' }).channelIds, ['222222', '333333']);
    assert.equal(soundConfig({ APOLLO_BUZZ_CHANNEL_ID: '111111', APOLLO_SOUND_CHANNEL_IDS: '' }), null, 'empty turns them off');
    assert.equal(createSound({}, null), null);
    assert.deepEqual(parseSoundCommand('  !SAY  the  pizza is here '), { command: 'say', text: 'the pizza is here' });
    assert.deepEqual(parseSoundCommand('!np'), { command: 'queue', text: '' });
    assert.equal(parseSoundCommand('!player'), null);
    assert.equal(parseSoundCommand('hey !say hi'), null);
    assert.equal(speakable('look https://example.com/x <:rocket:123> now'), 'look a link rocket now');
});

test('nothing is sent while apollo-sound is not running', async () => {
    const f = fixture();
    const message = discordMessage('!say hello');
    assert.equal(f.sound.fromDiscord(message), true);
    await settle();
    assert.deepEqual(message.replies, ["apollo's speakers aren't running right now."]);
    f.writeState();
    f.clock.t += 61000;                                  // its state is a minute old: stopped
    f.sound.fromDiscord(message);
    await settle();
    assert.equal(message.replies.length, 2);
    assert.deepEqual(f.requests(), []);
});

test('!say speaks with the name, then waits out the cooldown', async () => {
    const f = fixture();
    f.writeState();
    const first = discordMessage('!say the pizza is here https://pizza.example');
    f.sound.fromDiscord(first);
    await settle();
    assert.deepEqual(first.reactions, ['🔊']);
    assert.deepEqual(f.requests().map(({ type, text, byId }) => ({ type, text, byId })),
        [{ type: 'say', text: 'Sohum K says: the pizza is here a link', byId: 'discord:42' }]);
    const again = discordMessage('!say me again');
    f.clock.t += 10000;
    f.writeState();
    f.sound.fromDiscord(again);
    await settle();
    assert.deepEqual(again.reactions, ['⏳']);
    assert.equal(f.requests().length, 1);
    f.clock.t += 21000;
    f.writeState();
    f.sound.fromDiscord(discordMessage('!say ok now'));
    await settle();
    assert.equal(f.requests().length, 2);
});

test('other channels, bots, webhooks and non-members are ignored or turned away', async () => {
    const f = fixture({ memberRoleId: 'member-role' });
    f.writeState();
    assert.equal(f.sound.fromDiscord(discordMessage('!say hi', { channelId: '999' })), false);
    assert.equal(f.sound.fromDiscord(discordMessage('!say hi', { author: { id: '1', bot: true, username: 'b' } })), false);
    assert.equal(f.sound.fromDiscord(discordMessage('!say hi', { webhookId: '5' })), false);
    assert.equal(f.sound.fromDiscord(discordMessage('say hi')), false);
    const guest = discordMessage('!say hi', { member: { displayName: 'Guest', roles: { cache: new Set() } } });
    assert.equal(f.sound.fromDiscord(guest), true);
    await settle();
    assert.deepEqual(guest.reactions, ['🚫']);
    assert.deepEqual(f.requests(), []);
});

test('!play queues the song and answers once apollo-sound has found it', async () => {
    const f = fixture();
    f.writeState();
    const message = discordMessage('!play <https://youtu.be/dQw4w9WgXcQ>');
    f.sound.fromDiscord(message);
    await settle();
    assert.deepEqual(message.reactions, ['🔎']);
    const [request] = f.requests();
    assert.deepEqual({ type: request.type, query: request.query, by: request.by }, { type: 'play', query: 'https://youtu.be/dQw4w9WgXcQ', by: 'Sohum K' });
    await f.sound.checkAnswers();
    assert.deepEqual(message.replies, [], 'no answer yet');
    f.writeState({ results: [{ id: request.id, ok: true, title: 'Never *Gonna* Give You Up', duration: 212, ahead: 2 }] });
    await f.sound.checkAnswers();
    assert.deepEqual(message.replies, ['🎵 **Never \\*Gonna\\* Give You Up** (3:32): 2 ahead of it']);
    await f.sound.checkAnswers();
    assert.equal(message.replies.length, 1, 'answered once');

    const long = discordMessage('!play a ten hour mix');
    f.sound.fromDiscord(long);
    await settle();
    f.writeState({ results: [{ id: f.requests().find(r => r.query === 'a ten hour mix').id, error: 'too-long', title: 'Mix', duration: 36000 }] });
    await f.sound.checkAnswers();
    assert.deepEqual(long.replies, ['**Mix** is 600:00 long; songs can be up to 10 minutes.']);

    const lost = discordMessage('!play something');
    f.sound.fromDiscord(lost);
    await settle();
    f.clock.t += 91000;
    f.writeState();
    await f.sound.checkAnswers();
    assert.deepEqual(lost.replies, ["apollo-sound didn't answer. Is it running?"]);
});

test('!skip: whoever queued the song skips it at once; anyone else needs a second vote', async () => {
    const f = fixture();
    const send = async (content, author) => {
        const message = discordMessage(content, author ? { author, member: { displayName: author.username } } : {});
        f.sound.fromDiscord(message);
        await settle();
        return message.replies.at(-1);
    };
    f.writeState();
    assert.equal(await send('!skip'), "Nothing's playing.");
    f.writeState({ playing: song('s1', 'Song One', 'Ish', 'irc:ish') });
    assert.equal(await send('!skip'), 'Skip **Song One**? 1/2 votes: one more !skip from someone else skips it.');
    assert.equal(await send('!skip'), 'Skip **Song One**? 1/2 votes: one more !skip from someone else skips it.', 'the same person twice is one vote');
    assert.deepEqual(f.requests(), []);
    assert.equal(await send('!skip', { id: '7', bot: false, username: 'sai' }), '⏭️ Skipping **Song One**.');
    assert.deepEqual(f.requests().map(({ type, songId }) => ({ type, songId })), [{ type: 'skip', songId: 's1' }]);
    // Whoever queued it skips it alone.
    f.writeState({ playing: song('s2', 'Song Two', 'Sohum K', 'discord:42') });
    assert.equal(await send('!skip'), '⏭️ Skipping **Song Two**.');
    assert.equal(f.requests().length, 2);
});

test('#lobby on IRC: the same commands, answered on IRC', async () => {
    const f = fixture();
    f.sound.start();
    f.sound.stop();          // the IRC listener goes away with stop()
    f.sound.start();
    f.writeState({ playing: song('s1', 'Song One', 'Ish', 'irc:ish'), queue: [song('s2', 'Song *Two*', 'Sohum K', 'discord:42', 65)] });
    f.irc.emit('message', { nick: 'Sai', text: '!say hello room' });
    f.irc.emit('message', { nick: 'Sai', text: '!queue' });
    f.irc.emit('message', { nick: 'Sai', text: 'just chatting' });
    await settle();
    f.sound.stop();
    assert.deepEqual(f.requests().map(({ text, byId }) => ({ text, byId })), [{ text: 'Sai says: hello room', byId: 'irc:sai' }]);
    assert.deepEqual(f.irc.said, [
        'Sai: saying it in the club room',
        'Sai: ▶ Song One (3:32), from Ish',
        'Sai: 1. Song *Two* (1:05), from Sohum K'
    ]);
});
