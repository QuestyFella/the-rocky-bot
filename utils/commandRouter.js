const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

const taskPrefix = '!task';
const kanbanSubcommands = new Set([
    'board', 'show', 'list', 'kanban', 'jira', 'setup', 'refresh', 'find', 'mine',
    'add', 'claim', 'start', 'done', 'close', 'unclaim', 'release', 'reopen',
    'details', 'view', 'edit', 'rename', 'due', 'duedate', 'assign', 'block', 'notice', 'delete', 'remove', 'commands'
]);

function isPrefixCommand(content, prefix) {
    return content === prefix || (content.startsWith(prefix) && /\s/.test(content[prefix.length] || ''));
}

function splitArgs(content) {
    return content.trim() ? content.trim().split(/\s+/) : [];
}

function registerCommand(commands, command) {
    const name = command.name.toLowerCase();
    commands.set(name, command);

    if (Array.isArray(command.aliases)) {
        for (const alias of command.aliases) {
            commands.set(alias.toLowerCase(), command);
        }
    }
}

function loadCommands(commandsDir) {
    const commands = new Collection();
    const commandFiles = fs.readdirSync(commandsDir).filter(file => file.endsWith('.js')).sort();

    for (const file of commandFiles) {
        const command = require(path.join(commandsDir, file));
        registerCommand(commands, command);
    }

    return commands;
}

function parseMessageCommand(content) {
    const trimmed = content.trim();

    if (isPrefixCommand(trimmed, taskPrefix)) {
        const args = splitArgs(trimmed.slice(taskPrefix.length));
        const commandName = (args.shift() || 'board').toLowerCase();
        if (kanbanSubcommands.has(commandName)) {
            return {
                commandName: 'board',
                args: commandName === 'jira' || commandName === 'kanban' ? args : [commandName, ...args],
                restricted: true
            };
        }

        return { commandName, args, restricted: true };
    }

    return null;
}

async function executeCommand(message, route) {
    const command = message.client.commands.get(route.commandName);

    try {
        if (command) await command.execute(message, route.args);
        else await message.reply('Unknown task command. Use `!task help` for a list of commands.');
    } catch (error) {
        console.error(`Error executing command ${route.commandName}:`, error);
        // This reply can fail too, for example when the bot cannot post here or the message was deleted.
        await message.reply('There was an error executing that command.').catch(() => {});
    }
}

module.exports = {
    executeCommand,
    loadCommands,
    parseMessageCommand
};
