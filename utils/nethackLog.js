// NetHack on apollo: every game that ends (a new line in the shared xlogfile) is announced in #lobby,
// on Discord and on IRC. Turned on by APOLLO_NETHACK_CHANNEL_ID, which defaults to the bridge channel;
// APOLLO_NETHACK_XLOGFILE moves the file. Games that ended while the bot was down are not announced.
const fs = require('fs');

const ROLES = {
    Arc: 'Archeologist', Bar: 'Barbarian', Cav: ['Caveman', 'Cavewoman'], Hea: 'Healer', Kni: 'Knight', Mon: 'Monk',
    Pri: ['Priest', 'Priestess'], Ran: 'Ranger', Rog: 'Rogue', Sam: 'Samurai', Tou: 'Tourist', Val: 'Valkyrie', Wiz: 'Wizard'
};

// One xlogfile line: tab-separated name=value fields.
function parseXlog(line) {
    const game = {};
    for (const field of line.split('\t')) {
        const at = field.indexOf('=');
        if (at > 0) game[field.slice(0, at)] = field.slice(at + 1);
    }
    return game;
}

function describeGame(game) {
    const role = ROLES[game.role];
    const who = `${game.name || 'someone'} the ${Array.isArray(role) ? role[game.gender === 'Fem' ? 1 : 0] : role || game.role || 'adventurer'}`;
    const stats = `${Number(game.points || 0).toLocaleString('en-US')} points, ${Number(game.turns || 0).toLocaleString('en-US')} turns`;
    const where = Number(game.deathlev) > 0 ? `on dungeon level ${game.deathlev}` : 'in the endgame';
    const death = game.death || 'died';
    if (death === 'ascended') return `🏆 ${who} ASCENDED! (${stats})`;
    if (death === 'escaped') return `🚪 ${who} escaped the dungeon (${stats})`;
    if (death === 'quit') return `🏳️ ${who} quit ${where} (${stats})`;
    return `💀 ${who} died ${where}: ${death} (${stats})`;
}

function nethackConfig(env = process.env) {
    const channelId = String(env.APOLLO_NETHACK_CHANNEL_ID ?? env.APOLLO_BRIDGE_CHANNEL_ID ?? '').trim();
    if (!/^\d{5,25}$/.test(channelId)) return null;
    return { channelId, xlogFile: env.APOLLO_NETHACK_XLOGFILE || '/var/games/nethack/xlogfile', pollMs: 5000 };
}

// Returns null when no channel is configured. `irc` is the bridge's IRC client, if there is one.
function createNethackLog(client, config = nethackConfig(), { irc = null } = {}) {
    if (!config) return null;
    let offset = null;               // bytes of the file already seen; null until the first look
    let partial = Buffer.alloc(0);   // the start of a line NetHack hasn't finished writing
    let warned = false;
    let timer = null;
    let posting = Promise.resolve();

    function announce(text) {
        irc?.say(text);
        posting = posting.then(async () => {
            const channel = await client.channels.fetch(config.channelId);
            await channel.send({ content: text, allowedMentions: { parse: [] } });
        }).catch(error => console.error('[nethack] Could not post:', error.message));
    }

    function read(from, to) {
        const buffer = Buffer.alloc(to - from);
        const fd = fs.openSync(config.xlogFile, 'r');
        try {
            fs.readSync(fd, buffer, 0, buffer.length, from);
        } finally {
            fs.closeSync(fd);
        }
        return buffer;
    }

    function check() {
        try {
            const size = fs.statSync(config.xlogFile).size;
            if (offset === null) offset = size;          // games from before the bot started stay quiet
            if (size < offset) {                         // the file was started over
                offset = 0;
                partial = Buffer.alloc(0);
            }
            if (size > offset) {
                const text = Buffer.concat([partial, read(offset, size)]);
                offset = size;
                const end = text.lastIndexOf(0x0a) + 1;
                partial = text.subarray(end);
                for (const line of text.subarray(0, end).toString('utf8').split('\n')) {
                    if (line.trim()) announce(describeGame(parseXlog(line)));
                }
            }
        } catch (error) {
            if (error.code === 'ENOENT') offset ??= 0;   // not installed yet: announce from its very first game
            else if (!warned) {
                warned = true;
                console.warn(`[nethack] Can't read ${config.xlogFile}: ${error.message}`);
            }
        }
        return posting;
    }

    return {
        check,
        start() {
            check();
            if (!timer) {
                timer = setInterval(check, config.pollMs);
                timer.unref?.();
            }
        },
        stop() {
            clearInterval(timer);
            timer = null;
        }
    };
}

module.exports = { createNethackLog, nethackConfig, parseXlog, describeGame };
