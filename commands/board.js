const { MessageFlags } = require('discord.js');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { dataPath } = require('../utils/dataPaths');
const { renderBoard } = require('../utils/boardDisplay');
const { buildTaskView, buildTaskPicker } = require('../utils/boardComponents');
const { getIssueKey, parseDueDate, isManager, canChange, claimError, setTaskStatus } = require('../utils/kanban');

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

function createIssue(actor, { title, description = '', dueDate = null }) {
    const { configs, config } = getBoardConfig(actor.guild);
    const issueKey = `${config.projectKey}-${config.nextIssueNumber++}`;
    saveBoardConfigs(configs);
    const now = new Date().toISOString();
    return {
        id: randomUUID(), issueKey, title, description, dueDate, status: 'todo', completed: false,
        createdAt: now, updatedAt: now, userId: null, createdBy: actor.author.id, guildId: actor.guild.id
    };
}

function generateBoardMessages(client, guildId) {
    const guild = client.guilds.cache.get(guildId);
    const title = guild ? getBoardConfig(guild).config.title : 'Task Board';
    return renderBoard(client.taskStorage.getAllTasks(guildId), title);
}

async function syncBoard(client, guildId, force) {
    const configs = loadBoardConfigs();
    const config = configs[guildId];
    if (!config?.channelId || !config.messageId) return;
    try {
        const channel = await client.channels.fetch(config.channelId);
        if (!channel) return;
        const payloads = generateBoardMessages(client, guildId);
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
        console.error(`Failed to update task board for guild ${guildId}:`, error);
    }
}

function updateBoard(client, guildId, { force = false } = {}) {
    // Task changes, refresh commands, and the timer share one update queue per server.
    const update = (boardUpdates.get(guildId) || Promise.resolve()).then(() => syncBoard(client, guildId, force));
    boardUpdates.set(guildId, update);
    update.finally(() => { if (boardUpdates.get(guildId) === update) boardUpdates.delete(guildId); }).catch(() => {});
    return update;
}

function findTask(message, identifier) {
    const lookup = String(identifier || '').trim().toUpperCase();
    const tasks = message.client.taskStorage.getAllTasks(message.guild.id);
    return lookup ? tasks.find(task => getIssueKey(task).toUpperCase() === lookup || String(task.id).toUpperCase() === lookup) || null : null;
}

function actorFor(message) {
    return { client: message.client, guild: message.guild, member: message.member, author: message.author };
}

// Each command maps to: what it needs, who may run it, and the change it makes.
const taskCommands = {
    claim: {
        usage: '!task claim KEY',
        check: (actor, task) => claimError(actor, task),
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
        for (const payload of generateBoardMessages(message.client, message.guild.id)) await message.channel.send(payload);
        return;
    }

    if (subcommand === 'setup' || subcommand === 'refresh') {
        if (!isManager(actor)) return message.reply('You need Manage Server permission for that.');
        if (subcommand === 'setup') {
            const { configs, config } = getBoardConfig(message.guild);
            const sent = await message.channel.send(generateBoardMessages(message.client, message.guild.id)[0]);
            Object.assign(config, { channelId: message.channel.id, messageId: sent.id, messageIds: [sent.id] });
            delete config.sectionMessageIds;
            saveBoardConfigs(configs);
        }
        await updateBoard(message.client, message.guild.id, { force: true });
        return message.reply(subcommand === 'setup' ? 'Live task board created. It updates by itself when tasks change.' : 'Board refreshed.');
    }

    if (subcommand === 'add') {
        const title = args.join(' ').trim();
        if (!title || title.length > 200) return message.reply('Usage: `!task add [TAG] Task title` (up to 200 characters).');
        const task = createIssue(actor, { title });
        if (!storage.addTask(message.guild.id, task)) return message.reply('Failed to save the task.');
        return message.reply(`Created ${task.issueKey}: "${title}". Anyone can claim it from **Find Work**.`);
    }

    if (subcommand === 'mine' || subcommand === 'find') {
        return message.channel.send(buildTaskPicker(storage.getAllTasks(message.guild.id), subcommand, 0, actor));
    }

    const usage = taskCommands[subcommand]?.usage || {
        details: '!task details KEY', edit: '!task edit KEY New title', delete: '!task delete KEY',
        due: '!task due KEY YYYY-MM-DD|none', assign: '!task assign KEY @user|none'
    }[subcommand];
    if (!usage) return message.client.commands.get('help').execute(message);
    const needsValue = ['edit', 'due', 'assign'].includes(subcommand);
    if (!args[0] || (needsValue && !args[1])) return message.reply(`Usage: \`${usage}\``);
    const task = findTask(message, args[0]);
    if (!task) return message.reply('I could not find that task. Use its key, such as `QSS-12`.');
    const value = args.slice(1).join(' ').trim();

    if (subcommand === 'details') return message.channel.send(buildTaskView(task, actor));

    if (taskCommands[subcommand]) {
        const { check, apply } = taskCommands[subcommand];
        const error = check(actor, task);
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
    generateBoardMessages,
    updateBoard,
    taskCommands
};
