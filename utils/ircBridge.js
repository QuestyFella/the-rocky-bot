// Relays chat between one Discord channel and an IRC channel (apollo's #lobby on its local ngircd).
// Discord -> IRC: "<Name> text". IRC -> Discord: through a webhook, so each person shows as "nick (apollo)";
// without Manage Webhooks the bot posts "**nick:** text" itself.
// Turned on by APOLLO_BRIDGE_CHANNEL_ID; the IRC side defaults to 127.0.0.1:6667 #lobby as "rocky".
const net = require('net');
const { EventEmitter } = require('events');

const WEBHOOK_NAME = 'apollo bridge';
const MAX_LINE_BYTES = 400;      // IRC lines are 512 bytes including the command and channel
const MAX_LINES = 8;             // a longer Discord message is cut short on IRC, not flooded
const SEND_INTERVAL_MS = 250;    // stay under ngircd's flood limit

// Keep text on one IRC line: no control characters (which also rules out injected commands).
function cleanIrc(text) {
    return String(text).replace(/[\x00-\x1f\x7f]/g, ' ');
}

// Split text into chunks of at most `bytes` UTF-8 bytes, preferring to break at spaces.
function splitBytes(text, bytes = MAX_LINE_BYTES) {
    const chunks = [];
    let rest = text;
    while (Buffer.byteLength(rest) > bytes) {
        let cut = 0;
        let size = 0;
        for (const char of rest) {
            const next = size + Buffer.byteLength(char);
            if (next > bytes) break;
            size = next;
            cut += char.length;
        }
        const space = rest.lastIndexOf(' ', cut);
        if (space > cut / 2) cut = space;
        chunks.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

// IRC formatting codes (bold, colours...) mean nothing on Discord.
function stripIrcFormatting(text) {
    return text.replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '').replace(/[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, '');
}

class IrcClient extends EventEmitter {
    constructor({ host = '127.0.0.1', port = 6667, nick = 'rocky', channel = '#lobby', reconnectMs = 5000 } = {}) {
        super();
        Object.assign(this, { host, port, wantedNick: nick, nick, channel, reconnectMs });
        this.queue = [];
        this.joined = false;
        this.stopped = true;
    }

    start() {
        this.stopped = false;
        this.connect();
    }

    connect() {
        clearTimeout(this.retryTimer);
        this.joined = false;
        this.nick = this.wantedNick;
        let buffer = '';
        const socket = this.socket = net.connect({ host: this.host, port: this.port });
        socket.setEncoding('utf8');
        socket.setKeepAlive(true, 60000);
        socket.on('connect', () => {
            this.raw(`NICK ${this.nick}`);
            this.raw(`USER ${this.wantedNick} 0 * :the-rocky-bot Discord bridge`);
        });
        socket.on('data', data => {
            buffer += data;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) if (line) this.handle(line);
        });
        socket.on('error', error => this.emit('warn', `IRC connection error: ${error.message}`));
        socket.on('close', () => {
            if (this.socket !== socket) return;
            this.joined = false;
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
            if (this.stopped) return;
            this.emit('warn', `IRC connection closed; retrying in ${Math.round(this.reconnectMs / 1000)}s`);
            this.retryTimer = setTimeout(() => this.connect(), this.reconnectMs);
        });
    }

    handle(line) {
        const match = line.match(/^(?::(\S+) )?(\S+)(?: (.*))?$/);
        if (!match) return;
        const [, prefix = '', command, params = ''] = match;
        const trailing = params.includes(' :') ? params.slice(params.indexOf(' :') + 2) : params.startsWith(':') ? params.slice(1) : '';
        const args = (params.startsWith(':') ? '' : params.split(' :')[0]).split(' ').filter(Boolean);
        if (command === 'PING') return this.raw(`PONG :${trailing || args[0] || ''}`);
        if (command === '001') {
            this.nick = args[0] || this.nick;
            return this.raw(`JOIN ${this.channel}`);
        }
        if (command === '433' || command === '432') {          // nick taken (or invalid): add an underscore
            this.nick = `${this.nick}_`.slice(0, 30);
            return this.raw(`NICK ${this.nick}`);
        }
        const from = prefix.split('!')[0];
        if (command === 'JOIN' && from === this.nick) {
            this.joined = true;
            this.emit('joined');
            return this.flush();
        }
        if (command === 'PRIVMSG' && args[0]?.toLowerCase() === this.channel.toLowerCase() && from !== this.nick) {
            const action = trailing.match(/^\x01ACTION ([^\x01]*)\x01?$/);
            if (trailing.startsWith('\x01') && !action) return;   // other CTCP requests
            this.emit('message', { nick: from, text: stripIrcFormatting(action ? action[1] : trailing), action: Boolean(action) });
        }
    }

    raw(line) {
        if (this.socket && !this.socket.destroyed) this.socket.write(`${cleanIrc(line)}\r\n`);
    }

    // Queue messages to the channel; they go out (paced) once joined.
    say(text) {
        for (const chunk of splitBytes(cleanIrc(text))) this.queue.push(chunk);
        this.queue.splice(0, Math.max(0, this.queue.length - 50));   // never build an endless backlog
        this.flush();
    }

    flush() {
        if (this.flushTimer || !this.joined || !this.queue.length) return;
        this.raw(`PRIVMSG ${this.channel} :${this.queue.shift()}`);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, SEND_INTERVAL_MS);
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (this.socket && !this.socket.destroyed) {
            this.raw('QUIT :bye');
            this.socket.end();
        }
    }
}

