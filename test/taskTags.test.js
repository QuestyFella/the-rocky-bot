const test = require('node:test');
const assert = require('node:assert/strict');
const { getTaskTag, groupTasksByTag } = require('../utils/taskTags');

test('title tags ignore case and extra spaces, preserve the task title, and use stable IDs', () => {
    const first = getTaskTag({ title: '[GROUND STATION] Log packets' });
    const second = getTaskTag({ title: '  [ground   station]  Check receiver  ' });
    assert.equal(first.name, 'GROUND STATION');
    assert.equal(first.id, second.id);
    assert.equal(second.title, 'Check receiver');
    assert.match(first.id, /^[a-f0-9]{16}$/);
    assert.equal(getTaskTag({ title: '[STM32] [SPI] Read register' }).title, '[SPI] Read register');
});

test('untagged and malformed titles stay in General without losing their text', () => {
    const general = getTaskTag({ title: 'No prefix' });
    for (const title of ['No prefix', 'Title [POWER]', '[] Empty', '[ ] Blank', '[POWER Missing', '[A\nB] Multiline', '[' + 'x'.repeat(51) + '] Too long']) {
        const tag = getTaskTag({ title });
        assert.equal(tag.name, 'General');
        assert.equal(tag.id, general.id);
        assert.equal(tag.title, title);
    }
    assert.equal(getTaskTag({ title: '[GENERAL] Check list' }).id, general.id);
    assert.equal(getTaskTag({ title: '[POWER]' }).title, '[POWER]');
    assert.equal(getTaskTag({}).title, 'Untitled task');
});

test('groups are alphabetical with General last and never change stored tasks', () => {
    const tasks = [{ title: '[POWER] A' }, { title: 'No tag' }, { title: '[decision] B' }, { title: '[power] C' }];
    const before = JSON.stringify(tasks);
    const groups = groupTasksByTag(tasks);
    assert.deepEqual(groups.map(group => group.name), ['DECISION', 'POWER', 'General']);
    assert.deepEqual(groups[1].tasks, [tasks[0], tasks[3]]);
    assert.equal(JSON.stringify(tasks), before);
});
