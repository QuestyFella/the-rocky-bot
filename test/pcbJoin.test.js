const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

// Set this before importing any application module: never read or write live data.
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-pcb-join-'));
process.env.BOT_DATA_DIR = temporaryDir;
const { createPcbJoin, joinConfig, parseJoin, accountName } = require('../utils/pcbJoin');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));

const ORG = 'Club';
const ROOM = '111111';
let sequence = 0;

// An imitation of the Gitea admin API calls !join-pcb makes, as a fetch function.
function fakeGitea(token) {
    const gitea = { users: { sai: { is_admin: false }, qstyban: { is_admin: true } }, members: new Set(['sai']), calls: [], down: false };
    gitea.fetch = async (url, { method = 'GET', headers = {}, body } = {}) => {
        const route = new URL(url).pathname.replace(/^\/api\/v1/, '');
        const data = body ? JSON.parse(body) : null;
        gitea.calls.push({ method, route, data, auth: headers.Authorization });
        const answer = (status, value) => ({ ok: status < 300, status, statusText: String(status), text: async () => (value === undefined ? '' : JSON.stringify(value)) });
        if (gitea.down) return answer(502, { message: 'Bad Gateway' });
        if (headers.Authorization !== `token ${token}`) return answer(401, { message: 'token is required' });
        let m;
        if ((m = route.match(/^\/users\/([^/]+)$/)) && method === 'GET') {
            const user = gitea.users[decodeURIComponent(m[1])];
            return user ? answer(200, { login: decodeURIComponent(m[1]), ...user }) : answer(404, { message: 'user does not exist' });
        }
        if (route === '/admin/users' && method === 'POST') {
            if (gitea.users[data.username]) return answer(422, { message: 'user already exists' });
            if (data.username === 'admin') return answer(422, { message: 'name is reserved [name: admin]' });
            gitea.users[data.username] = { is_admin: false, password: data.password, mustChange: data.must_change_password, email: data.email };
            return answer(201, { login: data.username });
        }
        if ((m = route.match(/^\/admin\/users\/([^/]+)$/)) && method === 'PATCH') {
            const user = gitea.users[decodeURIComponent(m[1])];
            Object.assign(user, { password: data.password, mustChange: data.must_change_password, patchedWith: Object.keys(data).sort() });
            return answer(200, {});
        }
        if (route === `/orgs/${ORG}/teams`) return answer(200, [{ id: 1, name: 'Owners' }, { id: 7, name: 'Members' }]);
        if ((m = route.match(/^\/teams\/7\/members\/([^/]+)$/)) && method === 'PUT') {
            gitea.members.add(decodeURIComponent(m[1]));
            return answer(204);
        }
        return answer(404, { message: `not imitated: ${method} ${route}` });
    };
    return gitea;
}

function fixture() {
    const dir = fs.mkdtempSync(path.join(temporaryDir, `join-${++sequence}-`));
    const token = 'f'.repeat(40);
    fs.writeFileSync(path.join(dir, 'token'), `${token}\n`);
    const gitea = fakeGitea(token);
    const clock = { t: 1_800_000_000_000 };
    const config = { tokenFile: path.join(dir, 'token'), apiUrl: 'http://gitea.local', publicUrl: 'http://10.16.26.107/gitea',
                     org: ORG, team: 'Members', roomChannelIds: [ROOM], stateFile: path.join(dir, 'state.json') };
    const dms = new Map();          // discord id -> messages sent to them
    const closedDms = new Set();
    const client = { users: { fetch: async id => ({ send: async text => {
        if (closedDms.has(id)) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
        dms.set(id, [...(dms.get(id) || []), text]);
    } }) } };
    const make = () => createPcbJoin(client, config, { fetch: gitea.fetch, now: () => clock.t });
    return { gitea, clock, config, dms, closedDms, make, join: make() };
}

const clubGuild = { channels: { cache: new Map([[ROOM, {}]]) } };
const otherGuild = { channels: { cache: new Map([['999999', {}]]) } };

