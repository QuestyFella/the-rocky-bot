const { createHash } = require('crypto');

function normalizeTagName(value) {
    const name = String(value).trim().replace(/\s+/g, ' ').toUpperCase();
    return !name || name === 'GENERAL' ? 'General' : name;
}

function getTaskTag(task) {
    const title = String(task.title || 'Untitled task');
    const match = title.match(/^\s*\[([^\[\]\r\n]{1,50})\]\s*/);
    const normalized = match?.[1].trim().replace(/\s+/g, ' ').toUpperCase();
    const name = normalizeTagName(normalized || '');
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

// Each category gets its own emoji and colour so its card is easy to spot on the board.
const knownStyles = {
    POWER: { emoji: '⚡', color: 0xf9a825 },
    FIRMWARE: { emoji: '💾', color: 0x1e88e5 },
    RADIO: { emoji: '📡', color: 0x8e24aa },
    MECHANICAL: { emoji: '🔩', color: 0x6d4c41 },
    TEST: { emoji: '🧪', color: 0x00897b },
    DECISION: { emoji: '🧭', color: 0xd81b60 },
    LEGAL: { emoji: '📜', color: 0x5e35b1 },
    'FLIGHT DAY': { emoji: '🎈', color: 0xe53935 },
    General: { emoji: '📌', color: 0x757575 }
};
const otherColors = [0x43a047, 0xf4511e, 0x3949ab, 0xc0ca33, 0x00acc1, 0x8d6e63, 0xec407a];

function getTagStyle(name) {
    if (knownStyles[name]) return knownStyles[name];
    const hash = parseInt(createHash('sha256').update(name).digest('hex').slice(0, 8), 16);
    return { emoji: '📁', color: otherColors[hash % otherColors.length] };
}

module.exports = { normalizeTagName, getTaskTag, groupTasksByTag, getTagStyle };
