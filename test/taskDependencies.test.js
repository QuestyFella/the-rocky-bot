const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { dependencyIds, dependencyTags, prerequisites, prerequisiteLine, isBlocked, canViewTask, blockingError, dependencyInput, resolveDependencies, validateDependencyGraph } = require('../utils/taskDependencies');

const task = (id, extra = {}) => ({ id, issueKey: `RC-${id}`, title: `Task ${id}`, status: 'todo', completed: false, ...extra });

test('prerequisites resolve keys or stable IDs, ignore case, and deduplicate without changing tasks', () => {
    const tasks = [task('1'), task('2'), task('3')];
    const before = JSON.stringify(tasks);
    assert.deepEqual(resolveDependencies(tasks[0], 'rc-2, RC-3\n2 RC-2', tasks), { ids: ['2', '3'], tags: [] });
    assert.equal(JSON.stringify(tasks), before);
    for (const input of ['', '   ', 'none', 'CLEAR']) assert.deepEqual(resolveDependencies(tasks[0], input, tasks), { ids: [], tags: [] });
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
    assert.deepEqual(resolveDependencies(target, 'RC-2', tasks), { ids: ['2'], tags: [] }, 'completed tasks can keep their existing prerequisites');
    tasks.push(task('3'));
    assert.match(resolveDependencies(target, 'RC-3', tasks).error, /Reopen/);
});

