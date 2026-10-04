const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection, MessageFlags, ModalSubmitFields, ModalSubmitInteraction } = require('discord.js');

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-import-'));
process.env.BOT_DATA_DIR = temporaryDir;
const TaskStorage = require('../taskStorage');
const { parseTaskList, readImportInput, prepareImport, getImportDraft, commitImport, maxImportTasks, maxImportBytes } = require('../utils/taskImport');
const { saveTeams, getConfiguredTeams } = require('../utils/teams');
const { buildImportModal } = require('../utils/boardComponents');
const { buildImportPreview, buildImportErrors } = require('../utils/importComponents');
const { handleBoardInteraction } = require('../utils/boardInteractions');
const importCommand = require('../commands/import');
const { parseMessageCommand } = require('../utils/commandRouter');
test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
let fixtureNumber = 0;

function fixture() {
    const guild = { id: `import-guild-${++fixtureNumber}`, name: 'Rocket Club', roles: { cache: new Collection() } };
    const member = { pending: false, permissions: { has: () => false }, roles: { cache: new Set() } };
    guild.members = { fetch: async () => member };
    const client = { serverConfigs: {}, taskStorage: new TaskStorage(path.join(temporaryDir, guild.id)), pendingVerifications: new Map() };
    const actor = { guild, client, member, author: { id: 'alice' }, channelId: 'channel' };
    const task = { id: 'existing-task', issueKey: 'RC-99', title: 'Existing task', status: 'progress', priority: 'high', userId: 'bob' };
    client.taskStorage.addTask(guild.id, task);
    assert.equal(saveTeams(actor, ['Cubesat', 'Software']), null);
    const replies = [];
    const interaction = {
        customId: 'kanban:import', guildId: guild.id, guild, client, user: actor.author, channelId: actor.channelId,
        inGuild: () => true, isButton: () => true, isStringSelectMenu: () => false, isRoleSelectMenu: () => false, isModalSubmit: () => false,
        message: { flags: { has: flag => flag === MessageFlags.Ephemeral }, edit: async payload => replies.push(['messageEdit', payload]) },
        reply: async payload => replies.push(['reply', payload]), editReply: async payload => replies.push(['editReply', payload]),
        deferReply: async payload => replies.push(['deferReply', payload]), deferUpdate: async () => replies.push(['deferUpdate']),
        showModal: async modal => replies.push(['modal', modal])
    };
    return { guild, client, member, actor, task, interaction, replies };
}

function list(count = 3) {
    return `HAB-1 TASKS (${count})\nFields per task: Title / Description / Priority / Due date / Team\n\n========================================\nSTM32\n========================================\n\n` + Array.from({ length: count }, (_, i) => `${i + 1}.\nTitle: [STM32] Task ${i + 1}\nDescription: ${i === 1 ? '' : 'Keep °C, µT, ±1 g and 3.25 m³.\nA second description line.'}\nPriority: ${i % 2 ? 'high' : 'medium'}\nDue date: 2026-10-12\nTeam: cubesat`).join('\n\n');
}

function submittedFields(modal, text, file = null) {
    const resolved = file ? { attachments: { [file.id]: { id: file.id, filename: file.name, url: file.url, proxy_url: file.url, size: file.size } } } : {};
    const components = modal.toJSON().components.map(label => ({ ...label, component: label.component.type === 4
        ? { ...label.component, value: text } : { ...label.component, values: file ? [file.id] : [] } }));
    return new ModalSubmitFields(components.map(component => ModalSubmitInteraction.transformComponent(component, resolved)));
}

test('the numbered section format parses 71 tasks, empty and multiline descriptions, and Unicode', () => {
    const parsed = parseTaskList('\uFEFF' + list(71).replace(/\n/g, '\r\n'));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.tasks.length, 71);
    assert.equal(parsed.tasks[0].title, '[STM32] Task 1');
    assert.equal(parsed.tasks[0].description, 'Keep °C, µT, ±1 g and 3.25 m³.\nA second description line.');
    assert.equal(parsed.tasks[1].description, '');
    assert.equal(parsed.tasks[70].number, 71);
    assert.equal(parsed.tasks[0].teamName, 'cubesat');
});