function message(content, { id = '42', username = 'sohum.k', guild = clubGuild, bot = false } = {}) {
    const replies = [];
    return {
        replies, content, guild, author: { id, username, bot }, member: { displayName: `${username} (display)` },
        reply: async payload => {
            const sent = typeof payload === 'string' ? { content: payload } : payload;
            replies.push(sent);
            return sent;
        }
    };
}

function managerPermissions(manager) {
    return { has: flag => manager && flag === PermissionFlagsBits.ManageGuild };
}

// Press a button of the request the bot posted.
async function press(join, posted, action, { manager = true, user = 'exec1' } = {}) {
    const button = posted.components[0].components.find(b => b.data.custom_id.includes(`:${action}:`));
    const responses = [];
    const interaction = {
        customId: button.data.custom_id, isButton: () => true,
        member: { displayName: `Exec ${user}`, permissions: managerPermissions(manager) },
        user: { id: user, username: user }, message: { content: posted.content },
        reply: async payload => responses.push(['reply', payload]),
        update: async payload => responses.push(['update', payload]),
        deferUpdate: async () => responses.push(['deferUpdate']),
        editReply: async payload => responses.push(['editReply', payload])
    };
    assert.equal(await join.fromInteraction(interaction), true);
    return responses;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

async function ask(f, content = '!join-pcb', options = {}) {
    const m = message(content, options);
    const handled = f.join.fromDiscord(m);
    await settle();
    return { handled, m, posted: m.replies.at(-1) };
}

test('commands and names', () => {
    assert.deepEqual(parseJoin('  !JOIN-PCB  '), { name: null });
    assert.deepEqual(parseJoin('!join-pcb sohum-k'), { name: 'sohum-k' });
    assert.equal(parseJoin('!join-pcb two words'), null);
    assert.equal(parseJoin('please !join-pcb'), null);
    assert.equal(accountName('Sohum.K_'), 'sohum.k');
    assert.equal(accountName('__a..b--c__'), 'a-b-c');
    assert.equal(accountName('!!!'), '');
    assert.equal(accountName('x'.repeat(60)).length, 40);
    assert.equal(joinConfig({ APOLLO_GITEA_JOIN_TOKEN_FILE: path.join(temporaryDir, 'missing') }), null, 'off without the token file');
});

test('a request, approved by an exec: the account is made in the team and the password goes only by DM', async () => {
    const f = fixture();
    const { handled, posted } = await ask(f);
    assert.equal(handled, true);
    assert.match(posted.content, /sohum\.k \(display\)\*\* asks for an apollo account to upload PCBs, called `sohum\.k`/);
    assert.deepEqual(posted.components[0].components.map(b => b.data.label), ['Approve', 'Decline']);

    const refused = await press(f.join, posted, 'approve', { manager: false });
    assert.match(refused[0][1].content, /Only an exec/);
    assert.equal(f.gitea.users['sohum.k'], undefined, 'nothing made by a non-exec');

    const responses = await press(f.join, posted, 'approve');
    assert.equal(responses[0][0], 'deferUpdate');
    const user = f.gitea.users['sohum.k'];
    assert.equal(user.mustChange, true);
    assert.equal(user.email, 'sohum.k@apollo.local');
    assert.ok(f.gitea.members.has('sohum.k'));
    const dm = f.dms.get('42')[0];
    assert.ok(dm.includes(`**Temporary password:** \`${user.password}\``));
    assert.ok(dm.includes('http://10.16.26.107/gitea/assets/pcb-hub/upload.html'));
    const edited = responses[1][1];
    assert.match(edited.content, /✅ Approved by Exec exec1: account `sohum\.k` made, sign-in details sent by DM\./);
    assert.deepEqual(edited.components, []);
    assert.ok(!JSON.stringify(responses).includes(user.password), 'the password is never posted in the channel');
    assert.ok(f.gitea.calls.every(c => c.auth === `token ${'f'.repeat(40)}`));

    const late = await press(f.join, posted, 'approve');
    assert.match(late[0][1].content, /already been handled/, 'a second click does nothing');
});

test('asking again later resets the password of the account made here, and nobody else\'s', async () => {
    const f = fixture();
    const first = await ask(f);
    await press(f.join, first.posted, 'approve');
    const old = f.gitea.users['sohum.k'].password;
    const again = await ask(f, '!join-pcb somethingelse');
    assert.match(again.posted.content, /forgot the password of their apollo account `sohum\.k`/);
    await press(f.join, again.posted, 'approve');
    const user = f.gitea.users['sohum.k'];
    assert.notEqual(user.password, old);
    assert.equal(user.mustChange, true);
    assert.deepEqual(user.patchedWith, ['login_name', 'must_change_password', 'password', 'source_id']);
    assert.match(f.dms.get('42')[1], /Here is a new password/);

    // A restarted bot remembers who has an account.
    const restarted = f.make();
    const m = message('!join-pcb');
    restarted.fromDiscord(m);
    await settle();
    assert.match(m.replies[0].content, /forgot the password/);
});

test('taken, odd and reserved names, and other servers', async () => {
    const f = fixture();
    const taken = await ask(f, '!join-pcb sai');
    assert.match(taken.posted.content, /already an account called `sai`\. If it is yours, sign in/);
    assert.equal(taken.posted.components, undefined);
    const odd = await ask(f, '!join-pcb Bad!Name');
    assert.match(odd.posted.content, /`bad-name` is not a name Gitea can use/);
    const other = await ask(f, '!join-pcb', { guild: otherGuild });
    assert.equal(other.handled, false);
    assert.equal((await ask(f, '!join-pcb', { bot: true })).handled, false);
    // Gitea refusing the name when it is approved: said on the request, nothing left half done.
    const reserved = await ask(f, '!join-pcb admin', { id: '77' });
    const responses = await press(f.join, reserved.posted, 'approve');
    assert.match(responses.at(-1)[1].content, /⚠️ Gitea did not make it: name is reserved/);
    assert.equal(f.dms.get('77'), undefined);
    assert.match((await ask(f, '!join-pcb admin', { id: '77' })).posted.content, /asks for an apollo account/, 'they can ask again');
});

test('an administrator\'s account is never reset from Discord', async () => {
    const f = fixture();
    fs.writeFileSync(f.config.stateFile, JSON.stringify({ accounts: { 42: 'qstyban' }, requests: {} }));
    const join = f.make();
    const m = message('!join-pcb');
    join.fromDiscord(m);
    await settle();
    const responses = await press(join, m.replies[0], 'approve');
    assert.match(responses.at(-1)[1].content, /qstyban is a Gitea administrator: reset it in Gitea itself/);
    assert.equal(f.gitea.users.qstyban.password, undefined);
});

test('declined, one request at a time, expiry, closed DMs and Gitea being down', async () => {
    const f = fixture();
    const first = await ask(f);
    assert.match((await ask(f)).posted.content, /already asked/);
    const declined = await press(f.join, first.posted, 'decline');
    assert.match(declined[0][1].content, /❌ Declined by Exec exec1\./);
    assert.equal(f.gitea.users['sohum.k'], undefined);

    const expiring = await ask(f);
    f.clock.t += 8 * 86400000;
    const fresh = await ask(f);
    assert.match(fresh.posted.content, /asks for an apollo account/, 'a week-old request no longer blocks a new one');
    assert.match((await press(f.join, expiring.posted, 'approve'))[0][1].content, /expired/);

    f.closedDms.add('42');
    const responses = await press(f.join, fresh.posted, 'approve');
    assert.match(responses.at(-1)[1].content, /could not DM <@42>\. Allow DMs from server members, then type `!join-pcb` again/);
    assert.deepEqual(responses.at(-1)[1].allowedMentions, { users: ['42'] });

    f.gitea.down = true;
    const m = message('!join-pcb', { id: '55', username: 'newperson' });
    f.join.fromDiscord(m);
    await settle();
    assert.match(m.replies[0].content, /Gitea did not answer/);
});
