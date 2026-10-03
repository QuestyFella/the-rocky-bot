const { getCachedServerConfig, saveServerConfig } = require('./serverConfig');

const maxTeams = 24;

function getConfiguredTeams(actor) {
    const config = getCachedServerConfig(actor.client, actor.guild.id);
    return [...new Set(config.teamRoleIds || [])].map(id => actor.guild.roles.cache.get(id))
        .filter(role => role && role.id !== actor.guild.id && !role.managed).slice(0, maxTeams);
}

function saveTeams(actor, roleIds) {
    const ids = [...new Set(roleIds)];
    if (ids.length > maxTeams) return `Choose up to ${maxTeams} team roles.`;
    for (const id of ids) {
        const role = actor.guild.roles.cache.get(id);
        if (!role || id === actor.guild.id || role.managed) return 'Choose regular roles from this server. Everyone and bot/integration roles cannot be teams.';
    }
    const config = { ...getCachedServerConfig(actor.client, actor.guild.id), teamRoleIds: ids };
    if (!saveServerConfig(actor.guild.id, config)) return 'Failed to save teams. Your previous setup is unchanged.';
    actor.client.serverConfigs[actor.guild.id] = config;
    return null;
}

function validateTeam(actor, roleId) {
    if (!roleId) return null;
    if (!getConfiguredTeams(actor).some(role => role.id === roleId)) return 'This team is no longer set up. Open the task again and choose a configured team.';
    return null;
}

module.exports = { getConfiguredTeams, saveTeams, validateTeam, maxTeams };
