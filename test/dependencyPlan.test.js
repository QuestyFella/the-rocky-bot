const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { prepareDependencyPlan } = require('../utils/dependencyPlan');

const fixture = () => ({
    tasks: [
        { id: 'old-test', issueKey: 'RC-1', title: 'Test', description: 'Untouched', teamName: 'Cubesat' },
        { id: 'first-stable-id', issueKey: 'RC-3', title: '[DECISION] Choose hardware', teamName: 'Cubesat', userId: 'member', status: 'done', completed: true },
        { id: 'second-stable-id', issueKey: 'RC-4', title: '[DRIVER] Build driver', description: 'Keep this', teamName: 'Cubesat', priority: 'high', dueDate: '2026-10-14', status: 'progress', createdBy: 'creator', updatedAt: '2026-10-01' },
        { id: 'third-stable-id', issueKey: 'RC-5', title: '[TEST] Rehearse', teamName: 'Cubesat', status: 'todo' }
    ],
    rows: [
        { id: 1, title: '[DECISION] Choose hardware', blocked_by: [] },
        { id: 2, title: '[DRIVER] Build driver', blocked_by: [1] },
        { id: 3, title: '[TEST] Rehearse', blocked_by: [], hard_by: [2] }
    ]
});

test('plans map numbered references by title and team to stable ids, preserving all other task data', () => {
    const { tasks, rows } = fixture(), before = structuredClone(tasks);
    const result = prepareDependencyPlan(tasks, rows, 'Cubesat');
    assert.deepEqual(tasks, before);
    assert.equal(result.changed, 2);assert.equal(result.mapping.length, 3);
    assert.deepEqual(result.tasks[2].dependsOn, ['first-stable-id']);
    assert.deepEqual(result.tasks[3].hardDependsOn, ['second-stable-id']);
    assert.deepEqual(result.mapping[1].waitingOn, ['RC-3']);
    assert.deepEqual(result.mapping[2].hardGates, ['RC-4']);
    assert.deepEqual(result.tasks[0], before[0]);
    for (const [i, task] of result.tasks.entries()) for (const key of Object.keys(before[i]).filter(key => key !== 'updatedAt')) assert.deepEqual(task[key], before[i][key]);
    assert.equal(prepareDependencyPlan(result.tasks, rows, 'Cubesat').changed, 0);
});

test('matching handles Unicode and whitespace while refusing unknown or ambiguous titles and teams', () => {
    const { tasks, rows } = fixture();
    rows[1].title = ' [driver]   Build driver ';
    assert.equal(prepareDependencyPlan(tasks, rows, 'cubesat').mapping[1].key, 'RC-4');
    assert.throws(() => prepareDependencyPlan(tasks, rows, 'Different team'), /expected one matching task/);
    const otherTeam = { ...tasks[2], id: 'other-team', teamName: 'Software' };
    assert.equal(prepareDependencyPlan([...tasks, otherTeam], rows, 'Cubesat').mapping.length, 3);
    assert.throws(() => prepareDependencyPlan([...tasks, { ...tasks[2], id: 'duplicate' }], rows, 'Cubesat'), /found 2/);
    rows[1].title = 'Unknown';assert.throws(() => prepareDependencyPlan(tasks, rows, 'Cubesat'), /found 0/);
});

test('invalid ids, missing references, self links, and dependency cycles refuse the entire plan', () => {
    for (const scenario of ['duplicate', 'bad-id', 'missing', 'self', 'cycle', 'bad-array']) {
        const { tasks, rows } = fixture(), before = JSON.stringify(tasks);
        if (scenario === 'duplicate') rows[1].id = 1;
        if (scenario === 'bad-id') rows[1].id = '2';
        if (scenario === 'missing') rows[1].blocked_by = [999];
        if (scenario === 'self') rows[1].blocked_by = [2];
        if (scenario === 'cycle') rows[0].blocked_by = [3];
        if (scenario === 'bad-array') rows[1].blocked_by = '1';
        assert.throws(() => prepareDependencyPlan(tasks, rows, 'Cubesat'), undefined, scenario);
        assert.equal(JSON.stringify(tasks), before);
    }
});

test('plan checks include untouched tasks and whole-tag relationships in the existing dependency graph', () => {
    const { tasks, rows } = fixture();
    const other = { id: 'other', title: '[DRIVER] Extra', dependsOn: ['third-stable-id'] };
    tasks[3].dependsOnTags = ['DRIVER'];
    // A plan removes replaced tag relationships; no stale edges survive on matched tasks.
    const result = prepareDependencyPlan([...tasks, other], rows, 'Cubesat');
    assert.deepEqual(result.tasks[3].dependsOnTags, []);
    assert.deepEqual(result.tasks[4], other);
    const cycle = { ...other, dependsOn: ['first-stable-id'] };
    rows[0].blocked_by = [3];
    assert.throws(() => prepareDependencyPlan([...tasks, cycle], rows, 'Cubesat'), /circular/);
});

test('CLI previews without writes and applies one complete batch with an exact backup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-plan-'));
    try {
        const { tasks, rows } = fixture();
        fs.mkdirSync(path.join(directory, 'server-tasks'));
        const file = path.join(directory, 'server-tasks', '123.json'), plan = path.join(directory, 'plan.json');
        const raw = JSON.stringify(tasks, null, 2);
        fs.writeFileSync(file, raw);fs.writeFileSync(plan, JSON.stringify(rows));
        const args = [path.join(__dirname, '../scripts/apply-dependency-plan.js'), '--guild', '123', '--plan', plan, '--team', 'Cubesat'];
        const run = more => execFileSync(process.execPath, [...args, ...more], { env: { ...process.env, BOT_DATA_DIR: directory }, encoding: 'utf8' });
        assert.match(run([]), /"matched": 3/);assert.equal(fs.readFileSync(file, 'utf8'), raw);
        assert.equal(fs.existsSync(path.join(directory, '.deploy')), false);
        assert.match(run(['--apply']), /"applied":\s*2/);
        const backupDir = path.join(directory, '.deploy', 'backups'), backup = fs.readdirSync(backupDir);
        assert.equal(backup.length, 1);assert.equal(fs.readFileSync(path.join(backupDir, backup[0]), 'utf8'), raw);
        const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(updated.length, tasks.length);assert.deepEqual(updated[0], tasks[0]);
        assert.deepEqual(updated[3].hardDependsOn, ['second-stable-id']);
        const appliedRaw = fs.readFileSync(file, 'utf8');
        assert.match(run(['--apply']), /"changed": 0/);assert.equal(fs.readFileSync(file, 'utf8'), appliedRaw);
        rows[1].blocked_by = [999];fs.writeFileSync(plan, JSON.stringify(rows));
        assert.throws(() => run(['--apply']), /blocked_by/);assert.equal(fs.readFileSync(file, 'utf8'), appliedRaw);
        assert.equal(fs.readdirSync(backupDir).length, 1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
