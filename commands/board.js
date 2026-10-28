const { MessageFlags } = require('discord.js');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { dataPath } = require('../utils/dataPaths');
const { renderBoard } = require('../utils/boardDisplay');
const { buildTaskView, buildTaskPicker } = require('../utils/boardComponents');
const { getIssueKey, getTaskBoard, isBoardName, parseDueDate, isManager, canChange, claimError, setTaskStatus, getOwners, setOwners, isOwner } = require('../utils/kanban');
const { getTaskTag } = require('../utils/taskTags');

const boardConfigFile = dataPath('kanbanBoards.json');
const legacyBoardConfigFile = dataPath('jiraBoards.json');
let boardConfigCache = null;
const boardUpdates = new Map();
const boardSetups = new Map();
const boardMessagePayloads = new Map();

function loadBoardConfigs() {
    if (boardConfigCache) return boardConfigCache;
    const configFile = fs.existsSync(boardConfigFile) ? boardConfigFile : legacyBoardConfigFile;
    try {
        const raw = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
        boardConfigCache = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
        console.error('Failed to load Kanban board configs:', error);
        boardConfigCache = {};
    }
    return boardConfigCache;
}

function saveBoardConfigs(data) {
    boardConfigCache = data;
    fs.writeFileSync(boardConfigFile, JSON.stringify(data, null, 2));
}

function getBoardConfig(guild) {
    const configs = loadBoardConfigs();
    const initials = (guild.name.match(/[a-z0-9]+/gi) || []).map(word => word[0]).join('').toUpperCase();
    const config = configs[guild.id] ||= {};
    config.projectKey ||= (initials || 'TASK').slice(0, 5);
    config.title ||= `${guild.name} Task Board`;
    if (!Number.isInteger(config.nextIssueNumber) || config.nextIssueNumber < 1) config.nextIssueNumber = 1;
    return { configs, config };
}

// The main board keeps its message IDs at the top level of the config (as before);
// other boards, such as the exec board, live under config.boards.
function boardNames(config) {
    return ['main', ...Object.keys(config?.boards || {}).filter(name => name !== 'main' && isBoardName(name))];
}

function boardSlot(config, board) {
    if (board === 'main') return config;
    const boards = config.boards ||= {};
    if (!Object.hasOwn(boards, board)) boards[board] = {};
    return boards[board];
}

function boardForChannel(guildId, channelId) {
    const config = loadBoardConfigs()[guildId];
    return channelId && config
        ? boardNames(config).find(name => boardSlot(config, name).channelId === channelId) || 'main'
        : 'main';
}

function boardTasks(client, guildId, board) {
    return client.taskStorage.getAllTasks(guildId).filter(task => getTaskBoard(task) === board);
}

function createIssue(actor, { title, description = '', dueDate = null }, board = actor.board || 'main') {
    const { configs, config } = getBoardConfig(actor.guild);
    const issueKey = `${config.projectKey}-${config.nextIssueNumber++}`;
    saveBoardConfigs(configs);
    const now = new Date().toISOString();
    return {
        id: randomUUID(), issueKey, title, description, dueDate, status: 'todo', completed: false,
        createdAt: now, updatedAt: now, userIds: [], createdBy: actor.author.id, guildId: actor.guild.id,
        ...(board === 'main' ? {} : { board })
    };
}

function generateBoardMessages(client, guildId, board = 'main') {
    const guild = client.guilds.cache.get(guildId);
    const config = guild ? getBoardConfig(guild).config : loadBoardConfigs()[guildId] || {};
    const slot = boardSlot(config, board);
    const label = board.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    const title = slot.title || (!guild ? 'Task Board' : `${guild.name} ${label} Board`);
    const notice = slot.notice ? slot.noticeText || true : false;
    return renderBoard(boardTasks(client, guildId, board), title, { notice });
}

async function syncBoard(client, guildId, force) {
    for (const board of boardNames(loadBoardConfigs()[guildId])) await syncOneBoard(client, guildId, board, force);
}

