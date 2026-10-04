const { createHash } = require('crypto');

function getTaskTag(task) {
    const title = String(task.title || 'Untitled task');
    const match = title.match(/^\s*\[([^\[\]\r\n]{1,50})\]\s*/);
    const normalized = match?.[1].trim().replace(/\s+/g, ' ').toUpperCase();
    const name = !normalized || normalized === 'GENERAL' ? 'General' : normalized;
    return {
        id: createHash('sha256').update(name.toUpperCase()).digest('hex').slice(0, 16),
        name,
        title: normalized ? title.slice(match[0].length).trim() || title : title
    };
}

function groupTasksByTag(tasks) {
    const groups = new Map();
    for (const task of tasks) {
        const tag = getTaskTag(task);
        if (!groups.has(tag.id)) groups.set(tag.id, { id: tag.id, name: tag.name, tasks: [] });
        groups.get(tag.id).tasks.push(task);
    }
    return [...groups.values()].sort((a, b) => {
        if (a.name === 'General') return b.name === 'General' ? 0 : 1;
        if (b.name === 'General') return -1;
        return a.name.localeCompare(b.name, 'en');
    });
}

module.exports = { getTaskTag, groupTasksByTag };
