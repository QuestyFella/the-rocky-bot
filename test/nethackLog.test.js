const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set this before importing any application module: never read or write live data.
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-nethack-'));
process.env.BOT_DATA_DIR = temporaryDir;
const { createNethackLog, nethackConfig, parseXlog, describeGame } = require('../utils/nethackLog');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));

const xlog = fields => Object.entries({ version: '5.0.0', points: '1234', deathlev: '5', turns: '2345', role: 'Val',
    gender: 'Fem', name: 'sai', death: 'killed by a soldier ant', ...fields }).map(([k, v]) => `${k}=${v}`).join('\t') + '\n';

let sequence = 0;
function fixture({ existing = '' } = {}) {
    const xlogFile = path.join(temporaryDir, `xlogfile-${++sequence}`);
    if (existing !== null) fs.writeFileSync(xlogFile, existing);
    const posted = [];
    const client = { channels: { fetch: async id => {
        assert.equal(id, '333333');
        return { send: async ({ content }) => posted.push(content) };
    } } };
    const irc = { said: [], say(text) { this.said.push(text); } };
    const games = createNethackLog(client, { channelId: '333333', xlogFile, pollMs: 10 }, { irc });
    return { games, posted, irc, append: text => fs.appendFileSync(xlogFile, text), xlogFile };
}

test('announcements are off unless a channel is configured', () => {
    assert.equal(nethackConfig({}), null);
    assert.equal(nethackConfig({ APOLLO_BRIDGE_CHANNEL_ID: '333333' }).channelId, '333333');
    assert.equal(nethackConfig({ APOLLO_BRIDGE_CHANNEL_ID: '333333', APOLLO_NETHACK_CHANNEL_ID: '' }), null);
    assert.equal(createNethackLog({}, null), null);
});

test('how a game that ended reads', () => {
    assert.equal(parseXlog('name=sai\tdeath=killed by a newt, while helpless\tbad').death, 'killed by a newt, while helpless');
    assert.equal(describeGame(parseXlog(xlog({}).trimEnd())), '💀 sai the Valkyrie died on dungeon level 5: killed by a soldier ant (1,234 points, 2,345 turns)');
    assert.equal(describeGame(parseXlog(xlog({ role: 'Pri', death: 'quit', deathlev: '1' }).trimEnd())), '🏳️ sai the Priestess quit on dungeon level 1 (1,234 points, 2,345 turns)');
    assert.equal(describeGame(parseXlog(xlog({ role: 'Cav', gender: 'Mal', death: 'ascended', points: '3000000' }).trimEnd())), '🏆 sai the Caveman ASCENDED! (3,000,000 points, 2,345 turns)');
    assert.equal(describeGame(parseXlog(xlog({ death: 'killed by Famine', deathlev: '-5' }).trimEnd())), '💀 sai the Valkyrie died in the endgame: killed by Famine (1,234 points, 2,345 turns)');
});

test('only games that end after the bot starts are announced, on Discord and IRC', async () => {
    const f = fixture({ existing: xlog({ name: 'old' }) });
    await f.games.check();
    assert.deepEqual(f.posted, []);
    f.append(xlog({ name: 'ish', role: 'Wiz', gender: 'Mal' }));
    await f.games.check();
    assert.deepEqual(f.posted, ['💀 ish the Wizard died on dungeon level 5: killed by a soldier ant (1,234 points, 2,345 turns)']);
    assert.deepEqual(f.irc.said, f.posted);
    // A line NetHack is still writing waits for its end.
    const line = xlog({ name: 'msa', role: 'Tou' });
    f.append(line.slice(0, 20));
    await f.games.check();
    assert.equal(f.posted.length, 1);
    f.append(line.slice(20));
    await f.games.check();
    assert.match(f.posted[1], /^💀 msa the Tourist/);
    // Started over (smaller than before): read from the top.
    fs.writeFileSync(f.xlogFile, xlog({ name: 'new' }));
    await f.games.check();
    assert.match(f.posted[2], /^💀 new the Valkyrie/);
    assert.equal(f.posted.length, 3);
});

test('before NetHack is installed it waits, then announces its first game', async () => {
    const f = fixture({ existing: null });
    await f.games.check();
    f.append(xlog({ name: 'first' }));
    await f.games.check();
    assert.equal(f.posted.length, 1);
    assert.match(f.posted[0], /^💀 first the Valkyrie/);
});