async function syncOneBoard(client, guildId, board, force) {
    const configs = loadBoardConfigs();
    if (!configs[guildId]) return;
    const config = boardSlot(configs[guildId], board);
    if (!config.channelId || !config.messageId) return;
    try {
        const channel = await client.channels.fetch(config.channelId);
        if (!channel) return;
        const payloads = generateBoardMessages(client, guildId, board);
        const ids = [...new Set(config.messageIds?.length ? config.messageIds : [config.messageId])];
        const save = () => {
            config.messageId = ids[0];
            config.messageIds = [...ids];
            delete config.sectionMessageIds;
            saveBoardConfigs(configs);
        };
        for (const [index, payload] of payloads.entries()) {
            let message = null;
            if (ids[index]) {
                try { message = await channel.messages.fetch(ids[index]); }
                catch (error) { if (error.code !== 10008) throw error; }
            }
            const fingerprint = JSON.stringify({ ...payload, embeds: payload.embeds.map(embed => embed.toJSON()), components: payload.components.map(row => row.toJSON()) });
            if (!message) {
                message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
                ids[index] = message.id;
                // Record each sent message immediately so a later failure cannot orphan it.
                save();
            } else if (force || boardMessagePayloads.get(`${guildId}:${message.id}`) !== fingerprint) {
                await message.edit(payload);
            }
            boardMessagePayloads.set(`${guildId}:${message.id}`, fingerprint);
        }
        // Remove extra board messages when the task list shrinks.
        while (ids.length > payloads.length) {
            const id = ids.pop();
            try {
                const message = await channel.messages.fetch(id);
                if (message.author.id === client.user.id) await message.delete();
            } catch (error) { if (error.code !== 10008) throw error; }
            boardMessagePayloads.delete(`${guildId}:${id}`);
        }
        if (JSON.stringify(config.messageIds) !== JSON.stringify(ids) || config.sectionMessageIds) save();
    } catch (error) {
        console.error(`Failed to update the ${board} task board for guild ${guildId}:`, error);
    }
}

function updateBoard(client, guildId, { force = false } = {}) {
    // Task changes, refresh commands, and the timer share one update queue per server.
    const update = (boardUpdates.get(guildId) || Promise.resolve()).then(() => syncBoard(client, guildId, force));
    boardUpdates.set(guildId, update);
    update.finally(() => { if (boardUpdates.get(guildId) === update) boardUpdates.delete(guildId); }).catch(() => {});
    return update;
}

// Each channel only sees the tasks of its own board.
function findTask(actor, identifier) {
    const lookup = String(identifier || '').trim().toUpperCase();
    return lookup ? boardTasks(actor.client, actor.guild.id, actor.board).find(task => getIssueKey(task).toUpperCase() === lookup || String(task.id).toUpperCase() === lookup) || null : null;
}

function actorFor(message) {
    return { client: message.client, guild: message.guild, member: message.member, author: message.author, board: boardForChannel(message.guild.id, message.channel.id) };
}

// Sets which same-category tasks must be done before this one becomes visible.
function setBlockers(actor, task, input) {
    if (/^(none|clear)$/i.test(input.trim())) return { blockedBy: [] };
    const tasks = boardTasks(actor.client, actor.guild.id, actor.board);
    const blockedBy = [];
    for (const key of input.split(/[\s,]+/).filter(Boolean)) {
        const other = tasks.find(item => getIssueKey(item).toUpperCase() === key.toUpperCase());
        if (!other) return { error: `I could not find ${key} on this board.` };
        if (other.id === task.id) return { error: 'A task cannot block itself.' };
        if (getTaskTag(other).id !== getTaskTag(task).id) return { error: `${key} is in ${getTaskTag(other).name}, not ${getTaskTag(task).name}. Only tasks in the same category can block each other.` };
        if (!blockedBy.includes(other.id)) blockedBy.push(other.id);
    }
    // Refuse loops, which would hide every task in them forever.
    const byId = new Map(tasks.map(item => [item.id, item.id === task.id ? { ...item, blockedBy } : item]));
    const visit = (id, path) => path.has(id) || [...(byId.get(id)?.blockedBy || [])].some(next => visit(next, new Set([...path, id])));
    if (blockedBy.some(id => visit(id, new Set([task.id])))) return { error: 'That would create a loop of tasks blocking each other.' };
    return { blockedBy };
}

