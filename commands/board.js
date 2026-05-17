const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');

const boardConfigFile = './kanbanBoards.json';
const legacyBoardConfigFile = './jiraBoards.json';
const kanbanBlue = 0x0052cc;
let boardConfigCache = null;

const columns = [
    { id: 'todo', name: 'To Do', icon: '📥' },
    { id: 'progress', name: 'In Progress', icon: '🔧' },
    { id: 'review', name: 'Review', icon: '👀' },
    { id: 'done', name: 'Done', icon: '✅' }
];

const columnAliases = {
    backlog: 'todo',
    open: 'todo',
    ready: 'todo',
    todo: 'todo',
    'to-do': 'todo',
    doing: 'progress',
    progress: 'progress',
    'in-progress': 'progress',
    inprogress: 'progress',
    wip: 'progress',
    review: 'review',
    testing: 'review',
    test: 'review',
    qa: 'review',
    done: 'done',
    complete: 'done',
    completed: 'done',
    closed: 'done'
};

const priorities = {
    low: { label: 'Low', icon: '🟢', weight: 1 },
    medium: { label: 'Medium', icon: '🟡', weight: 2 },
    high: { label: 'High', icon: '🟠', weight: 3 },
    urgent: { label: 'Urgent', icon: '🔴', weight: 4 }
};

const priorityAliases = {
    l: 'low',
    low: 'low',
    normal: 'medium',
    med: 'medium',
    medium: 'medium',
    m: 'medium',
    high: 'high',
    h: 'high',
    urgent: 'urgent',
    critical: 'urgent',
    blocker: 'urgent',
    p1: 'urgent',
    p2: 'high',
    p3: 'medium',
    p4: 'low'
};

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

function normalizeColumn(value) {
    if (!value) return null;

    const cleaned = String(value).toLowerCase().trim().replace(/[_\s]+/g, '-');
    return columnAliases[cleaned] || columnAliases[cleaned.replace(/-/g, '')] || null;
}

function normalizePriority(value) {
    if (!value) return null;
    return priorityAliases[String(value).toLowerCase().trim()] || null;
}

function getTaskStatus(task) {
    const status = normalizeColumn(task.status);
    if (status === 'done' || task.completed) {
        return 'done';
    }
    return status || 'todo';
}

function getTaskPriority(task) {
    return normalizePriority(task.priority) || 'medium';
}

