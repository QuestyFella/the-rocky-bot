// !join-pcb: an account on apollo's Gitea for uploading boards, approved by an exec on Discord.
//   !join-pcb [name]   ask for an account (named after your Discord username unless you give a name).
//                      Someone who already got one here gets a new password instead (a forgotten one).
// The bot answers with Approve / Decline buttons that only an exec can press: someone with Manage Server or
// Administrator, the same people who manage the task boards. On approval it makes the Gitea account in the
// club's team and sends the username and a temporary password by direct message; Gitea asks for a new
// password at the first sign-in. Passwords never appear in a channel.
// On when the token file pcb-hub's install.sh writes exists (<BOT_DATA_DIR>/gitea-pcb-join-token, or
// APOLLO_GITEA_JOIN_TOKEN_FILE), and only in the club's server: the one with apollo's room channels.
const crypto = require('crypto');
const fs = require('fs');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { dataPath } = require('./dataPaths');
const { isManager } = require('./kanban');

const REQUEST_DAYS = 7;          // an unanswered request expires after this
const NAME_LIMIT = 40;

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJson(file, value) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function parseJoin(content) {
    const match = String(content || '').trim().match(/^!join-pcb(?:\s+(\S+))?\s*$/i);
    return match ? { name: match[1] || null } : null;
}

// A Gitea username from a Discord one: "Sohum.K_" -> "sohum.k". Gitea allows letters, digits, "-", "_" and
// ".", starting and ending with a letter or digit.
function accountName(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/[._-]{2,}/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '').slice(0, NAME_LIMIT).replace(/[._-]+$/, '');
}

function joinConfig(env = process.env) {
    const tokenFile = env.APOLLO_GITEA_JOIN_TOKEN_FILE || dataPath('gitea-pcb-join-token');
    if (!fs.existsSync(tokenFile)) return null;
    const url = value => value.replace(/\/+$/, '');
    return {
        tokenFile,
        apiUrl: url(env.APOLLO_GITEA_API_URL || 'http://127.0.0.1:3000'),
        publicUrl: url(env.APOLLO_GITEA_URL || 'http://10.16.26.107/gitea'),
        org: env.APOLLO_GITEA_ORG || 'University-of-Guelph-Rocketry-Club',
        team: env.APOLLO_GITEA_TEAM || 'Members',
        // The club's server is the one that has apollo's room channels in it.
        roomChannelIds: [env.APOLLO_BUZZ_CHANNEL_ID, env.APOLLO_SHOP_CHANNEL_ID, env.APOLLO_BRIDGE_CHANNEL_ID]
            .map(id => String(id || '').trim()).filter(id => /^\d{5,25}$/.test(id)),
        stateFile: dataPath('pcbJoin.json')
    };
}

