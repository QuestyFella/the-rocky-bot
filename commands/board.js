const { MessageFlags } = require('discord.js');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { dataPath } = require('../utils/dataPaths');
const { renderBoard } = require('../utils/boardDisplay');
const { buildTaskView, buildTaskPicker } = require('../utils/boardComponents');
const { getIssueKey, getTaskBoard, parseDueDate, isManager, canChange, claimError, setTaskStatus } = require('../utils/kanban');
const { getTaskTag } = require('../utils/taskTags');

const boardConfigFile = dataPath('kanbanBoards.json');
const legacyBoardConfigFile = dataPath('jiraBoards.json');
let boardConfigCache = null;
const boardUpdates = new Map();
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
const boardNames = ['main', 'exec'];
function boardSlot(config, board) {
    return board === 'main' ? config : ((config.boards ||= {})[board] ||= {});
}

function boardForChannel(guildId, channelId) {
    return channelId && loadBoardConfigs()[guildId]?.boards?.exec?.channelId === channelId ? 'exec' : 'main';
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
        createdAt: now, updatedAt: now, userId: null, createdBy: actor.author.id, guildId: actor.guild.id,
        ...(board === 'main' ? {} : { board })
    };
}

function generateBoardMessages(client, guildId, board = 'main') {
    const guild = client.guilds.cache.get(guildId);
    const title = !guild ? 'Task Board' : board === 'exec' ? `${guild.name} Exec Board` : getBoardConfig(guild).config.title;
    return renderBoard(boardTasks(client, guildId, board), title);
}

async function syncBoard(client, guildId, force) {
    for (const board of boardNames) await syncOneBoard(client, guildId, board, force);
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
        apply: (actor, task) => { task.userId = actor.author.id; setTaskStatus(task, 'progress'); return `${getIssueKey(task)} is yours and In Progress.`; }
    },
    done: {
        usage: '!task done KEY',
        check: (actor, task) => !canChange(actor, task) && 'Only the person working on this task, its creator, or a manager can change it.',
        apply: (actor, task) => { setTaskStatus(task, 'done'); return `${getIssueKey(task)} marked done. Nice work!`; }
    },
    unclaim: {
        usage: '!task unclaim KEY',
        check: (actor, task) => !canChange(actor, task) && 'Only the person working on this task, its creator, or a manager can change it.',
        apply: (actor, task) => { task.userId = null; setTaskStatus(task, 'todo'); return `${getIssueKey(task)} is back in To Do for someone else.`; }
    },
    reopen: {
        usage: '!task reopen KEY',
        check: (actor, task) => !canChange(actor, task) && 'Only the person working on this task, its creator, or a manager can change it.',
        apply: (actor, task) => { setTaskStatus(task, task.userId ? 'progress' : 'todo'); return `${getIssueKey(task)} reopened.`; }
    }
};
const aliases = { start: 'claim', close: 'done', release: 'unclaim', board: 'show', list: 'show', kanban: 'show', jira: 'show', view: 'details', rename: 'edit', remove: 'delete', duedate: 'due' };

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
            const board = args[0]?.toLowerCase() === 'exec' ? 'exec' : 'main';
            const { configs, config } = getBoardConfig(message.guild);
            const other = boardSlot(config, board === 'exec' ? 'main' : 'exec');
            if (other.channelId === message.channel.id) return message.reply(`This channel already has the ${board === 'exec' ? 'main' : 'exec'} board. Use a different channel.`);
            const sent = await message.channel.send(generateBoardMessages(message.client, message.guild.id, board)[0]);
            Object.assign(boardSlot(config, board), { channelId: message.channel.id, messageId: sent.id, messageIds: [sent.id] });
            delete config.sectionMessageIds;
            saveBoardConfigs(configs);
            await updateBoard(message.client, message.guild.id, { force: true });
            return message.reply(board === 'exec'
                ? 'Exec board created. Tasks added or imported in this channel go on this board only.'
                : 'Live task board created. It updates by itself when tasks change.');
        }
        await updateBoard(message.client, message.guild.id, { force: true });
        return message.reply('Board refreshed.');
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
        due: '!task due KEY YYYY-MM-DD|none', assign: '!task assign KEY @user|none',
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
        const user = message.mentions.users.first();
        if (!user && value.toLowerCase() !== 'none') return message.reply('Mention a member, or use `none`.');
        task.userId = user?.id || null;
        setTaskStatus(task, user ? 'progress' : 'todo');
        return message.reply(save(task) ? `${getIssueKey(task)} ${user ? `assigned to ${user}` : 'unassigned'}.` : 'Failed to save the task.');
    }

    if (subcommand === 'block') {
        if (!isManager(actor)) return message.reply('Only managers can set which tasks block others.');
        const { blockedBy, error } = setBlockers(actor, task, value);
        if (error) return message.reply(error);
        task.blockedBy = blockedBy;
        task.updatedAt = new Date().toISOString();
        return message.reply(save(task) ? (blockedBy.length ? `${getIssueKey(task)} stays hidden until its blockers are done.` : `${getIssueKey(task)} is no longer blocked.`) : 'Failed to save the task.');
    }

    if (!canChange(actor, task)) return message.reply('Only the person working on this task, its creator, or a manager can change it.');

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