test('optional blank fields get safe defaults, and invalid dates, fields, headings, and limits are reported', () => {
    assert.deepEqual(parseTaskList('Title: Small task').tasks[0], { number: 1, title: 'Small task', description: '', priority: 'medium', dueDate: null, teamName: null });
    assert.equal(parseTaskList('Title: Small task\nDue date: none\nTeam: none').tasks[0].teamName, null);
    for (const input of [
        'Title: Test\nDue date: 2026-02-30', 'Title: Test\nDue date: 2026-13-01', 'Title: Test\nPriority: nonsense',
        'Title: Test\nPriority: high\nPriority: low', 'Title: Test\nDeadline: 2026-10-12',
        'Description: Orphan\nTitle: Test', 'TASKS (2)\nTitle: Only one', 'Title: ' + 'x'.repeat(201),
        'Title: Test\nDescription: ' + 'x'.repeat(2001), 'Title: Test\nTeam: ' + 'x'.repeat(51),
        'No tasks here', 'Title: Binary\0', 'x'.repeat(maxImportBytes + 1), list(maxImportTasks + 1)
    ]) assert.ok(parseTaskList(input).errors.length, input.slice(0, 80));
});

test('preview uses case-insensitive configured teams and leaves tasks and keys untouched', () => {
    const f = fixture();
    const taskBytes = fs.readFileSync(f.client.taskStorage.getFilePath(f.guild.id), 'utf8');
    const { draft, errors } = prepareImport(f.actor, list());
    assert.equal(errors, undefined);
    assert.ok(draft.rows.every(row => row.team.id === getConfiguredTeams(f.actor)[0].id));
    assert.equal(fs.readFileSync(f.client.taskStorage.getFilePath(f.guild.id), 'utf8'), taskBytes);
    assert.equal(fs.existsSync(path.join(temporaryDir, 'kanbanBoards.json')), false);
    assert.ok(prepareImport(f.actor, list().replaceAll('Team: cubesat', 'Team: missing')).errors.some(error => error.includes('not configured')));
});

test('confirmation adds all 71 tasks in one storage update, preserving existing tasks and their assignees', () => {
    const f = fixture();
    const { draft } = prepareImport(f.actor, list(71));
    let updates = 0;
    f.client.taskStorage.setUpdateListener(() => { updates++; });
    const result = commitImport(f.actor, draft);
    assert.equal(result.created.length, 71);
    assert.equal(updates, 1);
    const tasks = f.client.taskStorage.getAllTasks(f.guild.id);
    assert.equal(tasks.length, 72);
    assert.deepEqual(tasks[0], f.task);
    assert.equal(new Set(tasks.map(task => task.id)).size, 72);
    assert.equal(new Set(tasks.map(task => task.issueKey)).size, 72);
    assert.ok(tasks.slice(1).every(task => task.teamName === 'Cubesat' && task.userId === null && task.assignedToRole === null && task.createdBy === 'alice' && task.status === 'todo' && !task.completed && task.dueDate === '2026-10-12'));
    assert.equal(f.client.taskImports.has(draft.id), false);
});

test('duplicate imports and tasks added after preview are skipped without overwriting details', () => {
    const f = fixture();
    const source = list(2);
    const first = prepareImport(f.actor, source).draft;
    const result = commitImport(f.actor, first);
    const original = result.created[0];
    f.client.taskStorage.updateTask(f.guild.id, original.id, { ...original, userId: 'bob', description: 'Updated by Bob', status: 'progress' });
    const repeated = prepareImport(f.actor, source).draft;
    assert.ok(repeated.rows.every(row => row.duplicate));
    assert.equal(commitImport(f.actor, repeated).created.length, 0);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id)[1].description, 'Updated by Bob');
    const f2 = fixture();
    const draft = prepareImport(f2.actor, source).draft;
    f2.client.taskStorage.addTask(f2.guild.id, { ...original, teamId: getConfiguredTeams(f2.actor)[0].id });
    assert.equal(commitImport(f2.actor, draft).created.length, 1);
    assert.equal(f2.client.taskStorage.getAllTasks(f2.guild.id).length, 3);
});

test('duplicates within a file are skipped, conflicting details rejected, and different teams stay distinct', () => {
    const f = fixture();
    const source = 'Title: Task\nTeam: Cubesat\n\nTitle: task\nTeam: CUBESAT\n\nTitle: Task\nTeam: Software';
    const { draft } = prepareImport(f.actor, source);
    assert.deepEqual(draft.rows.map(row => row.duplicate), [false, true, false]);
    assert.equal(commitImport(f.actor, draft).created.length, 2);
    assert.ok(prepareImport(f.actor, 'Title: Task\nDescription: One\nTeam: Cubesat\nTitle: Task\nDescription: Two\nTeam: Cubesat').errors.some(error => error.includes('different details')));
});

