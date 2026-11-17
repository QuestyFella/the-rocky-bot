// apollo's club-room speakers, played by the apollo-sound service on apollo (which also plays the !buzz tunes):
//   !say <text>     says "<name> says: <text>" out loud in the room
//   !play <song>    queues a YouTube search or link; !skip votes it off (whoever queued it skips it at once)
//   !queue or !np   what's playing and what's next
// Works in APOLLO_SOUND_CHANNEL_IDS (default: the !buzz and #lobby bridge channels) and in apollo's IRC #lobby,
// where everyone is a member logged in to apollo. APOLLO_MEMBER_ROLE_ID limits Discord to people with that role.
// Files it shares with apollo-sound (apollo/apollo-sound in this repository):
//   <APOLLO_SOUND_DIR>/requests/*.json   one per !say, !play or !skip, written here
//   <APOLLO_SOUND_DIR>/state.json         what's playing, the queue and answers to !play; rewritten every 15 seconds
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SAY_COOLDOWN_MS = 30000;
const MAX_SAY_CHARS = 200;
const SKIP_VOTES = 2;
const ANSWER_TIMEOUT_MS = 90000;
const STALE_MS = 60000;            // a state.json older than this means apollo-sound isn't running
const OFF_TEXT = "apollo's speakers aren't running right now.";

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function parseSoundCommand(content) {
    const match = String(content || '').trim().match(/^!(say|play|skip|queue|np)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const command = match[1].toLowerCase();
    return { command: command === 'np' ? 'queue' : command, text: (match[2] || '').replace(/\s+/g, ' ').trim() };
}

// What espeak reads out: links and custom emoji as words, never a whole URL.
function speakable(text) {
    return text.replace(/https?:\/\/\S+/g, 'a link').replace(/<a?:(\w+):\d+>/g, '$1').slice(0, MAX_SAY_CHARS).trim();
}

const minutes = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const escapeMarkdown = text => String(text).replace(/([\\*_~`|>])/g, '\\$1');

function playAnswer(result, markdown) {
    const title = markdown ? `**${escapeMarkdown(result.title)}**` : result.title;
    if (result.ok) return `🎵 ${title} (${minutes(result.duration)}): ${result.ahead ? `${result.ahead} ahead of it` : 'playing now'}`;
    switch (result.error) {
        case 'too-long': return `${title} is ${minutes(result.duration)} long; songs can be up to 10 minutes.`;
        case 'live': return "Live streams can't be queued.";
        case 'queue-full': return 'The queue is full (20 songs). Try again later.';
        case 'too-many': return 'You already have 3 songs in the queue.';
        case 'failed': return "Couldn't reach YouTube just now. Try again in a bit.";
        case 'no-answer': return "apollo-sound didn't answer. Is it running?";
        default: return "Couldn't find that on YouTube.";
    }
}

function queueText(state, markdown) {
    const song = s => `${markdown ? escapeMarkdown(s.title) : s.title} (${minutes(s.duration)}), from ${s.by}`;
    if (!state.playing) return "Nothing's playing. Start something with !play <song>.";
    const lines = [`▶ ${song(state.playing)}`, ...state.queue.slice(0, 5).map((s, i) => `${i + 1}. ${song(s)}`)];
    if (state.queue.length > 5) lines.push(`…and ${state.queue.length - 5} more`);
    return lines.join('\n');
}

function soundConfig(env = process.env) {
    const ids = list => String(list || '').split(',').map(id => id.trim()).filter(id => /^\d{5,25}$/.test(id));
    const channelIds = ids(env.APOLLO_SOUND_CHANNEL_IDS ?? [env.APOLLO_BUZZ_CHANNEL_ID, env.APOLLO_BRIDGE_CHANNEL_ID].join(','));
    if (!channelIds.length) return null;
    return {
        channelIds,
        memberRoleId: ids(env.APOLLO_MEMBER_ROLE_ID)[0] || null,
        soundDir: env.APOLLO_SOUND_DIR || '/var/lib/apollo-sound',
        pollMs: 1000
    };
}

// Returns null when no channel is configured. `irc` is the bridge's IRC client, for commands from #lobby.
function createSound(client, config = soundConfig(), { irc = null, now = Date.now } = {}) {
    if (!config) return null;
    const lastSay = new Map();       // person -> when they last used !say
    const skipVotes = new Map();     // song id -> people who voted to skip it
    const waiting = new Map();       // !play request id -> { answer, until }
    let timer = null;

    const readState = () => readJson(path.join(config.soundDir, 'state.json'));
    const running = state => Boolean(state && now() - state.updatedAt < STALE_MS);

    // Readers (apollo-sound) never see half a file: it skips names starting with a dot.
    function send(type, fields) {
        const id = crypto.randomUUID();
        const name = `${now()}-${id}.json`;
        const temporary = path.join(config.soundDir, 'requests', `.${name}.tmp`);
        fs.writeFileSync(temporary, JSON.stringify({ id, type, ...fields }), { mode: 0o644 });
        fs.renameSync(temporary, path.join(config.soundDir, 'requests', name));
        return id;
    }

    async function say(text, person, out) {
        const words = speakable(text);
        if (!words) return out.reply('Say what? !say <something>');
        const waited = now() - (lastSay.get(person.id) || 0);
        if (waited < SAY_COOLDOWN_MS) {
            return out.react('⏳', `wait ${Math.ceil((SAY_COOLDOWN_MS - waited) / 1000)}s before your next !say`);
        }
        lastSay.set(person.id, now());
        send('say', { text: `${person.name} says: ${words}`, by: person.name, byId: person.id });
        return out.react('🔊', 'saying it in the club room');
    }

    async function play(text, person, out) {
        const query = text.replace(/^<(\S+)>$/, '$1');                  // Discord's no-preview links
        if (!query) return out.reply('Play what? !play <song name or YouTube link>');
        const id = send('play', { query, by: person.name, byId: person.id });
        waiting.set(id, { answer: result => out.reply(playAnswer(result, out.markdown)), until: now() + ANSWER_TIMEOUT_MS });
        return out.react('🔎');
    }

    async function skip(state, person, out) {
        const song = state.playing;
        if (!song) return out.reply("Nothing's playing.");
        for (const id of skipVotes.keys()) if (id !== song.id) skipVotes.delete(id);
        const votes = skipVotes.get(song.id) || new Set();
        skipVotes.set(song.id, votes.add(person.id));
        const title = out.markdown ? `**${escapeMarkdown(song.title)}**` : song.title;
        if (song.byId !== person.id && votes.size < SKIP_VOTES) {
            return out.reply(`Skip ${title}? ${votes.size}/${SKIP_VOTES} votes: one more !skip from someone else skips it.`);
        }
        skipVotes.delete(song.id);
        send('skip', { songId: song.id, by: person.name, byId: person.id });
        return out.reply(`⏭️ Skipping ${title}.`);
    }

    async function handle({ command, text }, person, out) {
        const state = readState();
        if (!running(state)) return out.reply(OFF_TEXT);
        if (command === 'queue') return out.reply(queueText(state, out.markdown));
        if (command === 'say') return say(text, person, out);
        if (command === 'play') return play(text, person, out);
        return skip(state, person, out);
    }

    // Answers to !play, once apollo-sound has looked the song up.
    function checkAnswers() {
        if (!waiting.size) return Promise.resolve();
        const results = readState()?.results || [];
        const answers = [];
        for (const [id, wait] of waiting) {
            const result = results.find(r => r.id === id) || (now() > wait.until ? { error: 'no-answer' } : null);
            if (!result) continue;
            waiting.delete(id);
            answers.push(Promise.resolve(wait.answer(result)).catch(error => console.error('[sound] Could not answer:', error.message)));
        }
        return Promise.all(answers);
    }

    function fromIrc({ nick, text }) {
        const parsed = parseSoundCommand(text);
        if (!parsed) return;
        const out = {
            markdown: false,
            reply: async answer => { for (const line of answer.split('\n')) irc.say(`${nick}: ${line}`); },
            react: async (emoji, words) => { if (words) irc.say(`${nick}: ${words}`); }
        };
        handle(parsed, { id: `irc:${nick.toLowerCase()}`, name: nick }, out)
            .catch(error => console.error('[sound] IRC command failed:', error.message));
    }

    return {
        checkAnswers,
        start() {
            irc?.on('message', fromIrc);
            if (!timer) {
                timer = setInterval(checkAnswers, config.pollMs);
                timer.unref?.();
            }
        },
        stop() {
            irc?.off('message', fromIrc);
            clearInterval(timer);
            timer = null;
        },
        // Called for every Discord message; returns true for a speaker command it handled.
        fromDiscord(message) {
            if (!config.channelIds.includes(message.channelId) || message.author?.bot || message.webhookId) return false;
            const parsed = parseSoundCommand(message.cleanContent ?? message.content);
            if (!parsed) return false;
            const out = {
                markdown: true,
                reply: answer => message.reply({ content: answer, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {}),
                react: emoji => message.react(emoji).catch(() => {})
            };
            if (config.memberRoleId && !message.member?.roles?.cache?.has(config.memberRoleId)) {
                out.react('🚫');
                return true;
            }
            const name = message.member?.displayName || message.author.globalName || message.author.username;
            handle(parsed, { id: `discord:${message.author.id}`, name }, out).catch(error => {
                console.error('[sound] Command failed:', error.message);
                out.react('⚠️');
            });
            return true;
        }
    };
}

module.exports = { createSound, soundConfig, parseSoundCommand, playAnswer, queueText, speakable };