test('deleted prerequisites stay blocked and cannot resolve to a replacement with the same key', () => {
    const target = task('1', { dependsOn: ['deleted'] });
    const tasks = [target, task('replacement', { issueKey: 'RC-2', status: 'done' })];
    assert.equal(isBlocked(target, tasks), true);
    assert.match(blockingError(target, tasks), /Deleted task deleted/);
    assert.equal(dependencyInput(target, tasks), 'deleted');
    assert.deepEqual(resolveDependencies(target, '', tasks), { ids: [], tags: [] });
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

test('task keys and whole tags can be mixed, normalized, and prefilled without expanding tags into fixed IDs', () => {
    const tasks = [task('1', { title: '[TEST] Final test' }), task('2', { title: '[POWER] Battery' }), task('3', { title: '[GROUND STATION] Radio' })];
    const result = resolveDependencies(tasks[0], 'RC-2, [power], [ground   station], [POWER]', tasks);
    assert.deepEqual(result, { ids: ['2'], tags: ['POWER', 'GROUND STATION'] });
    const target = { ...tasks[0], dependsOn: result.ids, dependsOnTags: result.tags };
    assert.equal(dependencyInput(target, tasks), 'RC-2, [POWER], [GROUND STATION]');
    assert.deepEqual(dependencyTags({ dependsOnTags: ['power', 'POWER', ' ground   station '] }), ['POWER', 'GROUND STATION']);
    assert.equal(dependencyIds(target).length, 1);
});

test('every current task in a tag must be done, including tasks added later or reopened', () => {
    const target = task('1', { title: '[TEST] Test', dependsOnTags: ['POWER'] });
    const one = task('2', { title: '[POWER] One', status: 'done' }), two = task('3', { title: '[POWER] Two' });
    const tasks = [target, one, two];
    assert.equal(isBlocked(target, tasks), true);
    assert.match(blockingError(target, tasks), /\[POWER\] \(1\/2 Done\)/);
    assert.match(prerequisiteLine(prerequisites(target, tasks)[0]), /1\/2 Done/);
    two.status = 'done';
    assert.equal(isBlocked(target, tasks), false);
    const later = task('4', { title: '[power] Added later' });
    tasks.push(later);
    assert.equal(isBlocked(target, tasks), true);
    later.status = 'done';
    assert.equal(isBlocked(target, tasks), false);
    one.status = 'todo';
    assert.equal(isBlocked(target, tasks), true);
    target.status = 'done';
    assert.equal(isBlocked(target, tasks), false, 'completed dependent tasks keep their history');
});

test('tag membership follows title changes and missing tags stay blocked until repopulated or removed', () => {
    const target = task('1', { title: '[TEST] Test', dependsOnTags: ['POWER'] });
    const member = task('2', { title: '[POWER] Battery', status: 'done' });
    const tasks = [target, member];
    assert.equal(isBlocked(target, tasks), false);
    member.title = '[STM32] Software';
    assert.equal(isBlocked(target, tasks), true);
    assert.match(prerequisiteLine(prerequisites(target, tasks)[0]), /No tasks found/);
    assert.equal(dependencyInput(target, tasks), '[POWER]');
    tasks.push(task('3', { title: '[POWER] New member', status: 'done' }));
    assert.equal(isBlocked(target, tasks), false);
    tasks.pop();
    assert.equal(isBlocked(target, tasks), true);
    target.dependsOnTags = [];
    assert.equal(isBlocked(target, tasks), false);
});

test('self tags, mixed task-tag cycles, and cycles across two tags are rejected', () => {
    const tasks = [task('1', { title: '[TEST] Test' }), task('2', { title: '[POWER] Power', dependsOn: ['1'] })];
    assert.match(resolveDependencies(tasks[0], '[TEST]', tasks).error, /own tag/);
    assert.match(resolveDependencies(tasks[0], '[POWER]', tasks).error, /circular/);
    tasks[1].dependsOn = []; tasks[1].dependsOnTags = ['TEST'];
    assert.match(resolveDependencies(tasks[0], '[POWER]', tasks).error, /circular/);
    tasks[1].dependsOnTags = [];
    tasks[0].dependsOnTags = ['POWER'];
    assert.match(validateDependencyGraph({ ...tasks[1], dependsOnTags: ['TEST'] }, tasks), /circular/);
});

test('renaming a task into a prerequisite tag cannot introduce a circular dependency', () => {
    const tasks = [task('1', { title: '[TEST] Test', dependsOnTags: ['POWER'] }), task('2', { title: '[STM32] Software', dependsOn: ['1'] }), task('3', { title: '[POWER] Battery' })];
    assert.equal(validateDependencyGraph(tasks[1], tasks), null);
    assert.match(validateDependencyGraph({ ...tasks[1], title: '[POWER] Now in power' }, tasks), /circular/);
    assert.match(validateDependencyGraph({ ...tasks[0], title: '[POWER] Same tag' }, tasks), /own tag/);
    assert.equal(validateDependencyGraph({ ...tasks[1], title: '[POWER] No dependency', dependsOn: [] }, tasks), null);
});

test('malformed and unknown tags are rejected while tags with spaces or commas and General work', () => {
    const tasks = [task('1', { title: '[TEST] Target' }), task('2', { title: 'Untagged' }), task('3', { title: '[A,B] Work' })];
    for (const input of ['[]', '[ ]', '[POWER', 'POWER]', '[a[b]]', '[' + 'x'.repeat(101) + ']', 'RC-2[TEST]']) assert.match(resolveDependencies(tasks[0], input, tasks).error, /brackets/);
    assert.match(resolveDependencies(tasks[0], '[UNKNOWN]', tasks).error, /find tag/);
    assert.deepEqual(resolveDependencies(tasks[0], '[general], [a,b]', tasks), { ids: [], tags: ['General', 'A,B'] });
});

test('canonical tag names that expand in uppercase can be saved and parsed again', () => {
    const name = 'ß'.repeat(50);
    const tasks = [task('1', { title: '[TEST] Target' }), task('2', { title: `[${name}] Work` })];
    const result = resolveDependencies(tasks[0], `[${name}]`, tasks);
    assert.deepEqual(result.tags, ['SS'.repeat(50)]);
    const target = { ...tasks[0], dependsOnTags: result.tags };
    assert.deepEqual(resolveDependencies(target, dependencyInput(target, tasks), tasks), result);
});

test('twenty tags can each contain many tasks and the combined task-tag limit is enforced', () => {
    const tasks = [task('target', { title: '[FINAL] Final' }), ...Array.from({ length: 100 }, (_, i) => task(String(i), { title: `[GROUP ${i % 20}] Task ${i}` }))];
    const input = Array.from({ length: 20 }, (_, i) => `[GROUP ${i}]`).join(', ');
    assert.equal(resolveDependencies(tasks[0], input, tasks).tags.length, 20);
    assert.match(resolveDependencies(tasks[0], input + ', RC-0', tasks).error, /at most 20/);
});