function setTaskStatus(task, status) {
    task.status = status;
    task.completed = status === 'done';
    task.updatedAt = new Date().toISOString();
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
        if (!Number.isNaN(parsed.getTime())) {
            return { ok: true, dueDate: value };
        }
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

function sortBoardTasks(tasks) {
    return [...tasks].sort((a, b) => {
        const aStatus = getTaskStatus(a);
        const bStatus = getTaskStatus(b);
        const aColumn = columns.findIndex(column => column.id === aStatus);
        const bColumn = columns.findIndex(column => column.id === bStatus);

        if (aColumn !== bColumn) {
            return aColumn - bColumn;
        }

        if (aStatus === 'done') {
            return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
        }

        const priorityDifference = priorities[getTaskPriority(b)].weight - priorities[getTaskPriority(a)].weight;
        if (priorityDifference !== 0) {
            return priorityDifference;
        }

        if (a.dueDate && b.dueDate) {
            return new Date(a.dueDate) - new Date(b.dueDate);
        }
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;

        return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    });
}

function getIssueDisplayKey(task, displayIndex) {
    return getIssueKey(task) || `#${displayIndex + 1}`;
}

function getIssueKey(task) {
    return task.issueKey || task.jiraKey;
}

function formatIssueLine(task, displayIndex) {
    const priority = priorities[getTaskPriority(task)];
    const due = formatDueDate(task.dueDate);
    const details = [formatAssignee(task), due].filter(Boolean).join(' - ');
    const title = truncate(task.title, 58);
    const issueKey = getIssueDisplayKey(task, displayIndex);
    return `\`${issueKey}\` ${priority.icon} **${title}**${details ? ` - ${details}` : ''}`;
}

function buildColumnValue(columnTasks, displayTasks) {
    if (columnTasks.length === 0) {
        return 'No issues.';
    }

    const lines = [];
    let hidden = 0;

    for (const task of columnTasks) {
        const displayIndex = displayTasks.findIndex(displayTask => displayTask.id === task.id);
        const line = formatIssueLine(task, displayIndex);
        const nextValue = [...lines, line].join('\n');

        if (nextValue.length > 950) {
            hidden += 1;
            continue;
        }

        lines.push(line);
    }

    if (hidden > 0) {
        lines.push(`...and ${hidden} more`);
    }

    return lines.join('\n');
}

function generateBoardEmbed(client, guildId, guildName = 'Server') {
    const guild = client.guilds.cache.get(guildId);
    const { config } = guild ? getBoardConfig(guild, false) : { config: { title: `${guildName} Kanban Board` } };
    const tasks = client.taskStorage.getAllTasks(guildId);
    const displayTasks = sortBoardTasks(tasks);
    const activeCount = tasks.filter(task => getTaskStatus(task) !== 'done').length;
    const doneCount = tasks.length - activeCount;

    const embed = new EmbedBuilder()
        .setColor(kanbanBlue)
        .setTitle(config.title || `${guildName} Kanban Board`)
        .setDescription(`${activeCount} active issue(s), ${doneCount} done. Use \`!task help\` for commands.`)
        .setFooter({ text: 'Add: !task add Task title | Move: !task move KEY doing' })
        .setTimestamp();

    for (const column of columns) {
        const columnTasks = displayTasks.filter(task => getTaskStatus(task) === column.id);
        embed.addFields({
            name: `${column.icon} ${column.name} (${columnTasks.length})`,
            value: buildColumnValue(columnTasks, displayTasks),
            inline: false
        });
    }

    return embed;
}

function findTask(message, identifier) {
    const tasks = message.client.taskStorage.getAllTasks(message.guild.id);
    const lookup = String(identifier || '').trim().toUpperCase();

    if (!lookup) {
        return { tasks, task: null };
    }

    let task = tasks.find(item => String(getIssueKey(item) || '').toUpperCase() === lookup);

    if (!task && /^\d+$/.test(lookup)) {
        task = tasks.find(item => String(item.id) === lookup);
        if (!task) {
            const displayIndex = parseInt(lookup, 10) - 1;
            const displayTasks = sortBoardTasks(tasks);
            task = displayTasks[displayIndex] || null;
        }
    }

    return { tasks, task };
}

function userCanManageIssue(message, task) {
    if (message.member.permissions.has(PermissionFlagsBits.Administrator) || message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return true;
    }
    if (task.userId === message.author.id || task.createdBy === message.author.id || task.assignedBy === message.author.id) {
        return true;
    }
    if (task.assignedToRole && message.member.roles.cache.has(task.assignedToRole)) {
        return true;
    }
    return false;
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
    const titleParts = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const lower = arg.toLowerCase();

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

    const mentionedUser = unassigned ? null : message.mentions.users.first();
    const mentionedRole = unassigned ? null : message.mentions.roles.first();
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
        user: mentionedUser || (!unassigned && !mentionedRole ? message.author : null),
        role: mentionedRole
    };
}

function buildIssueEmbed(task, displayIndex) {
    const status = columns.find(column => column.id === getTaskStatus(task));
    const priority = priorities[getTaskPriority(task)];
    const issueKey = getIssueDisplayKey(task, displayIndex);
    const embed = new EmbedBuilder()
        .setColor(kanbanBlue)
        .setTitle(`${issueKey}: ${task.title}`)
        .setDescription(task.description || 'No description.')
        .addFields(
            { name: 'Status', value: `${status.icon} ${status.name}`, inline: true },
            { name: 'Priority', value: `${priority.icon} ${priority.label}`, inline: true },
            { name: 'Assignee', value: formatAssignee(task), inline: true },
            { name: 'Due', value: formatDueDate(task.dueDate) || 'No due date', inline: true },
            { name: 'Created', value: task.createdAt ? `<t:${Math.floor(new Date(task.createdAt).getTime() / 1000)}:R>` : 'Unknown', inline: true },
            { name: 'Task ID', value: String(task.id), inline: true }
        )
        .setTimestamp();

    return embed;
}