// Each command maps to: what it needs, who may run it, and the change it makes.
const taskCommands = {
    claim: {
        usage: '!task claim KEY',
        check: (actor, task, tasks) => claimError(actor, task, tasks),
        apply: (actor, task) => {
            const others = getOwners(task).length;
            setOwners(task, [...getOwners(task), actor.author.id]);
            setTaskStatus(task, 'progress');
            return others ? `You joined ${getIssueKey(task)}. ${others} other${others > 1 ? 's are' : ' is'} working on it too.` : `${getIssueKey(task)} is yours and In Progress.`;
        }
    },
    done: {
        usage: '!task done KEY',
        check: (actor, task) => !canChange(actor, task) && 'Only the people working on this task, its creator, or a manager can change it.',
        apply: (actor, task) => { setTaskStatus(task, 'done'); return `${getIssueKey(task)} marked done. Nice work!`; }
    },
    // People working on a task take only themselves off it; its creator or a manager can clear everyone.
    unclaim: {
        usage: '!task unclaim KEY',
        check: (actor, task) => !canChange(actor, task) && 'Only the people working on this task, its creator, or a manager can change it.',
        apply: (actor, task) => {
            const leaving = isOwner(task, actor.author.id);
            setOwners(task, leaving ? getOwners(task).filter(id => id !== actor.author.id) : []);
            if (getOwners(task).length) return `You left ${getIssueKey(task)}. The others are still on it.`;
            setTaskStatus(task, 'todo');
            return `${leaving ? `You left ${getIssueKey(task)}` : `Everyone was taken off ${getIssueKey(task)}`}. It is back in To Do for someone else.`;
        }
    },
    reopen: {
        usage: '!task reopen KEY',
        check: (actor, task) => !canChange(actor, task) && 'Only the people working on this task, its creator, or a manager can change it.',
        apply: (actor, task) => { setTaskStatus(task, getOwners(task).length ? 'progress' : 'todo'); return `${getIssueKey(task)} reopened.`; }
    }
};
const aliases = { start: 'claim', close: 'done', release: 'unclaim', board: 'show', list: 'show', kanban: 'show', jira: 'show', view: 'details', rename: 'edit', remove: 'delete', duedate: 'due' };

// A launch countdown (!task launch set), shown by apollo's homepage, login message and task board.
function describeLaunch(launch) {
    const days = Math.ceil((Date.parse(`${launch.date}T00:00:00Z`) - Date.now()) / 86400000);
    const when = days > 1 ? `T-${days} days` : days === 1 ? 'tomorrow' : days === 0 ? 'today' : `${-days} days ago`;
    return `**${launch.name}** on ${launch.date}${launch.time ? ` at ${launch.time}` : ''} (${when})`;
}

async function setupBoard(message, args) {
    const board = args[0]?.toLowerCase() || boardForChannel(message.guild.id, message.channel.id);
    if (args.length > 1 || !isBoardName(board)) return message.reply('Usage: `!task setup [name]`. Use 1–40 lowercase letters, numbers, or hyphens, starting with a letter or number; choose a name such as `liquid-rocket`.');
    const { configs, config } = getBoardConfig(message.guild);
    const occupied = boardNames(config).find(name => boardSlot(config, name).channelId === message.channel.id);
    if (occupied && occupied !== board) return message.reply(`This channel already has the ${occupied} board. Use a different channel.`);
    const slot = boardSlot(config, board);
    if (slot.channelId && slot.channelId !== message.channel.id) return message.reply(`The ${board} board is already in <#${slot.channelId}>. Use a different name to create an independent board.`);
    if (slot.channelId === message.channel.id && slot.messageId) {
        await updateBoard(message.client, message.guild.id, { force: true });
        return message.reply('Board refreshed. Its existing messages and tasks were kept.');
    }
    const sent = await message.channel.send(generateBoardMessages(message.client, message.guild.id, board)[0]);
    Object.assign(slot, { channelId: message.channel.id, messageId: sent.id, messageIds: [sent.id] });
    delete slot.sectionMessageIds;
    saveBoardConfigs(configs);
    await updateBoard(message.client, message.guild.id, { force: true });
    return message.reply(board === 'main'
        ? 'Live task board created. It updates by itself when tasks change.'
        : `${board === 'exec' ? 'Exec' : board} board created. Tasks added or imported in this channel go on this board only.`);
}

