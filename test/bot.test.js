const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Runs bot.js in its own process with temporary data and no token, so the real .env is never opened.
// The preload script can stand in for the Discord connection.
function runBot(t, preload = '') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-bot-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const preloadFile = path.join(dir, 'preload.js');
    fs.writeFileSync(preloadFile, preload);
    return spawnSync(process.execPath, ['--require', preloadFile, path.join(__dirname, '..', 'bot.js')], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, BOT_DATA_DIR: dir, BOT_ENV_FILE: path.join(dir, 'missing.env'), BOT_READY_FILE: '', DISCORD_TOKEN: '' }
    });
}

test('the bot exits with an error when it cannot log in to Discord', t => {
    const result = runBot(t);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not log in to Discord/);
});

test('a failed reply or a stray error is logged, and the bot keeps running', t => {
    // Instead of connecting, the stand-in login sends commands whose replies fail, as when the bot
    // cannot post in a channel or the command message was deleted before it answered.
    const result = runBot(t, `
        const { Client } = require(${JSON.stringify(require.resolve('discord.js'))});
        Client.prototype.login = async function () {
            const fail = async () => { throw new Error('Missing Permissions'); };
            const message = content => ({
                content, client: this, author: { id: 'admin', bot: false },
                guild: { id: 'guild', channels: { cache: new Map([['123', { id: '123' }]]) } },
                member: { permissions: { has: () => true } }, mentions: { channels: { first: () => undefined } },
                channel: { id: '123', send: fail }, reply: fail
            });
            setImmediate(() => {
                for (const content of ['!task help', '!task nonsense', '!task setchannel add 123']) this.emit('messageCreate', message(content));
                this.emit('error', new Error('Gateway hiccup'));
                Promise.reject(new Error('Stray rejection'));
                setTimeout(() => { console.log('still running'); process.exit(0); }, 500);
            });
            return 'token';
        };
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /still running/);
    for (const name of ['help', 'nonsense', 'setchannel']) assert.match(result.stderr, new RegExp(`Error executing command ${name}:`));
    assert.doesNotMatch(result.stderr, /(client error|promise rejection): Error: Missing Permissions/, 'commands handle their own failed replies');
    assert.match(result.stderr, /Discord client error: Error: Gateway hiccup/);
    assert.match(result.stderr, /Unhandled promise rejection: Error: Stray rejection/);
});
