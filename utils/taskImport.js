const { randomUUID } = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');
const { parseDueDate } = require('./kanban');

const maxImportTasks = 250;
const maxImportBytes = 256 * 1024;
const previewLifetimeMs = 15 * 60 * 1000;
// Priority and Team lines from older lists are accepted and ignored.
const fieldNames = { title: 'title', description: 'description', 'due date': 'dueDate', priority: null, team: null };

function parseTaskList(input) {
    const errors = [];
    const tasks = [];
    if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maxImportBytes) return { tasks, errors: ['Use a text file of at most 256 KiB.'] };
    if (input.includes('\0')) return { tasks, errors: ['Use a UTF-8 text file.'] };
    let current = null;
    let lastField = null;
    const finish = () => {
        if (!current) return;
        const label = `Task ${tasks.length + 1}`;
        const title = current.title.trim();
        const description = (current.description || '').trim();
        const due = parseDueDate(current.dueDate);
        if (!title || title.length > 200) errors.push(`${label}: title must have 1–200 characters.`);
        if (description.length > 2000) errors.push(`${label}: description exceeds 2,000 characters.`);
        if (!due.ok) errors.push(`${label}: use a real due date in YYYY-MM-DD format.`);
        tasks.push({ title, description, dueDate: due.dueDate || null });
        current = null;
    };
    const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    for (const [index, line] of lines.entries()) {
        const field = line.match(/^\s*(Title|Description|Due date|Priority|Team)\s*:\s?(.*)$/i);
        if (field) {
            const name = fieldNames[field[1].toLowerCase()];
            if (name === 'title') {
                finish();
                current = { title: field[2] };
            } else if (!current) errors.push(`Line ${index + 1}: put Title before ${field[1]}.`);
            else if (name) current[name] = field[2];
            lastField = name;
        } else if (current && lastField === 'description') {
            current.description += `\n${line}`;
        }
        // Anything else (numbering, headings, separators) is ignored.
    }
    finish();
    if (!tasks.length) errors.push('No tasks found. Start each task with a `Title:` line.');
    if (tasks.length > maxImportTasks) errors.push(`Import up to ${maxImportTasks} tasks at a time.`);
    return { tasks, errors };
}

async function readImportInput(text, attachments = [], fetchFile = globalThis.fetch) {
    if (!attachments.length) {
        if (!text?.trim()) throw new Error('Paste your task list after `!task import`, or attach a .txt file.');
        return text;
    }
    if (attachments.length !== 1) throw new Error('Attach one .txt or .md file at a time.');
    const file = attachments[0];
    if (!/\.(txt|md)$/i.test(file.name || '')) throw new Error('Attach a .txt or .md file containing your task list.');
    if (file.size > maxImportBytes) throw new Error('Use a text file of at most 256 KiB.');
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.port || url.username || url.password || !/^\/(?:ephemeral-)?attachments\//.test(url.pathname)) {
        throw new Error('Upload the file directly to Discord.');
    }
    try {
        const response = await fetchFile(url.href, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('Download failed');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > maxImportBytes) throw new Error('File too large');
            chunks.push(Buffer.from(chunk));
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
        throw new Error('Could not read the file. Attach a UTF-8 .txt file of at most 256 KiB and try again.');
    }
}

const titleKey = title => title.trim().replace(/\s+/g, ' ').toLowerCase();

// Titles already on the board, or repeated in the list, are skipped.
function newRows(actor, rows) {
    const seen = new Set(actor.client.taskStorage.getAllTasks(actor.guild.id).map(task => titleKey(task.title || '')));
    return rows.filter(row => !seen.has(titleKey(row.title)) && seen.add(titleKey(row.title)));
}

function prepareImport(actor, text) {
    const { tasks, errors } = parseTaskList(text);
    if (errors.length) return { errors };
    const drafts = actor.client.taskImports ||= new Map();
    for (const [id, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(id);
    const draft = { id: randomUUID(), guildId: actor.guild.id, userId: actor.author.id, board: actor.board || 'main', expiresAt: Date.now() + previewLifetimeMs, rows: tasks };
    drafts.set(draft.id, draft);
    return { draft };
}

function getImportDraft(actor, id) {
    const draft = actor.client.taskImports?.get(id);
    if (!draft || draft.expiresAt <= Date.now()) return { error: 'This import preview expired. Run `!task import` again.' };
    if (draft.userId !== actor.author.id || draft.guildId !== actor.guild.id) return { error: 'Only the person who started this import can confirm it.' };
    return { draft };
}

function commitImport(actor, draft) {
    const board = require('../commands/board');
    const created = newRows(actor, draft.rows).map(row => board.createIssue(actor, row, draft.board));
    const existing = actor.client.taskStorage.getAllTasks(actor.guild.id);
    if (created.length && !actor.client.taskStorage.saveTasks(actor.guild.id, [...existing, ...created])) return { error: 'Failed to save tasks. Nothing was imported.' };
    actor.client.taskImports.delete(draft.id);
    return { created, skipped: draft.rows.length - created.length };
}

function buildImportPreview(actor, draft) {
    const fresh = newRows(actor, draft.rows);
    const list = fresh.slice(0, 15).map(row => `• ${escapeMarkdown(row.title.slice(0, 100))}`).join('\n');
    return {
        content: `**Import preview:** ${fresh.length} new task(s)${draft.rows.length > fresh.length ? `, ${draft.rows.length - fresh.length} duplicate title(s) skipped` : ''}.\n${list}${fresh.length > 15 ? `\n…and ${fresh.length - 15} more.` : ''}`.slice(0, 2000),
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`kanban:importconfirm:${draft.id}`).setLabel('Import').setStyle(ButtonStyle.Success).setDisabled(!fresh.length),
            new ButtonBuilder().setCustomId(`kanban:importcancel:${draft.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        )],
        allowedMentions: { parse: [] }
    };
}

function buildImportErrors(errors) {
    return {
        content: `**Fix the list, then try again.** Nothing was imported.\n${errors.slice(0, 8).map(error => `• ${escapeMarkdown(error).slice(0, 180)}`).join('\n')}${errors.length > 8 ? `\n…and ${errors.length - 8} more.` : ''}`,
        allowedMentions: { parse: [] }
    };
}

module.exports = { parseTaskList, readImportInput, prepareImport, getImportDraft, commitImport, buildImportPreview, buildImportErrors, maxImportTasks };