async function updateBoard(client, guildId) {
    const configs = loadBoardConfigs();
    const config = configs[guildId];

    if (!config || !config.channelId || !config.messageId) {
        return;
    }

    try {
        const channel = await client.channels.fetch(config.channelId);
        if (!channel) return;

        const boardMessage = await channel.messages.fetch(config.messageId);
        if (!boardMessage) return;

        const guild = client.guilds.cache.get(guildId);
        const embed = generateBoardEmbed(client, guildId, guild ? guild.name : 'Server');

        await boardMessage.edit({
            embeds: [embed],
            allowedMentions: { parse: [] }
        });
    } catch (error) {
        console.error(`Failed to update Kanban board for guild ${guildId}:`, error);
    }
}

function sendUsage(message) {
    const embed = new EmbedBuilder()
        .setColor(kanbanBlue)
        .setTitle('Kanban Board Commands')
        .setDescription(
            '`!task setup` - Create a live-updating board in this channel.\n' +
            '`!task` - Show the board once.\n' +
            '`!task add Fix avionics @user by 2026-06-01` - Add an issue.\n' +
            '`!task move KEY doing` - Move an issue between columns.\n' +
            '`!task claim KEY` - Assign an issue to yourself.\n' +
            '`!task assign KEY @user` - Assign an issue.\n' +
            '`!task priority KEY high` - Set priority.\n' +
            '`!task due KEY 2026-06-01` - Set or clear a due date.\n' +
            '`!task details KEY` - Show one issue.\n' +
            '`!task edit KEY New title` - Rename an issue.\n' +
            '`!task delete KEY` - Delete an issue.\n\n' +
            'Aliases: `!task board`, `!task kanban`, and `!task jira`. Columns: `todo`, `doing`, `review`, `done`. Priorities: `low`, `medium`, `high`, `urgent`.'
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
            const embed = generateBoardEmbed(message.client, message.guild.id, message.guild.name);
            return message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        if (subcommand === 'setup') {
            if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply('You need Manage Guild permissions to set up a live board.');
            }

            getBoardConfig(message.guild, true);
            const embed = generateBoardEmbed(message.client, message.guild.id, message.guild.name);
            const sentMessage = await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            const configs = loadBoardConfigs();
            configs[message.guild.id] = {
                ...configs[message.guild.id],
                channelId: message.channel.id,
                messageId: sentMessage.id
            };
            saveBoardConfigs(configs);
            return message.reply('Live Kanban board created. It will update when tasks change.');
        }

        if (subcommand === 'refresh') {
            if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply('You need Manage Guild permissions to refresh the live board.');
            }

            await updateBoard(message.client, message.guild.id);
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

            const newTask = {
                id: Date.now(),
                issueKey: getNextIssueKey(message.guild),
                title: parsed.title,
                description: parsed.description,
                dueDate: parsed.dueDate,
                priority: parsed.priority,
                status: parsed.status,
                completed: parsed.status === 'done',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                userId: parsed.user ? parsed.user.id : null,
                assignedToRole: parsed.role ? parsed.role.id : null,
                assignedBy: message.author.id,
                createdBy: message.author.id,
                guildId: message.guild.id
            };

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

            const { task } = findTask(message, args[0]);
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
            if (!userCanManageIssue(message, task) && task.userId && task.userId !== message.author.id) {
                return message.reply('You can only claim unassigned issues or issues you can manage.');
            }

            task.userId = message.author.id;
            task.assignedToRole = null;
            task.updatedAt = new Date().toISOString();
            const success = message.client.taskStorage.updateTask(message.guild.id, task.id, task);
            return success ? message.reply(`Assigned ${getIssueKey(task) || task.id} to you.`) : message.reply('Failed to update issue.');
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

            const displayIndex = sortBoardTasks(tasks).findIndex(item => item.id === task.id);
            const embed = buildIssueEmbed(task, displayIndex);
            return message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        if (['edit', 'rename'].includes(subcommand)) {
            if (args.length < 2) {
                return message.reply('Usage: `!task edit KEY New title`');
            }

            const { task } = findTask(message, args[0]);
            if (!task) {
                return message.reply('I could not find that issue. Use the issue key, task ID, or board number.');
            }
            if (!userCanManageIssue(message, task)) {
                return message.reply('You can only edit issues assigned to you, created by you, or managed by your role.');
            }

            task.title = args.slice(1).join(' ').trim();
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
            return success ? message.reply(`Deleted ${getIssueKey(task) || task.id}: "${task.title}"`) : message.reply('Failed to delete issue.');
        }

        return sendUsage(message);
    },
    generateBoardEmbed,
    updateBoard
};