// How a Discord message reads on IRC: each line as "<Name> text", attachments as links.
function discordToIrcLines(message) {
    const name = cleanIrc(message.member?.displayName || message.author.globalName || message.author.username).replace(/\s+/g, '_');
    const text = [message.cleanContent ?? message.content ?? '', ...[...(message.attachments?.values?.() || [])].map(file => file.url)]
        .join('\n').split('\n').map(line => line.trim()).filter(Boolean);
    if (!text.length) return [];
    const lines = text.slice(0, MAX_LINES).map(line => `<${name}> ${line}`);
    if (text.length > MAX_LINES) lines.push(`<${name}> (… ${text.length - MAX_LINES} more lines on Discord)`);
    return lines;
}

function bridgeConfig(env = process.env) {
    const channelId = (env.APOLLO_BRIDGE_CHANNEL_ID || '').trim();
    if (!/^\d{5,25}$/.test(channelId)) return null;
    return {
        channelId,
        host: env.APOLLO_IRC_HOST || '127.0.0.1',
        port: Number(env.APOLLO_IRC_PORT) || 6667,
        nick: env.APOLLO_IRC_NICK || 'rocky',
        ircChannel: env.APOLLO_IRC_CHANNEL || '#lobby'
    };
}

// Returns null when the bridge is not configured.
function createBridge(client, config = bridgeConfig(), { reconnectMs } = {}) {
    if (!config) return null;
    const irc = new IrcClient({ host: config.host, port: config.port, nick: config.nick, channel: config.ircChannel, reconnectMs });
    let webhook;          // undefined: not looked up yet; null: can't use one (fall back to the bot)
    let channelPromise;

    irc.on('warn', text => console.warn(`[bridge] ${text}`));
    irc.on('joined', () => console.log(`[bridge] Joined ${config.ircChannel} as ${irc.nick}`));
    // One post at a time: keeps IRC's order on Discord, and only one webhook ever gets created.
    let posting = Promise.resolve();
    irc.on('message', message => {
        posting = posting.then(() => toDiscord(message)).catch(error => console.error('[bridge] Could not post to Discord:', error.message));
    });

    function channel() {
        channelPromise ||= client.channels.fetch(config.channelId).catch(error => {
            channelPromise = null;
            throw error;
        });
        return channelPromise;
    }

    async function getWebhook(target) {
        if (webhook !== undefined) return webhook;
        try {
            const hooks = await target.fetchWebhooks();
            webhook = hooks.find(hook => hook.name === WEBHOOK_NAME && hook.owner?.id === client.user.id)
                || await target.createWebhook({ name: WEBHOOK_NAME, reason: 'Relay apollo #lobby chat' });
        } catch (error) {
            console.warn(`[bridge] No webhook (${error.message}); posting as the bot. Give it Manage Webhooks in that channel.`);
            webhook = null;
        }
        return webhook;
    }

    async function toDiscord({ nick, text, action }) {
        const body = (action ? `*${text}*` : text).slice(0, 1900);
        if (!body.trim()) return;
        const target = await channel();
        const hook = await getWebhook(target);
        const allowedMentions = { parse: [] };
        if (hook) {
            try {
                return await hook.send({ content: body, username: `${nick} (apollo)`.slice(0, 80), allowedMentions });
            } catch (error) {
                if (error.code !== 10015) throw error;        // Unknown Webhook: someone deleted it
                webhook = undefined;
                return toDiscord({ nick, text, action });
            }
        }
        return target.send({ content: `**${nick}:** ${body}`, allowedMentions });
    }

    return {
        irc,
        start: () => irc.start(),
        stop: () => irc.stop(),
        // Called for every Discord message; only the bridged channel's human messages go to IRC.
        fromDiscord(message) {
            if (message.channelId !== config.channelId || message.author?.bot || message.webhookId || message.system) return false;
            for (const line of discordToIrcLines(message)) irc.say(line);
            return true;
        }
    };
}

module.exports = { IrcClient, bridgeConfig, createBridge, discordToIrcLines, splitBytes, stripIrcFormatting };
