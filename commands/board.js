const { EmbedBuilder, PermissionFlagsBits, MessageFlags, escapeMarkdown } = require('discord.js');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { dataPath } = require('../utils/dataPaths');
const { buildTaskPicker, buildTeamPicker, filterTasks } = require('../utils/boardComponents');
const {
    columns, priorities, normalizeColumn, normalizePriority, getTaskStatus, getTaskPriority,
    getIssueKey, sortBoardTasks, setTaskStatus, userCanManageIssue, claimError, releaseError
} = require('../utils/kanban');
const { getConfiguredTeams, getTaskTeam, validateTeam, setTaskTeam, preserveTaskTeam } = require('../utils/teams');
const { renderBoard } = require('../utils/boardDisplay');
const { canViewTask, isBlocked, blockingError, prerequisites, prerequisiteDone, prerequisiteLine, resolveDependencies, validateDependencyGraph } = require('../utils/taskDependencies');

const boardConfigFile = dataPath('kanbanBoards.json');
const legacyBoardConfigFile = dataPath('jiraBoards.json');
const kanbanBlue = 0x0052cc;
let boardConfigCache = null;
const boardUpdates = new Map();
const boardMessagePayloads = new Map();

function loadBoardConfigs() {
    if (boardConfigCache) {
        return boardConfigCache;
    }

    const configFile = fs.existsSync(boardConfigFile) ? boardConfigFile : legacyBoardConfigFile;
    if (!fs.existsSync(configFile)) {
        boardConfigCache = {};
        return boardConfigCache;
    }

    try {
        const raw = fs.readFileSync(configFile, 'utf8');
        boardConfigCache = raw.trim() ? JSON.parse(raw) : {};
        return boardConfigCache;
    } catch (error) {
        console.error('Failed to load Kanban board configs:', error);
        boardConfigCache = {};
        return boardConfigCache;
    }
}

function saveBoardConfigs(data) {
    boardConfigCache = data;
    fs.writeFileSync(boardConfigFile, JSON.stringify(data, null, 2));
}

function makeProjectKey(guild) {
    const words = guild.name.match(/[a-z0-9]+/gi) || [];
    const initials = words.map(word => word[0]).join('').toUpperCase();
    return (initials || 'TASK').slice(0, 5);
}

function getBoardConfig(guild, shouldSave = false) {
    const configs = loadBoardConfigs();
    if (!configs[guild.id]) {
        configs[guild.id] = {
            projectKey: makeProjectKey(guild),
            nextIssueNumber: 1,
            title: `${guild.name} Kanban Board`
        };
        shouldSave = true;
    }

    const config = configs[guild.id];
    if (!config.projectKey) {
        config.projectKey = makeProjectKey(guild);
        shouldSave = true;
    }
    if (!Number.isInteger(config.nextIssueNumber) || config.nextIssueNumber < 1) {
        config.nextIssueNumber = 1;
        shouldSave = true;
    }
    if (!config.title) {
        config.title = `${guild.name} Kanban Board`;
        shouldSave = true;
    }

    if (shouldSave) {
        saveBoardConfigs(configs);
    }

    return { configs, config };
}

function getNextIssueKey(guild) {
    const { configs, config } = getBoardConfig(guild, true);
    const issueKey = `${config.projectKey}-${config.nextIssueNumber}`;
    config.nextIssueNumber += 1;
    saveBoardConfigs(configs);
    return issueKey;
}

function parseDueDate(input) {
    const value = String(input || '').trim();
    if (!value) {
        return { ok: true, dueDate: null };
    }

    if (['none', 'clear', 'remove', 'unset'].includes(value.toLowerCase())) {
        return { ok: true, dueDate: null };
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const parsed = new Date(`${value}T00:00:00Z`);
        if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) {
            return { ok: true, dueDate: value };
        }
        return { ok: false };
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return { ok: false };
    }

    return { ok: true, dueDate: parsed.toISOString().split('T')[0] };
}

function formatDueDate(dueDate) {
    if (!dueDate) {
        return '';
    }

    const dueTime = new Date(`${dueDate}T00:00:00Z`).getTime();
    if (Number.isNaN(dueTime)) {
        return dueDate;
    }

    const now = new Date();
    const overdue = now.getTime() > dueTime + 86399999;
    const stamp = `<t:${Math.floor(dueTime / 1000)}:d>`;
    return overdue ? `overdue ${stamp}` : `due ${stamp}`;
}

