const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

const taskPrefix = '!task';
const standalonePrefixes = {
    '!utter': 'utter'
};

function isPrefixCommand(content, prefix) {
    return content === prefix || content.startsWith(`${prefix} `);
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
    const commandList = [];
    const commandFiles = fs.readdirSync(commandsDir).filter(file => file.endsWith('.js')).sort();

    for (const file of commandFiles) {
        const command = require(path.join(commandsDir, file));
        registerCommand(commands, command);
        commandList.push(command);
    }

    return { commands, commandList };
}

function parseMessageCommand(content) {
    const trimmed = content.trim();

    if (isPrefixCommand(trimmed, taskPrefix)) {
        const args = splitArgs(trimmed.slice(taskPrefix.length));
        const commandName = (args.shift() || 'help').toLowerCase();
        return { commandName, args, restricted: true };
    }

    for (const [prefix, commandName] of Object.entries(standalonePrefixes)) {
        if (isPrefixCommand(trimmed, prefix)) {
            return {
                commandName,
                args: splitArgs(trimmed.slice(prefix.length)),
                restricted: false
            };
        }
    }

    return null;
}

async function executeCommand(message, route) {
    const command = message.client.commands.get(route.commandName);

    if (!command) {
        return message.reply('Unknown task command. Use `!task help` for a list of commands.');
    }

    try {
        await command.execute(message, route.args);
    } catch (error) {
        console.error(`Error executing command ${route.commandName}:`, error);
        await message.reply('There was an error executing that command.');
    }
}

module.exports = {
    executeCommand,
    loadCommands,
    parseMessageCommand
};
