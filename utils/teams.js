const { randomUUID } = require('crypto');
const { getCachedServerConfig, saveServerConfig } = require('./serverConfig');

const maxTeams = 24;
const maxTeamNameLength = 50;

function getConfiguredTeams(actor) {
    if (!actor) return [];
    const config = getCachedServerConfig(actor.client, actor.guild.id);
    if (Array.isArray(config.teams)) return config.teams.slice(0, maxTeams);
    // Keep names from the earlier role-based setup when switching to plain labels.
    return [...new Set(config.teamRoleIds || [])].slice(0, maxTeams).map(id => ({
        id: `legacy-${id}`, name: actor.guild.roles.cache.get(id)?.name || `Team ${id}`
    }));
}

function saveTeams(actor, names) {
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) return 'Enter one team name per line.';
    const cleaned = names.map(name => name.trim()).filter(Boolean);
    if (cleaned.some(name => name.length > maxTeamNameLength || /[\r\n]/.test(name))) return `Keep each team name to ${maxTeamNameLength} characters on one line.`;
    const unique = [...new Map(cleaned.map(name => [name.toLowerCase(), name])).values()];
    if (unique.length > maxTeams) return `Enter up to ${maxTeams} team names.`;
    const previous = getConfiguredTeams(actor);
    // Reuse existing task labels if a removed team is added back to the setup.
    const existing = listTaskTeams(actor.client.taskStorage?.getAllTasks(actor.guild.id) || [], actor);
    const teams = unique.map(name => ({
        id: [...previous, ...existing].find(team => team.name.toLowerCase() === name.toLowerCase())?.id || randomUUID(), name
    }));
    const config = { ...getCachedServerConfig(actor.client, actor.guild.id), teams };
    delete config.teamRoleIds;
    if (!saveServerConfig(actor.guild.id, config)) return 'Failed to save teams. Your previous setup is unchanged.';
    actor.client.serverConfigs[actor.guild.id] = config;
    return null;
}

function getTaskTeam(task, actor = null) {
    if (Object.hasOwn(task, 'teamId')) {
        if (!task.teamId) return null;
        return { id: task.teamId, name: getConfiguredTeams(actor).find(team => team.id === task.teamId)?.name || task.teamName || 'Team' };
    }
    const roleId = Object.hasOwn(task, 'teamRoleId') ? task.teamRoleId : task.assignedToRole;
    if (!roleId) return null;
    const id = `legacy-${roleId}`;
    return { id, name: getConfiguredTeams(actor).find(team => team.id === id)?.name || task.teamName || actor?.guild.roles.cache.get(roleId)?.name || `Team ${roleId}` };
}

function listTaskTeams(tasks, actor) {
    const teams = new Map(getConfiguredTeams(actor).map(team => [team.id, team]));
    for (const task of tasks) {
        const team = getTaskTeam(task, actor);
        if (team && !teams.has(team.id)) teams.set(team.id, team);
    }
    return [...teams.values()];
}

function validateTeam(actor, teamId) {
    if (!teamId) return null;
    if (!getConfiguredTeams(actor).some(team => team.id === teamId)) return 'This team is no longer set up. Open the task again and choose a configured team.';
    return null;
}

function setTaskTeam(task, team) {
    task.teamId = team?.id || null;
    task.teamName = team?.name || null;
    delete task.teamRoleId;
}

function preserveTaskTeam(task, actor) {
    setTaskTeam(task, getTaskTeam(task, actor));
}

module.exports = { getConfiguredTeams, saveTeams, validateTeam, getTaskTeam, listTaskTeams, setTaskTeam, preserveTaskTeam, maxTeams, maxTeamNameLength };