class GiteaError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Returns null when the token file is not there.
function createPcbJoin(client, config = joinConfig(), { fetch = globalThis.fetch, now = Date.now } = {}) {
    if (!config) return null;
    const state = readJson(config.stateFile) || {};
    state.accounts ||= {};           // Discord user id -> Gitea username made here
    state.requests ||= {};           // request id -> { discordId, name, kind: "new" | "reset", requestedAt }
    const busy = new Set();          // requests being approved right now (a double click waits for the first)
    const save = () => writeJson(config.stateFile, state);

    async function gitea(method, path, body) {
        const token = fs.readFileSync(config.tokenFile, 'utf8').trim();
        const response = await fetch(`${config.apiUrl}/api/v1${path}`, {
            method,
            headers: { Authorization: `token ${token}`, Accept: 'application/json',
                       ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20000)
        });
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch { /* not JSON */ }
        if (!response.ok) throw new GiteaError(response.status, data?.message || text.slice(0, 200) || response.statusText);
        return data;
    }
    const exists = async name => {
        try {
            return await gitea('GET', `/users/${encodeURIComponent(name)}`);
        } catch (error) {
            if (error.status === 404) return null;
            throw error;
        }
    };

    function inClubServer(guild) {
        return Boolean(guild) && config.roomChannelIds.some(id => guild.channels?.cache?.has(id));
    }

    function forget(old) {
        for (const [id, request] of Object.entries(state.requests)) {
            if (old(request)) delete state.requests[id];
        }
    }

    const buttons = id => [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pcbjoin:approve:${id}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pcbjoin:decline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary))];

    async function ask(message, { name: wanted }) {
        const reply = content => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
        const discordId = message.author.id;
        forget(r => now() - r.requestedAt > REQUEST_DAYS * 86400000);
        if (Object.values(state.requests).some(r => r.discordId === discordId)) {
            return reply('You have already asked: an exec just needs to approve it.');
        }
        const linked = state.accounts[discordId];
        let name = linked;
        if (!linked) {
            name = accountName(wanted || message.author.username);
            if (!name || (wanted && name !== wanted.toLowerCase())) {
                return reply(`\`${accountName(wanted) || wanted}\` is not a name Gitea can use. Use letters, digits and dashes, `
                    + 'like `!join-pcb sohum-k`.');
            }
            if (await exists(name)) {
                return reply(`There is already an account called \`${name}\`. If it is yours, sign in with it at `
                    + `${config.publicUrl}/user/login . If not, pick another name: \`!join-pcb ${name}-2\``);
            }
        }
        const id = crypto.randomBytes(6).toString('hex');
        const who = message.member?.displayName || message.author.globalName || message.author.username;
        const text = linked
            ? `🔑 **${who}** forgot the password of their apollo account \`${name}\`. An exec can approve a new one below.`
            : `🔌 **${who}** asks for an apollo account to upload PCBs, called \`${name}\`. An exec can approve it below.`;
        state.requests[id] = { discordId, name, kind: linked ? 'reset' : 'new', requestedAt: now() };
        save();
        await message.reply({ content: text, components: buttons(id), allowedMentions: { parse: [], repliedUser: false } });
    }

    async function makeAccount({ name, kind }) {
        const password = crypto.randomBytes(9).toString('base64url');
        if (kind === 'reset') {
            const user = await exists(name);
            if (!user) throw new GiteaError(404, `the account ${name} no longer exists. Ask again with !join-pcb for a new one.`);
            if (user.is_admin) throw new GiteaError(403, `${name} is a Gitea administrator: reset it in Gitea itself.`);
            await gitea('PATCH', `/admin/users/${encodeURIComponent(name)}`,
                { login_name: name, source_id: 0, password, must_change_password: true });
            return password;
        }
        await gitea('POST', '/admin/users', { username: name, email: `${name}@apollo.local`, password,
                                               must_change_password: true, send_notify: false });
        const teams = await gitea('GET', `/orgs/${encodeURIComponent(config.org)}/teams`) || [];
        const team = teams.find(t => t.name === config.team);
        if (!team) throw new GiteaError(404, `the team ${config.team} of ${config.org} was not found`);
        await gitea('PUT', `/teams/${team.id}/members/${encodeURIComponent(name)}`);
        return password;
    }

    function welcome(name, password, kind) {
        return [kind === 'reset' ? 'Here is a new password for your apollo account.' : 'Your apollo account for uploading PCBs is ready.',
            '',
            `**Sign in:** ${config.publicUrl}/user/login`,
            `**Username:** \`${name}\``,
            `**Temporary password:** \`${password}\` (Gitea asks you to choose your own the first time)`,
            '',
            `**Upload a board:** ${config.publicUrl}/assets/pcb-hub/upload.html`,
            `**All the club's boards:** ${config.publicUrl}/${config.org}/boards`,
            '',
            'These only open on the campus network.'].join('\n');
    }

    async function decide(interaction) {
        const [, action, id] = interaction.customId.split(':');
        const request = state.requests[id];
        if (!request || busy.has(id)) {
            return interaction.reply({ content: 'This request has already been handled, or it expired.', flags: MessageFlags.Ephemeral });
        }
        if (!isManager(interaction)) {
            return interaction.reply({ content: 'Only an exec (someone with Manage Server) can answer this.', flags: MessageFlags.Ephemeral });
        }
        const exec = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
        if (action === 'decline') {
            delete state.requests[id];
            save();
            return interaction.update({ content: `${interaction.message.content}\n❌ Declined by ${exec}.`, components: [] });
        }
        busy.add(id);
        try {
            await interaction.deferUpdate();
            let password;
            try {
                password = await makeAccount(request);
            } catch (error) {
                delete state.requests[id];
                save();
                console.error('[pcb-join] Gitea refused:', error.message);
                return interaction.editReply({ content: `${interaction.message.content}\n⚠️ Gitea did not make it: ${error.message}`,
                                               components: [] });
            }
            delete state.requests[id];
            state.accounts[request.discordId] = request.name;
            save();
            let sent = true;
            try {
                const user = await client.users.fetch(request.discordId);
                await user.send(welcome(request.name, password, request.kind));
            } catch {
                sent = false;      // their DMs are closed: the password is lost, a new request makes another
            }
            const done = request.kind === 'reset' ? 'new password made' : `account \`${request.name}\` made`;
            return interaction.editReply({
                content: `${interaction.message.content}\n✅ Approved by ${exec}: ${done}, `
                    + (sent ? 'sign-in details sent by DM.'
                        : `but I could not DM <@${request.discordId}>. Allow DMs from server members, then type \`!join-pcb\` again for a new password.`),
                components: [], allowedMentions: { users: sent ? [] : [request.discordId] }
            });
        } finally {
            busy.delete(id);
        }
    }

    return {
        // Called for every Discord message; returns true for a !join-pcb it handled.
        fromDiscord(message) {
            const parsed = parseJoin(message.content);
            if (!parsed || message.author?.bot || !inClubServer(message.guild)) return false;
            ask(message, parsed).catch(error => {
                console.error('[pcb-join] Request failed:', error.message);
                message.reply({ content: 'Gitea did not answer. Try again in a minute.', allowedMentions: { parse: [] } }).catch(() => {});
            });
            return true;
        },
        // Called for every interaction; returns true for one of its buttons (handled, or failed and logged).
        async fromInteraction(interaction) {
            if (!interaction.isButton?.() || !interaction.customId?.startsWith('pcbjoin:')) return false;
            await decide(interaction);
            return true;
        }
    };
}

module.exports = { createPcbJoin, joinConfig, parseJoin, accountName };
