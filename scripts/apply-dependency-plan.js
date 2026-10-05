// Run with the bot and deployment watcher stopped so their caches cannot overwrite the batch.
const fs = require('fs');
const path = require('path');
const TaskStorage = require('../taskStorage');
const { dataPath } = require('../utils/dataPaths');
const { prepareDependencyPlan } = require('../utils/dependencyPlan');

function main() {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
        const name = args.shift();
        if (name === '--apply') options.apply = true;
        else if (['--guild', '--plan', '--team'].includes(name) && args.length) options[name.slice(2)] = args.shift();
        else throw new Error('Usage: node scripts/apply-dependency-plan.js --guild ID --plan FILE [--team NAME] [--apply]');
    }
    if (!/^\d+$/.test(options.guild || '') || !options.plan) throw new Error('Supply --guild ID and --plan FILE. Omit --apply to preview.');
    const storage = new TaskStorage();
    const filename = storage.getFilePath(options.guild);
    const raw = fs.readFileSync(filename, 'utf8');
    const result = prepareDependencyPlan(JSON.parse(raw), JSON.parse(fs.readFileSync(options.plan, 'utf8')), options.team);
    console.log(JSON.stringify({ matched: result.mapping.length, changed: result.changed, hardGatedTasks: result.mapping.filter(row => row.hardGates.length).length, mapping: result.mapping }, null, 2));
    if (!options.apply || !result.changed) return;
    if (raw !== fs.readFileSync(filename, 'utf8')) throw new Error('Tasks changed during preparation. No tasks were changed; preview again.');
    const backupDir = dataPath('.deploy', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `dependencies-${options.guild}-${Date.now()}.json`);
    fs.writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 });
    if (!storage.saveTasks(options.guild, result.tasks)) throw new Error('Failed to save the dependency plan. The original task file remains in place.');
    console.log(JSON.stringify({ applied: result.changed, backup }));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
