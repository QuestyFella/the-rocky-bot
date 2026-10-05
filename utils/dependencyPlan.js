const { dependencyIds, dependencyTags, hardDependencyIds, hardDependencyTags, maxDependencies, validateDependencyGraph } = require('./taskDependencies');
const { getIssueKey } = require('./kanban');

const titleKey = title => String(title).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const details = task => JSON.stringify([dependencyIds(task), dependencyTags(task), hardDependencyIds(task), hardDependencyTags(task)]);

function prepareDependencyPlan(tasks, rows, team) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 250) throw new Error('Provide a JSON array of 1–250 tasks.');
    const byNumber = new Map(), matched = new Set();
    for (const row of rows) {
        if (!Number.isInteger(row.id) || row.id < 1 || byNumber.has(row.id) || typeof row.title !== 'string' || !row.title.trim()) throw new Error('Each plan task needs a unique positive id and a title.');
        const matches = tasks.filter(task => titleKey(task.title) === titleKey(row.title) && (!team || titleKey(task.teamName || '') === titleKey(team)));
        if (matches.length !== 1 || matched.has(String(matches[0]?.id))) throw new Error(`Plan #${row.id}: expected one matching task for "${row.title}"${team ? ` in team ${team}` : ''}; found ${matches.length}. No tasks were changed.`);
        byNumber.set(row.id, matches[0]); matched.add(String(matches[0].id));
    }
    const references = (row, field) => {
        const values = row[field] ?? (field === 'hard_by' ? [] : null);
        if (!Array.isArray(values) || values.some(number => !Number.isInteger(number) || !byNumber.has(number) || number === row.id)) throw new Error(`Plan #${row.id}: ${field} must contain other task ids from this plan.`);
        return [...new Set(values)].map(number => String(byNumber.get(number).id));
    };
    const patches = new Map(), mapping = [];
    for (const row of rows) {
        const task = byNumber.get(row.id), soft = references(row, 'blocked_by'), hard = references(row, 'hard_by');
        const ids = [...new Set([...soft, ...hard])];
        if (ids.length > maxDependencies) throw new Error(`Plan #${row.id} exceeds ${maxDependencies} prerequisites.`);
        const updated = { ...task, dependsOn: ids, dependsOnTags: [], hardDependsOn: hard, hardDependsOnTags: [] };
        if (details(updated) !== details(task)) updated.updatedAt = new Date().toISOString();
        patches.set(String(task.id), updated);
        mapping.push({ number: row.id, key: getIssueKey(task) || task.id, title: task.title, waitingOn: ids.map(id => getIssueKey(tasks.find(task => String(task.id) === id)) || id), hardGates: hard.map(id => getIssueKey(tasks.find(task => String(task.id) === id)) || id) });
    }
    const updatedTasks = tasks.map(task => patches.get(String(task.id)) || task);
    for (const task of patches.values()) {
        const error = validateDependencyGraph(task, updatedTasks);
        if (error) throw new Error(`${getIssueKey(task) || task.id}: ${error} No tasks were changed.`);
    }
    return { tasks: updatedTasks, mapping, changed: tasks.filter((task, index) => details(task) !== details(updatedTasks[index])).length };
}

module.exports = { prepareDependencyPlan };
