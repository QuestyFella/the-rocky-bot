const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { dependencyIds, prerequisites, isBlocked, canViewTask, blockingError, dependencyInput, resolveDependencies } = require('../utils/taskDependencies');

const task = (id, extra = {}) => ({ id, issueKey: `RC-${id}`, title: `Task ${id}`, status: 'todo', completed: false, ...extra });

test('prerequisites resolve keys or stable IDs, ignore case, and deduplicate without changing tasks', () => {
    const tasks = [task('1'), task('2'), task('3')];
    const before = JSON.stringify(tasks);
    assert.deepEqual(resolveDependencies(tasks[0], 'rc-2, RC-3\n2 RC-2', tasks), { ids: ['2', '3'] });
    assert.equal(JSON.stringify(tasks), before);
    for (const input of ['', '   ', 'none', 'CLEAR']) assert.deepEqual(resolveDependencies(tasks[0], input, tasks), { ids: [] });
    assert.deepEqual(dependencyIds({ dependsOn: ['2', '2', 3] }), ['2', '3']);
    assert.deepEqual(dependencyIds({}), []);
});

test('unknown and ambiguous keys, other-server tasks, and self references cannot be saved', () => {
    const tasks = [task('1'), task('2')];
    for (const input of ['RC-999', 'FOREIGN-1']) assert.match(resolveDependencies(tasks[0], input, tasks).error, /this server/);
    assert.match(resolveDependencies(tasks[0], 'RC-1', tasks).error, /itself/);
    assert.match(resolveDependencies(tasks[0], 'RC-2', [...tasks, task('duplicate', { issueKey: 'RC-2' })]).error, /identify/);
});

test('direct and indirect cycles are rejected, including across tags and long chains', () => {
    const tasks = [task('1'), task('2', { title: '[POWER] Battery', dependsOn: ['3'] }), task('3', { title: '[TEST] Cold test', dependsOn: ['1'] })];
    assert.match(resolveDependencies(tasks[0], 'RC-2', tasks).error, /circular/);
    assert.match(resolveDependencies(tasks[2], 'RC-2', tasks).error, /circular/);
    const chain = Array.from({ length: 1000 }, (_, i) => task(String(i), { dependsOn: i < 999 ? [String(i + 1)] : ['0'] }));
    assert.match(resolveDependencies(chain[0], 'RC-1', chain).error, /circular/);
});

test('all prerequisites must be Done before unlocking; completed legacy statuses also count', () => {
    const target = task('1', { dependsOn: ['2', '3'] });
    const one = task('2'), two = task('3');
    const tasks = [target, one, two];
    assert.equal(isBlocked(target, tasks), true);
    one.status = 'done';
    assert.equal(isBlocked(target, tasks), true);
    assert.match(blockingError(target, tasks), /RC-3/);
    assert.ok(!blockingError(target, tasks).includes('RC-2'));
    two.completed = true;
    assert.equal(isBlocked(target, tasks), false);
    assert.equal(blockingError(target, tasks), null);
    assert.equal(dependencyInput(target, tasks), 'RC-2, RC-3');
    assert.equal(prerequisites(target, tasks).length, 2);
});

test('reopening a prerequisite blocks unfinished work again and preserves completed history', () => {
    const prerequisite = task('2', { status: 'done', completed: true });
    const target = task('1', { dependsOn: ['2'], status: 'progress' });
    const tasks = [target, prerequisite];
    assert.equal(isBlocked(target, tasks), false);
    prerequisite.status = 'todo'; prerequisite.completed = false;
    assert.equal(isBlocked(target, tasks), true);
    target.status = 'done'; target.completed = true;
    assert.equal(isBlocked(target, tasks), false);
    assert.deepEqual(resolveDependencies(target, 'RC-2', tasks), { ids: ['2'] }, 'completed tasks can keep their existing prerequisites');
    tasks.push(task('3'));
    assert.match(resolveDependencies(target, 'RC-3', tasks).error, /Reopen/);
});

test('deleted prerequisites stay blocked and cannot resolve to a replacement with the same key', () => {
    const target = task('1', { dependsOn: ['deleted'] });
    const tasks = [target, task('replacement', { issueKey: 'RC-2', status: 'done' })];
    assert.equal(isBlocked(target, tasks), true);
    assert.match(blockingError(target, tasks), /Deleted task deleted/);
    assert.equal(dependencyInput(target, tasks), 'deleted');
    assert.deepEqual(resolveDependencies(target, '', tasks), { ids: [] });
});

test('only server managers can view blocked tasks; public lists hide them for every viewer', () => {
    const tasks = [task('1', { dependsOn: ['2'] }), task('2')];
    const actor = permissions => ({ member: { permissions: new PermissionsBitField(permissions) } });
    assert.equal(canViewTask(tasks[0], tasks, actor([])), false);
    for (const permission of [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator]) {
        const admin = actor([permission]);
        assert.equal(canViewTask(tasks[0], tasks, admin), true);
        assert.equal(canViewTask(tasks[0], tasks, { ...admin, publicList: true }), false);
    }
    assert.equal(canViewTask(tasks[1], tasks, null), true);
});

test('the prerequisite limit accepts twenty unique tasks and rejects twenty-one', () => {
    const tasks = Array.from({ length: 22 }, (_, i) => task(String(i)));
    assert.equal(resolveDependencies(tasks[0], tasks.slice(1, 21).map(t => t.issueKey).join(','), tasks).ids.length, 20);
    assert.match(resolveDependencies(tasks[0], tasks.slice(1).map(t => t.issueKey).join(','), tasks).error, /at most 20/);
});