async function execute(message, args) {
    const raw = (args.shift() || 'show').toLowerCase();
    const subcommand = aliases[raw] || raw;
    const actor = actorFor(message);
    const storage = message.client.taskStorage;
    const save = task => storage.updateTask(message.guild.id, task.id, task);

    if (subcommand === 'show') {
        for (const payload of generateBoardMessages(message.client, message.guild.id, actor.board)) await message.channel.send(payload);
        return;
    }

    if (subcommand === 'setup' || subcommand === 'refresh') {
        if (!isManager(actor)) return message.reply('You need Manage Server permission for that.');
        if (subcommand === 'setup') {
            // Keep collision checks, posting, and persistence together even when two
            // managers run setup at once. A failed setup must not poison later attempts.
            const guildId = message.guild.id;
            const setup = (boardSetups.get(guildId) || Promise.resolve()).catch(() => {}).then(() => setupBoard(message, args));
            boardSetups.set(guildId, setup);
            setup.finally(() => { if (boardSetups.get(guildId) === setup) boardSetups.delete(guildId); }).catch(() => {});
            return setup;
        }
        await updateBoard(message.client, message.guild.id, { force: true });
        return message.reply('Board refreshed.');
    }

    if (subcommand === 'notice') {
        if (!isManager(actor)) return message.reply('You need Manage Server permission for that.');
        const choice = args[0]?.toLowerCase();
        const { configs, config } = getBoardConfig(message.guild);
        const slot = boardSlot(config, actor.board);
        const which = actor.board === 'exec' ? 'exec board' : 'board';
        // Keep the line breaks of a server's own notice, which the argument split would lose.
        const text = choice === 'set' ? message.content.replace(/^\s*!task\s+notice\s+set\b[ \t]*\n?/i, '').trim() : '';
        if (choice === 'set' && (!text || text.length > 3000)) return message.reply('Write the notice after the command, up to 3,000 characters: `!task notice set Your text`. Start with a line like `# Welcome` to give it a title.');
        if (!['on', 'off', 'set', 'default'].includes(choice)) {
            return message.reply([
                `The notice is **${slot.notice ? 'on' : 'off'}** for this ${which}${slot.noticeText ? ', using this server\'s own text' : ''}.`,
                '`!task notice on` / `!task notice off` - Show or hide the notice at the top of this channel\'s board',
                '`!task notice set Your text` - Use your own notice (a first line like `# Welcome` becomes its title)',
                '`!task notice default` - Go back to the built-in "How this board works" notice'
            ].join('\n'));
        }
        if (choice === 'off') delete slot.notice;
        else slot.notice = true;
        if (choice === 'set') slot.noticeText = text;
        if (choice === 'default') delete slot.noticeText;
        saveBoardConfigs(configs);
        await updateBoard(message.client, message.guild.id, { force: true });
        return message.reply({
            on: `The ${which} now starts with ${slot.noticeText ? 'this server\'s notice' : 'the "How this board works" notice'}.`,
            off: `The notice is off for the ${which}.`,
            set: `Saved. The ${which} now starts with your notice.`,
            default: `The ${which} now uses the built-in "How this board works" notice.`
        }[choice]);
    }

    if (subcommand === 'launch') {
        const choice = args[0]?.toLowerCase();
        const { configs, config } = getBoardConfig(message.guild);
        if (!choice) return message.reply(config.launch ? `Next launch: ${describeLaunch(config.launch)}.` : 'No launch countdown is set.');
        if (!isManager(actor)) return message.reply('You need Manage Server permission for that.');
        if (choice === 'clear') {
            delete config.launch;
            saveBoardConfigs(configs);
            return message.reply('Launch countdown cleared.');
        }
        const usage = 'Usage: `!task launch set 2026-12-01 [14:30] Launch name` or `!task launch clear`.';
        if (choice !== 'set') return message.reply(usage);
        const date = args[1] || '';
        const time = /^\d{1,2}:\d{2}$/.test(args[2] || '') ? args[2].padStart(5, '0') : null;
        const name = args.slice(time ? 3 : 2).join(' ').trim() || 'Launch';
        const parsed = parseDueDate(date);
        if (!parsed.ok || !parsed.dueDate || (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || name.length > 80) return message.reply(usage);
        config.launch = { date, time, name, setBy: message.author.id };
        saveBoardConfigs(configs);
        return message.reply(`Countdown set: ${describeLaunch(config.launch)}. It shows on apollo's homepage, login message and task board.`);
    }

    if (subcommand === 'add') {
        const title = args.join(' ').trim();
        if (!title || title.length > 200) return message.reply('Usage: `!task add [TAG] Task title` (up to 200 characters).');
        const task = createIssue(actor, { title });
        if (!storage.addTask(message.guild.id, task)) return message.reply('Failed to save the task.');
        return message.reply(`Created ${task.issueKey}: "${title}". Anyone can claim it from **Find Work**.`);
    }

    if (subcommand === 'mine' || subcommand === 'find') {
        return message.channel.send(buildTaskPicker(boardTasks(message.client, message.guild.id, actor.board), subcommand, 0, actor));
    }

    const usage = taskCommands[subcommand]?.usage || {
        details: '!task details KEY', edit: '!task edit KEY New title', delete: '!task delete KEY',
        due: '!task due KEY YYYY-MM-DD|none', assign: '!task assign KEY @user [@user2…]|none',
        block: '!task block KEY OTHER-1, OTHER-2|none'
    }[subcommand];
    if (!usage) return message.client.commands.get('help').execute(message);
    const needsValue = ['edit', 'due', 'assign', 'block'].includes(subcommand);
    if (!args[0] || (needsValue && !args[1])) return message.reply(`Usage: \`${usage}\``);
    const task = findTask(actor, args[0]);
    if (!task) return message.reply('I could not find that task. Use its key, such as `QSS-12`.');
    const value = args.slice(1).join(' ').trim();

    if (subcommand === 'details') return message.channel.send(buildTaskView(task, actor));

    if (taskCommands[subcommand]) {
        const { check, apply } = taskCommands[subcommand];
        const error = check(actor, task, boardTasks(message.client, message.guild.id, actor.board));
        if (error) return message.reply(error);
        const reply = apply(actor, task);
        return message.reply(save(task) ? reply : 'Failed to save the task.');
    }

    if (subcommand === 'assign') {
        if (!isManager(actor)) return message.reply('Only managers can assign tasks to others. Use `!task claim KEY` to take one yourself.');
        // Mentioned members join the people already on the task; "none" takes everyone off it.
        const users = [...message.mentions.users.values()];
        if (!users.length && value.toLowerCase() !== 'none') return message.reply('Mention one or more members, or use `none`.');
        setOwners(task, users.length ? [...getOwners(task), ...users.map(user => user.id)] : []);
        setTaskStatus(task, users.length ? 'progress' : 'todo');
        return message.reply(save(task) ? `${getIssueKey(task)} ${users.length ? `assigned to ${users.join(', ')}` : 'unassigned'}.` : 'Failed to save the task.');
    }

    if (subcommand === 'block') {
        if (!isManager(actor)) return message.reply('Only managers can set which tasks block others.');
        const { blockedBy, error } = setBlockers(actor, task, value);
        if (error) return message.reply(error);
        task.blockedBy = blockedBy;
        task.updatedAt = new Date().toISOString();
        return message.reply(save(task) ? (blockedBy.length ? `${getIssueKey(task)} stays hidden until its blockers are done.` : `${getIssueKey(task)} is no longer blocked.`) : 'Failed to save the task.');
    }

    if (!canChange(actor, task)) return message.reply('Only the people working on this task, its creator, or a manager can change it.');

    if (subcommand === 'delete') {
        return message.reply(storage.deleteTask(message.guild.id, task.id) ? `Deleted ${getIssueKey(task)}.` : 'Failed to delete the task.');
    }
    if (subcommand === 'edit') {
        if (value.length > 200) return message.reply('Keep the title to 200 characters.');
        task.title = value;
    }
    if (subcommand === 'due') {
        const due = parseDueDate(value);
        if (!due.ok) return message.reply('Use a date like `2026-12-01`, or `none` to clear it.');
        task.dueDate = due.dueDate;
    }
    task.updatedAt = new Date().toISOString();
    return message.reply(save(task) ? `Updated ${getIssueKey(task)}.` : 'Failed to save the task.');
}

module.exports = {
    name: 'board',
    description: 'Run the task board',
    execute,
    createIssue,
    boardForChannel,
    boardTasks,
    generateBoardMessages,
    updateBoard,
    taskCommands
};