test('failed batch storage saves no partial tasks and leaves the preview available to retry', () => {
    const f = fixture();
    const { draft } = prepareImport(f.actor, list());
    const originalDir = f.client.taskStorage.tasksDir;
    const originalError = console.error;
    try {
        f.client.taskStorage.tasksDir = '/dev/null/not-a-directory';
        console.error = () => {};
        assert.match(commitImport(f.actor, draft).error, /No tasks/);
    } finally { console.error = originalError; f.client.taskStorage.tasksDir = originalDir; }
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.task]);
    assert.ok(getImportDraft(f.actor, draft.id).draft);
    assert.equal(commitImport(f.actor, draft).created.length, 3);
});

test('a removed team blocks the entire batch and preserves existing tasks', () => {
    const f = fixture();
    const { draft } = prepareImport(f.actor, list());
    saveTeams(f.actor, ['Software']);
    assert.match(commitImport(f.actor, draft).error, /was removed/);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.task]);
});

test('preview actions require the original user, guild, and channel, and expire or invalidate on replacement', () => {
    const f = fixture();
    const { draft } = prepareImport(f.actor, list());
    for (const actor of [{ ...f.actor, author: { id: 'bob' } }, { ...f.actor, guild: { ...f.guild, id: 'other-guild' } }, { ...f.actor, channelId: 'elsewhere' }]) assert.ok(getImportDraft(actor, draft.id).error);
    draft.expiresAt = Date.now() - 1;
    assert.match(getImportDraft(f.actor, draft.id).error, /expired/);
    const old = prepareImport(f.actor, list()).draft;
    prepareImport(f.actor, list(2));
    assert.ok(getImportDraft(f.actor, old.id).error);
});

test('native upload modal resolves files and pasted text; submit creates a preview, confirm saves, and replay is rejected', async () => {
    const f = fixture();
    await handleBoardInteraction(f.interaction);
    const modal = f.replies.at(-1)[1];
    const json = modal.toJSON();
    assert.equal(json.components[1].component.type, 19);
    assert.equal(json.components[1].component.required, false);
    f.interaction.customId = json.custom_id;
    f.interaction.isButton = () => false;
    f.interaction.isModalSubmit = () => true;
    f.interaction.fields = submittedFields(modal, list());
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 1);
    const draft = [...f.client.taskImports.values()][0];
    assert.match(f.replies.at(-1)[1].embeds[0].toJSON().description, /3 new task/);
    assert.ok(f.replies.at(-1)[1].files[0].attachment.toString().includes('Team: Cubesat'));
    f.interaction.isButton = () => true;
    f.interaction.isModalSubmit = () => false;
    f.interaction.customId = `kanban:importconfirm:${draft.id}`;
    await handleBoardInteraction(f.interaction);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 4);
    await handleBoardInteraction(f.interaction);
    assert.match(f.replies.at(-1)[1].content, /already used/);
    const file = { id: '123', name: 'tasks.txt', size: 100, url: 'https://cdn.discordapp.com/ephemeral-attachments/1/123/tasks.txt?ex=123' };
    const fields = submittedFields(buildImportModal(), '', file);
    assert.equal(fields.getUploadedFiles('file').first().name, 'tasks.txt');
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response(list(2));
        f.interaction.customId = 'kanban:importpreview';
        f.interaction.isButton = () => false;
        f.interaction.isModalSubmit = () => true;
        f.interaction.fields = fields;
        await handleBoardInteraction(f.interaction);
        assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 4);
        assert.equal([...f.client.taskImports.values()][0].rows.length, 2);
    } finally { globalThis.fetch = originalFetch; }
});

test('cancel and ownership checks through interactions cannot add tasks', async () => {
    const f = fixture();
    const { draft } = prepareImport(f.actor, list());
    f.interaction.customId = `kanban:importconfirm:${draft.id}`;
    f.interaction.user = { id: 'bob' };
    await handleBoardInteraction(f.interaction);
    assert.match(f.replies.at(-1)[1].content, /Only the person/);
    f.interaction.user = f.actor.author;
    f.interaction.customId = `kanban:importcancel:${draft.id}`;
    await handleBoardInteraction(f.interaction);
    assert.match(f.replies.at(-1)[1].content, /cancelled/);
    assert.deepEqual(f.client.taskStorage.getAllTasks(f.guild.id), [f.task]);
    assert.equal(f.client.taskImports.size, 0);
});

