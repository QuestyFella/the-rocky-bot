const fs = require('fs');
const path = require('path');

const configDir = './server-configs';

function normalizeConfig(config = {}) {
    if (config.allowedChannelId && !Array.isArray(config.allowedChannelIds)) {
        config.allowedChannelIds = [config.allowedChannelId];
        delete config.allowedChannelId;
    }

    if (!Array.isArray(config.allowedChannelIds)) {
        config.allowedChannelIds = [];
    }

    return config;
}

function getConfigPath(guildId) {
    return path.join(configDir, `${guildId}.json`);
}

function loadServerConfig(guildId) {
    const configPath = getConfigPath(guildId);

    try {
        if (!fs.existsSync(configPath)) {
            return { allowedChannelIds: [] };
        }

        const configFile = fs.readFileSync(configPath, 'utf8');
        return normalizeConfig(JSON.parse(configFile));
    } catch (error) {
        console.error(`Error loading config for server ${guildId}:`, error);
        return { allowedChannelIds: [] };
    }
}

function saveServerConfig(guildId, config) {
    try {
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        fs.writeFileSync(getConfigPath(guildId), JSON.stringify(normalizeConfig(config), null, 2));
        return true;
    } catch (error) {
        console.error(`Error saving config for server ${guildId}:`, error);
        return false;
    }
}

function getCachedServerConfig(client, guildId) {
    if (!client.serverConfigs[guildId]) {
        client.serverConfigs[guildId] = loadServerConfig(guildId);
    }

    return client.serverConfigs[guildId];
}

function canRunInChannel(config, channelId, commandName) {
    if (commandName === 'setchannel') {
        return true;
    }

    return config.allowedChannelIds.length === 0 || config.allowedChannelIds.includes(channelId);
}

module.exports = {
    canRunInChannel,
    getCachedServerConfig,
    loadServerConfig,
    saveServerConfig
};