function truncate(text, maxLength) {
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatAssignee(task) {
    if (task.userId) {
        return `<@${task.userId}>`;
    }
    if (task.assignedToRole) {
        return `<@&${task.assignedToRole}>`;
    }
    return 'Unassigned';
}

function isMentionToken(token, user, role) {
    if (!token) return false;
    if (user && (token === `<@${user.id}>` || token === `<@!${user.id}>`)) return true;
    if (role && token === `<@&${role.id}>`) return true;
    return false;
}

function getIssueDisplayKey(task, displayIndex) {
    return getIssueKey(task) || `#${displayIndex + 1}`;
}

function generateBoardMessages(client, guildId, guildName = 'Server') {
    const guild = client.guilds.cache.get(guildId);
    const { config } = guild ? getBoardConfig(guild, false) : { config: { title: `${guildName} Kanban Board` } };
    const tasks = client.taskStorage.getAllTasks(guildId);
    return renderBoard(tasks, config.title || `${guildName} Kanban Board`, guild ? { client, guild } : null);
}

function generateBoardEmbed(client, guildId, guildName = 'Server') {
    return generateBoardMessages(client, guildId, guildName)[0].embeds[0];
}

function findTask(message, identifier) {
    const tasks = message.client.taskStorage.getAllTasks(message.guild.id);
    const lookup = String(identifier || '').trim().toUpperCase();

    if (!lookup) {
        return { tasks, task: null };
    }

    let task = tasks.find(item => String(getIssueKey(item) || '').toUpperCase() === lookup || String(item.id).toUpperCase() === lookup);

    if (!task && /^\d+$/.test(lookup)) {
        task = tasks.find(item => String(item.id) === lookup);
        if (!task) {
            const displayIndex = parseInt(lookup, 10) - 1;
            const displayTasks = sortBoardTasks(tasks);
            task = displayTasks[displayIndex] || null;
        }
    }

    return { tasks, task: task && canViewTask(task, tasks, message) ? task : null };
}

function userCanAssignTo(message, user, role) {
    if (!user && !role) {
        return true;
    }
    if (user && user.id === message.author.id) {
        return true;
    }
    return message.member.permissions.has(PermissionFlagsBits.Administrator) || message.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function parseAddArgs(message, args) {
    let status = 'todo';
    let priority = 'medium';
    let dueDate = null;
    let description = '';
    let unassigned = false;
    let assignToMe = false;
    const titleParts = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const lower = arg.toLowerCase();

        if (['--me', '--claim'].includes(lower)) {
            assignToMe = true;
            continue;
        }

        if (lower.startsWith('--priority=')) {
            priority = normalizePriority(arg.slice('--priority='.length)) || priority;
            continue;
        }
        if (lower.startsWith('--status=') || lower.startsWith('--column=')) {
            const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
            status = normalizeColumn(value) || status;
            continue;
        }
        if (lower.startsWith('--due=')) {
            const parsed = parseDueDate(arg.slice('--due='.length));
            if (parsed.ok) dueDate = parsed.dueDate;
            continue;
        }
        if (lower.startsWith('--desc=')) {
            description = arg.slice('--desc='.length).trim();
            continue;
        }

        if (['--priority', '-p'].includes(lower)) {
            priority = normalizePriority(args[i + 1]) || priority;
            i += 1;
            continue;
        }
        if (['--status', '--column', '-s'].includes(lower)) {
            status = normalizeColumn(args[i + 1]) || status;
            i += 1;
            continue;
        }
        if (['--due', '-d'].includes(lower)) {
            const dueInput = [];
            i += 1;
            while (i < args.length && !args[i].startsWith('--')) {
                dueInput.push(args[i]);
                i += 1;
            }
            i -= 1;
            const parsed = parseDueDate(dueInput.join(' '));
            if (parsed.ok) dueDate = parsed.dueDate;
            continue;
        }
        if (['--desc', '--description'].includes(lower)) {
            const descInput = [];
            i += 1;
            while (i < args.length && !args[i].startsWith('--')) {
                descInput.push(args[i]);
                i += 1;
            }
            i -= 1;
            description = descInput.join(' ').trim();
            continue;
        }
        if (['--assign', '--assignee'].includes(lower)) {
            if (['none', 'unassigned'].includes(String(args[i + 1] || '').toLowerCase())) {
                unassigned = true;
            }
            i += 1;
            continue;
        }
        if (['--unassigned', '--no-assignee'].includes(lower)) {
            unassigned = true;
            continue;
        }

        const priorityMatch = arg.match(/^(?:p|priority):(.+)$/i);
        if (priorityMatch) {
            priority = normalizePriority(priorityMatch[1]) || priority;
            continue;
        }

        const statusMatch = arg.match(/^(?:s|status|column):(.+)$/i);
        if (statusMatch) {
            status = normalizeColumn(statusMatch[1]) || status;
            continue;
        }

        titleParts.push(arg);
    }

    const mentionedUser = message.mentions.users.first();
    const mentionedRole = message.mentions.roles.first();
    unassigned = unassigned || (!assignToMe && !mentionedUser && !mentionedRole);
    let cleanTitleParts = titleParts.filter(part => !isMentionToken(part, mentionedUser, mentionedRole));

    if (!dueDate) {
        const keywords = ['by', 'on'];
        let keywordIndex = -1;

        for (const keyword of keywords) {
            const index = cleanTitleParts.lastIndexOf(keyword);
            if (index > keywordIndex) {
                keywordIndex = index;
            }
        }

        if (keywordIndex !== -1) {
            const dueInput = cleanTitleParts.slice(keywordIndex + 1).join(' ');
            const parsed = parseDueDate(dueInput);
            if (parsed.ok && parsed.dueDate) {
                dueDate = parsed.dueDate;
                cleanTitleParts = cleanTitleParts.slice(0, keywordIndex);
            }
        }
    }

    return {
        title: cleanTitleParts.join(' ').trim(),
        description,
        dueDate,
        priority,
        status,
        user: unassigned ? null : mentionedUser || (!mentionedRole ? message.author : null),
        role: unassigned ? null : mentionedRole
    };
}

function createIssue(message, parsed) {
    return {
        id: randomUUID(),
        issueKey: getNextIssueKey(message.guild),
        title: parsed.title,
        description: parsed.description || '',
        dueDate: parsed.dueDate || null,
        priority: parsed.priority || 'medium',
        status: parsed.status || 'todo',
        completed: parsed.status === 'done',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: parsed.user ? parsed.user.id : null,
        assignedToRole: parsed.role ? parsed.role.id : null,
        teamId: parsed.team?.id || null,
        teamName: parsed.team?.name || null,
        assignedBy: parsed.user || parsed.role ? message.author.id : null,
        createdBy: message.author.id,
        guildId: message.guild.id
    };
}

function buildIssueEmbed(task, displayIndex, actor = null) {
    const status = columns.find(column => column.id === getTaskStatus(task));
    const priority = priorities[getTaskPriority(task)];
    const issueKey = getIssueDisplayKey(task, displayIndex);
    const embed = new EmbedBuilder()
        .setColor(kanbanBlue)
        .setTitle(truncate(`${issueKey}: ${task.title}`, 256))
        .setDescription(truncate(task.description || 'No description.', 3000))
        .addFields(
            { name: 'Status', value: `${status.icon} ${status.name}`, inline: true },
            { name: 'Priority', value: `${priority.icon} ${priority.label}`, inline: true },
            { name: 'Assignee', value: formatAssignee(task), inline: true },
            { name: 'Team', value: getTaskTeam(task, actor) ? escapeMarkdown(getTaskTeam(task, actor).name) : 'No team', inline: true },
            { name: 'Due', value: formatDueDate(task.dueDate) || 'No due date', inline: true },
            { name: 'Created', value: task.createdAt ? `<t:${Math.floor(new Date(task.createdAt).getTime() / 1000)}:R>` : 'Unknown', inline: true },
            { name: 'Task ID', value: String(task.id), inline: true }
        )
        .setTimestamp();

    const tasks = actor?.client?.taskStorage?.getAllTasks(actor.guild.id) || [task];
    const dependencies = prerequisites(task, tasks);
    if (dependencies.length) {
        const chunks = [''];
        for (const dependency of dependencies) {
            const line = prerequisiteLine(dependency);
            if (chunks.at(-1).length + line.length + 1 > 1000) chunks.push('');
            chunks[chunks.length - 1] += `${chunks.at(-1) ? '\n' : ''}${line}`;
        }
        const complete = dependencies.every(prerequisiteDone);
        embed.addFields(chunks.map((value, index) => ({ name: index ? 'Prerequisites continued' : isBlocked(task, tasks) ? '🔒 Blocked by' : complete ? 'Prerequisites complete' : 'Prerequisites', value })));
    }

    const data = embed.toJSON();
    const detailsLength = data.title.length + data.fields.reduce((length, field) => length + field.name.length + field.value.length, 0);
    if (data.description.length + detailsLength > 5900) embed.setDescription(truncate(data.description, 5900 - detailsLength));

    return embed;
}

function boardPartPayload(payloads, index, guildId, channelId, messageIds) {
    const { sectionKey, tagId, indexTags, ...payload } = payloads[index];
    const links = [];
    const link = (label, page) => {
        if (messageIds[page] && page < payloads.length) links.push(`[${label}](https://discord.com/channels/${guildId}/${channelId}/${messageIds[page]})`);
    };
    link(payloads[index - 1]?.tagId === tagId ? 'Previous part' : 'Previous group', index - 1);
    if (index > 0 && payloads[0].indexTags) link('Overview', 0);
    link(payloads[index + 1]?.tagId === tagId ? 'Next part' : 'Next group', index + 1);
    if (indexTags) {
        const data = payload.embeds[0].toJSON();
        data.fields = data.fields.map((field, fieldIndex) => {
            const page = payloads.findIndex(part => part.tagId === indexTags[fieldIndex]);
            return { ...field, value: field.value + (messageIds[page] ? `\n[View tasks](https://discord.com/channels/${guildId}/${channelId}/${messageIds[page]})` : '') };
        });
        payload.embeds = [new EmbedBuilder(data)];
    }
    return { ...payload, content: links.join(' · ') };
}

async function syncBoard(client, guildId, force = false) {
    const configs = loadBoardConfigs();
    const config = configs[guildId];

    if (!config || !config.channelId || !config.messageId) {
        return;
    }

    try {
        const channel = await client.channels.fetch(config.channelId);
        if (!channel) return;

        const guild = client.guilds.cache.get(guildId);
        const payloads = generateBoardMessages(client, guildId, guild ? guild.name : 'Server');
        const trackedIds = new Set(config.messageIds?.length ? config.messageIds : [config.messageId]);
        const usedIds = new Set();
        const messageIds = payloads.map((payload, index) => {
            const id = index === 0 ? config.messageId : config.sectionMessageIds ? config.sectionMessageIds[payload.sectionKey] : config.messageIds?.[index];
            if (!id || usedIds.has(id)) return undefined;
            usedIds.add(id);
            return id;
        });
        const sections = {};
        const messages = [];
        const persistIds = () => {
            config.messageId = messageIds[0];
            config.messageIds = [...new Set([...messageIds.filter(Boolean), ...trackedIds])];
            config.sectionMessageIds = { ...config.sectionMessageIds, ...sections };
            saveBoardConfigs(configs);
        };
        for (let index = 0; index < payloads.length; index++) {
            let message;
            if (messageIds[index]) {
                try { message = await channel.messages.fetch(messageIds[index]); }
                catch (error) { if (error.code !== 10008) throw error; }
            }
            if (!message) {
                message = await channel.send({ ...boardPartPayload(payloads, index, guildId, config.channelId, messageIds), flags: MessageFlags.SuppressNotifications });
                messageIds[index] = message.id;
                trackedIds.add(message.id);
                sections[payloads[index].sectionKey] = message.id;
                // Record each sent message immediately so a later failure can retry it.
                persistIds();
            }
            sections[payloads[index].sectionKey] = message.id;
            messages.push(message);
        }
        for (let index = 0; index < messages.length; index++) {
            const payload = boardPartPayload(payloads, index, guildId, config.channelId, messageIds);
            const fingerprint = JSON.stringify({ ...payload, embeds: payload.embeds.map(embed => embed.toJSON()), components: payload.components.map(row => row.toJSON()) });
            const cacheKey = `${guildId}:${messages[index].id}`;
            if (force || boardMessagePayloads.get(cacheKey) !== fingerprint) {
                await messages[index].edit(payload);
                boardMessagePayloads.set(cacheKey, fingerprint);
            }
        }
        // Only remove messages created for this board, when its task list shrinks.
        for (const id of [...trackedIds].filter(id => !messageIds.includes(id))) {
            try {
                const message = await channel.messages.fetch(id);
                if (message.author.id !== client.user.id) throw new Error('Refusing to remove a board message owned by another user.');
                await message.delete();
            } catch (error) { if (error.code !== 10008) throw error; }
            trackedIds.delete(id);
            boardMessagePayloads.delete(`${guildId}:${id}`);
            persistIds();
        }
        if (JSON.stringify(config.messageIds) !== JSON.stringify(messageIds) || JSON.stringify(config.sectionMessageIds) !== JSON.stringify(sections)) {
            config.messageId = messageIds[0]; config.messageIds = messageIds; config.sectionMessageIds = sections;
            saveBoardConfigs(configs);
        }
    } catch (error) {
        console.error(`Failed to update Kanban board for guild ${guildId}:`, error);
    }
}

function updateBoard(client, guildId, { force = false } = {}) {
    // Task changes, refresh clicks, and the timer share one update per server.
    const update = (boardUpdates.get(guildId) || Promise.resolve()).then(() => syncBoard(client, guildId, force));
    boardUpdates.set(guildId, update);
    update.finally(() => { if (boardUpdates.get(guildId) === update) boardUpdates.delete(guildId); }).catch(() => {});
    return update;
}

function sendUsage(message) {
    const embed = new EmbedBuilder()
        .setColor(kanbanBlue)
        .setTitle('Kanban Board Commands')
        .setDescription(
            '`!task setup` - Create a live-updating board in this channel.\n' +
            '`!task` - Open the board and its buttons.\n' +
            '**More → Import Tasks** / `!task import` - Managers can paste a list or upload a .txt file, then confirm the preview.\n' +
            'Click **Add Task** to create a task, **Available Tasks** to claim work, **My Tasks** for your tasks, or **Team Tasks** to choose a group. Open a task and click **Edit Task** to edit its details. Managers can enter team names through **More → Setup Teams**.\n' +
            '`!task add Fix avionics @user by 2026-06-01` - Add an issue.\n' +
            '`!task move KEY doing` - Move an issue between columns.\n' +
            '`!task claim KEY` - Assign an issue to yourself.\n' +
            '`!task start KEY` - Claim and move to In Progress.\n' +
            '`!task release KEY` - Return your task to To Do.\n' +
            '`!task team KEY Team Name` - Set a team tag; use `none` to clear it.\n' +
            '`!task assign KEY @user` - Assign an issue.\n' +
            '`!task priority KEY high` - Set priority.\n' +
            '`!task due KEY 2026-06-01` - Set or clear a due date.\n' +
            '`!task depends KEY OTHER-1, [POWER]` - Wait for tasks or whole tags; use `none` to clear.\n' +
            '`!task details KEY` - Show one issue.\n' +
            '`!task edit KEY New title` - Rename an issue.\n' +
            '`!task delete KEY` - Delete an issue.\n\n' +
            'New tasks are unassigned by default; add `--me` to assign one to yourself.\nAliases: `!task board`, `!task kanban`, and `!task jira`. Columns: `todo`, `doing`, `review`, `done`. Priorities: `low`, `medium`, `high`, `urgent`.'
        )
        .setTimestamp();

    return message.channel.send({ embeds: [embed] });
}

module.exports = {
    name: 'board',
    aliases: ['kanban', 'jira'],
    description: 'Manage a Kanban board with embeds',
    async execute(message, args) {
        const subcommand = (args.shift() || 'board').toLowerCase();

        if (['help', 'commands'].includes(subcommand)) {
            return sendUsage(message);
        }

        if (['board', 'list', 'show'].includes(subcommand)) {
            const payloads = generateBoardMessages(message.client, message.guild.id, message.guild.name);
            const messages = [];
            for (const [index] of payloads.entries()) messages.push(await message.channel.send(boardPartPayload(payloads, index, message.guild.id, message.channel.id, [])));
            const ids = messages.map(item => item?.id);
            for (const [index, item] of messages.entries()) if (item?.edit) await item.edit(boardPartPayload(payloads, index, message.guild.id, message.channel.id, ids));
            return;
        }

        if (['myteams', 'teamtasks'].includes(subcommand)) {
            const actor = { client: message.client, guild: message.guild, member: message.member, author: message.author, publicList: true };
            return message.channel.send(buildTeamPicker(message.client.taskStorage.getAllTasks(message.guild.id), actor));
        }

        if (['mine', 'available'].includes(subcommand)) {
            const filter = subcommand;
            const actor = { client: message.client, guild: message.guild, member: message.member, author: message.author, publicList: true };
            const tasks = sortBoardTasks(filterTasks(message.client.taskStorage.getAllTasks(message.guild.id), filter, actor));
            return message.channel.send(buildTaskPicker(tasks, filter, 0, actor));
        }

        if (['depends', 'blockedby'].includes(subcommand)) {
            if (args.length < 2) return message.reply('Usage: `!task depends KEY OTHER-1, [POWER]` or `!task depends KEY none`');
            const { tasks, task } = findTask(message, args[0]);
            if (!task) return message.reply('I could not find that task. Blocked tasks are available to server managers through More → Blocked Tasks.');
            if (!userCanManageIssue(message, task)) return message.reply('You do not have permission to edit this task.');
            const dependencies = resolveDependencies(task, args.slice(1).join(' '), tasks);
            if (dependencies.error) return message.reply(dependencies.error);
            task.dependsOn = dependencies.ids;
            task.dependsOnTags = dependencies.tags;
            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return message.reply(success ? `Prerequisites saved for ${getIssueKey(task) || task.id}. It will unlock when every prerequisite is Done.` : 'Failed to save prerequisites.');
        }

        if (subcommand === 'team') {
            if (args.length < 2) return message.reply('Usage: `!task team KEY Team Name` or `!task team KEY none`. Use Setup Teams first.');
            const { task } = findTask(message, args[0]);
            if (!task) return message.reply('I could not find that task.');
            if (!userCanManageIssue(message, task)) return message.reply('You do not have permission to change this task’s team.');
            const name = args.slice(1).join(' ').trim();
            const clear = ['none', 'clear'].includes(name.toLowerCase());
            const team = getConfiguredTeams(message).find(team => team.name.toLowerCase() === name.toLowerCase());
            if (!clear && !team) return message.reply('Enter a configured team name or use `none`. You can also choose the team from a task’s dropdown.');
            const error = validateTeam(message, clear ? null : team.id);
            if (error) return message.reply(error);
            setTaskTeam(task, clear ? null : team);
            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return message.reply(success ? `Updated the team tag for ${getIssueKey(task) || task.id}.` : 'Failed to save the team tag.');
        }

        if (subcommand === 'setup') {
            if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply('You need Manage Guild permissions to set up a live board.');
            }

            getBoardConfig(message.guild, true);
            const payloads = generateBoardMessages(message.client, message.guild.id, message.guild.name);
            const sentMessage = await message.channel.send(boardPartPayload(payloads, 0, message.guild.id, message.channel.id, []));
            const configs = loadBoardConfigs();
            configs[message.guild.id] = {
                ...configs[message.guild.id],
                channelId: message.channel.id,
                messageId: sentMessage.id,
                messageIds: [sentMessage.id],
                sectionMessageIds: { [payloads[0].sectionKey]: sentMessage.id }
            };
            saveBoardConfigs(configs);
            if (payloads.length > 1) await updateBoard(message.client, message.guild.id);
            return message.reply('Live Kanban board created. It will update when tasks change.');
        }

        if (subcommand === 'refresh') {
            if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply('You need Manage Guild permissions to refresh the live board.');
            }

            await updateBoard(message.client, message.guild.id, { force: true });
            return message.reply('Live Kanban board refreshed.');
        }

        if (subcommand === 'add') {
            const parsed = parseAddArgs(message, args);
            if (!parsed.title) {
                return message.reply('Please provide an issue title. Example: `!task add Fix avionics @Sam by 2026-06-01`');
            }
            if (!userCanAssignTo(message, parsed.user, parsed.role)) {
                return message.reply('You need Manage Guild permissions to assign issues to other users or roles.');
            }

            const newTask = createIssue(message, parsed);

            const success = message.client.taskStorage.addTask(message.guild.id, newTask);
            if (!success) {
                return message.reply('Failed to save issue to storage.');
            }

            const status = columns.find(column => column.id === parsed.status);
            return message.reply(`Created ${newTask.issueKey} in ${status.name}: "${newTask.title}"`);
        }

        if (['move', 'status'].includes(subcommand)) {
            if (args.length < 2) {
                return message.reply('Usage: `!task move KEY todo|doing|review|done`');
            }

            const { tasks, task } = findTask(message, args[0]);
            const nextStatus = normalizeColumn(args.slice(1).join(' '));
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            if (!nextStatus) {
                return message.reply('Please choose a valid column: todo, doing, review, or done.');
            }
            if (!userCanManageIssue(message, task)) {
                return message.reply('You can only move issues assigned to you, created by you, or managed by your role.');
            }

            const blocked = nextStatus !== 'todo' && blockingError(task, tasks);
            if (blocked) return message.reply(blocked);

            setTaskStatus(task, nextStatus);
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            const status = columns.find(column => column.id === nextStatus);
            return success ? message.reply(`Moved ${getIssueKey(task) || task.id} to ${status.name}.`) : message.reply('Failed to update issue.');
        }

        if (['done', 'close'].includes(subcommand)) {
            if (!args[0]) {
                return message.reply('Usage: `!task done KEY`');
            }
            return module.exports.execute(message, ['move', args[0], 'done']);
        }

        if (subcommand === 'reopen') {
            if (!args[0]) {
                return message.reply('Usage: `!task reopen KEY`');
            }
            return module.exports.execute(message, ['move', args[0], 'todo']);
        }

        if (subcommand === 'claim') {
            if (!args[0]) {
                return message.reply('Usage: `!task claim KEY`');
            }

            const { task } = findTask(message, args[0]);
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            const error = claimError(message, task);
            if (error) return message.reply(error);

            preserveTaskTeam(task, message);
            task.userId = message.author.id;
            task.assignedToRole = null;
            task.assignedBy = message.author.id;
            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return success ? message.reply(`Assigned ${getIssueKey(task) || task.id} to you.`) : message.reply('Failed to update issue.');
        }

        if (subcommand === 'start') {
            if (!args[0]) return message.reply('Usage: `!task start KEY`');
            const { task } = findTask(message, args[0]);
            if (!task) return message.reply('I could not find that task.');
            const error = claimError(message, task);
            if (error) return message.reply(error);
            preserveTaskTeam(task, message);
            task.userId = message.author.id;
            task.assignedToRole = null;
            task.assignedBy = message.author.id;
            setTaskStatus(task, 'progress');
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return message.reply(success ? `Assigned ${getIssueKey(task) || task.id} to you and moved it to In Progress.` : 'Failed to update task.');
        }

        if (['release', 'unclaim'].includes(subcommand)) {
            if (!args[0]) return message.reply('Usage: `!task release KEY`');
            const { task } = findTask(message, args[0]);
            if (!task) return message.reply('I could not find that task.');
            const error = releaseError(message, task);
            if (error) return message.reply(error);
            preserveTaskTeam(task, message);
            task.userId = null;
            task.assignedToRole = null;
            task.assignedBy = null;
            setTaskStatus(task, 'todo');
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return message.reply(success ? `Released ${getIssueKey(task) || task.id} back to To Do.` : 'Failed to update task.');
        }

        if (subcommand === 'assign') {
            if (args.length < 2) {
                return message.reply('Usage: `!task assign KEY @user`, `!task assign KEY @role`, or `!task assign KEY none`');
            }

            const { task } = findTask(message, args[0]);
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            if (!userCanManageIssue(message, task)) {
                return message.reply('You can only assign issues assigned to you, created by you, or managed by your role.');
            }

            const target = args.slice(1).join(' ').toLowerCase();
            const user = message.mentions.users.first();
            const role = message.mentions.roles.first();

            preserveTaskTeam(task, message);

            if (target === 'none' || target === 'unassigned') {
                task.userId = null;
                task.assignedToRole = null;
            } else if (user) {
                if (!userCanAssignTo(message, user, null)) {
                    return message.reply('You need Manage Guild permissions to assign issues to other users.');
                }
                task.userId = user.id;
                task.assignedToRole = null;
            } else if (role) {
                if (!userCanAssignTo(message, null, role)) {
                    return message.reply('You need Manage Guild permissions to assign issues to roles.');
                }
                task.userId = null;
                task.assignedToRole = role.id;
            } else {
                return message.reply('Please mention a user or role, or use `none`.');
            }

            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return success ? message.reply(`Updated assignee for ${getIssueKey(task) || task.id}: ${formatAssignee(task)}.`) : message.reply('Failed to update issue.');
        }

        if (subcommand === 'priority') {
            if (args.length < 2) {
                return message.reply('Usage: `!task priority KEY low|medium|high|urgent`');
            }

            const { task } = findTask(message, args[0]);
            const priority = normalizePriority(args[1]);
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            if (!priority) {
                return message.reply('Please choose a valid priority: low, medium, high, or urgent.');
            }
            if (!userCanManageIssue(message, task)) {
                return message.reply('You can only edit issues assigned to you, created by you, or managed by your role.');
            }

            task.priority = priority;
            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return success ? message.reply(`Set ${getIssueKey(task) || task.id} priority to ${priorities[priority].label}.`) : message.reply('Failed to update issue.');
        }

        if (['due', 'duedate'].includes(subcommand)) {
            if (args.length < 2) {
                return message.reply('Usage: `!task due KEY 2026-06-01` or `!task due KEY none`');
            }

            const { task } = findTask(message, args[0]);
            const parsed = parseDueDate(args.slice(1).join(' '));
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            if (!parsed.ok) {
                return message.reply('Please provide a valid date, such as `2026-06-01`, or `none` to clear it.');
            }
            if (!userCanManageIssue(message, task)) {
                return message.reply('You can only edit issues assigned to you, created by you, or managed by your role.');
            }

            task.dueDate = parsed.dueDate;
            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return success ? message.reply(`Updated due date for ${getIssueKey(task) || task.id}: ${parsed.dueDate || 'none'}.`) : message.reply('Failed to update issue.');
        }

        if (['details', 'view'].includes(subcommand)) {
            if (!args[0]) {
                return message.reply('Usage: `!task details KEY`');
            }

            const { tasks, task } = findTask(message, args[0]);
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }

            if (isBlocked(task, tasks)) return message.reply('This task is blocked. Open More → Blocked Tasks to view it privately.');

            const displayIndex = sortBoardTasks(tasks).findIndex(item => item.id === task.id);
            const embed = buildIssueEmbed(task, displayIndex, message);
            return message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        if (['edit', 'rename'].includes(subcommand)) {
            if (args.length < 2) {
                return message.reply('Usage: `!task edit KEY New title`');
            }

            const { tasks, task } = findTask(message, args[0]);
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            if (!userCanManageIssue(message, task)) {
                return message.reply('You can only edit issues assigned to you, created by you, or managed by your role.');
            }

            task.title = args.slice(1).join(' ').trim();
            const cycle = validateDependencyGraph(task, tasks);
            if (cycle) return message.reply(cycle);
            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return success ? message.reply(`Renamed ${getIssueKey(task) || task.id}.`) : message.reply('Failed to update issue.');
        }

        if (['delete', 'remove'].includes(subcommand)) {
            if (!args[0]) {
                return message.reply('Usage: `!task delete KEY`');
            }

            const { task } = findTask(message, args[0]);
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            if (!userCanManageIssue(message, task)) {
                return message.reply('You can only delete issues assigned to you, created by you, or managed by your role.');
            }

            const success = message.client.taskStorage.deleteTask(message.guild.id, task.id);
            return success ? message.reply(`Deleted ${getIssueKey(task) || task.id}.`) : message.reply('Failed to delete issue.');
        }

        return sendUsage(message);
    },
    generateBoardEmbed,
    generateBoardMessages,
    buildIssueEmbed,
    createIssue,
    parseDueDate,
    findTask,
    updateBoard
};