test('two concurrent confirmations save the batch once and clear a public preview after its owner finishes', async () => {
    const f = fixture();
    const { draft } = prepareImport(f.actor, list());
    f.interaction.customId = `kanban:importconfirm:${draft.id}`;
    f.interaction.message.flags.has = () => false;
    await Promise.all([handleBoardInteraction(f.interaction), handleBoardInteraction({ ...f.interaction })]);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 4);
    assert.equal(f.replies.filter(([type]) => type === 'messageEdit').length, 1);
    assert.deepEqual(f.replies.find(([type]) => type === 'messageEdit')[1].components, []);
    assert.ok(f.replies.some(([, payload]) => payload?.content?.includes('already used')));
});

test('import modal submissions obey channel restrictions and verification', async () => {
    const f = fixture();
    f.interaction.customId = 'kanban:importpreview';
    f.interaction.isButton = () => false;
    f.interaction.isModalSubmit = () => true;
    f.interaction.fields = submittedFields(buildImportModal(), list());
    f.client.serverConfigs[f.guild.id].allowedChannelIds = ['elsewhere'];
    await handleBoardInteraction(f.interaction);
    assert.match(f.replies.at(-1)[1].content, /disabled/);
    f.client.serverConfigs[f.guild.id].allowedChannelIds = [];
    f.member.pending = true;
    await handleBoardInteraction(f.interaction);
    assert.match(f.replies.at(-1)[1].content, /verification/);
    assert.equal(f.client.taskImports, undefined);
});

test('file downloads are bounded, reject unsafe sources and invalid UTF-8, and preserve file text', async () => {
    const file = { name: 'tasks.txt', size: 500, url: 'https://cdn.discordapp.com/attachments/1/2/tasks.txt?ex=123' };
    let requests = 0;
    const fetchFile = async (_url, options) => { requests++; assert.equal(options.redirect, 'error'); return new Response(list()); };
    assert.equal(await readImportInput('', [file], fetchFile), list());
    assert.equal(await readImportInput(list(), [], fetchFile), list());
    for (const bad of [{ ...file, url: 'https://10.0.0.11/private' }, { ...file, url: 'https://cdn.discordapp.com:443@evil.com/attachments/1/2' }, { ...file, name: 'tasks.exe' }, { ...file, size: maxImportBytes + 1 }]) await assert.rejects(readImportInput('', [bad], fetchFile));
    assert.equal(requests, 1);
    await assert.rejects(readImportInput('text', [file], fetchFile));
    await assert.rejects(readImportInput('', [], fetchFile));
    await assert.rejects(readImportInput('', [file, file], fetchFile));
    await assert.rejects(readImportInput('', [file], async () => new Response(new Uint8Array([0xff]))), /UTF-8/);
    await assert.rejects(readImportInput('', [file], async () => new Response('x'.repeat(maxImportBytes + 1))), /256 KiB/);
    await assert.rejects(readImportInput('', [file], async () => new Response('', { status: 404 })), /Could not read/);
});

test('all preview pages fit Discord limits, retain full descriptions in the file, and cover every task', () => {
    const f = fixture();
    const { draft } = prepareImport(f.actor, list(71));
    const seen = [];
    for (let page = 0; page < 15; page++) {
        const payload = buildImportPreview(draft, page, page === 0);
        const embed = payload.embeds[0].toJSON();
        seen.push(...embed.fields.map(field => field.name));
        assert.ok(embed.fields.every(field => field.name.length <= 256 && field.value.length <= 1024));
        assert.ok(payload.components[0].toJSON().components.every(component => component.custom_id.length <= 100));
    }
    assert.equal(new Set(seen).size, 71);
    assert.ok(buildImportPreview(draft, 0, true).files[0].attachment.toString().includes('A second description line.'));
    assert.ok(buildImportErrors(Array(20).fill('*'.repeat(200))).content.length <= 2000);
});

test('text import preserves multiline content, shows a preview, and supports a button without input', async () => {
    const f = fixture();
    const replies = [];
    const message = { ...f.actor, channel: { id: f.actor.channelId }, content: '!task import\n' + list(), attachments: new Collection(), reply: async payload => replies.push(payload) };
    assert.equal(parseMessageCommand(message.content).commandName, 'import');
    await importCommand.execute(message);
    assert.equal([...f.client.taskImports.values()][0].rows.length, 3);
    assert.equal(f.client.taskStorage.getAllTasks(f.guild.id).length, 1);
    message.content = '!task import';
    await importCommand.execute(message);
    assert.equal(replies.at(-1).components[0].toJSON().components[0].custom_id, 'kanban:import');
    f.member.pending = true;
    await importCommand.execute(message);
    assert.match(replies.at(-1), /verification/);
});
