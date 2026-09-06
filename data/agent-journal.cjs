'use strict';

const fs = require('fs');
const crypto = require('crypto');

const CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 50000;
const MAX_FILES = 6;

function historyError(code, message) { return Object.assign(new Error(message), { code }); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function readBytes(handle, start, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, Math.min(CHUNK_BYTES, length - offset), start + offset);
    if (!result.bytesRead) throw historyError('history-changed', 'The agent transcript changed while it was being read. Refresh to try again.');
    offset += result.bytesRead;
  }
  return bytes;
}

async function guard(handle, size) {
  const length = Math.min(size, 2048);
  return { head: digest(await readBytes(handle, 0, length)), tail: digest(await readBytes(handle, size - length, length)) };
}

function blocks(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
}

/** Index offsets and identities only; message bodies are read for the requested page. */
function createAgentJournal() {
  const files = new Map();
  const pending = new Map();
  let epoch = 0;

  function add(index, entry, span) {
    if (!entry || typeof entry !== 'object') return;
    if (index.rows.length >= MAX_ENTRIES) throw historyError('history-too-large', 'This agent transcript exceeds the inline history limit. Open the original transcript to read it in full.');
    const content = blocks(entry);
    const isMessage = entry.type === 'assistant' || entry.type === 'user';
    const key = typeof entry.uuid === 'string' ? entry.uuid : String(span.start);
    if (isMessage) {
      const row = { ...span, key, role: entry.type, line: index.line, timestamp: entry.timestamp || '', display: content.some(block => block?.type !== 'tool_result') };
      index.rows.push(row); index.latest.set(key, row);
      if (typeof entry.cwd === 'string') index.cwd = entry.cwd;
    }
    for (const block of content) {
      if (entry.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') index.tools.set(block.id, { ...span, line: index.line });
      if (entry.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') index.results.set(block.tool_use_id, { ...span, line: index.line });
      if (entry.type === 'user' && block?.type === 'text' && typeof block.text === 'string' && block.text.includes('<task-notification>')) {
        const id = /<task-id>([^<]+)<\/task-id>/.exec(block.text)?.[1];
        const status = /<status>([^<]+)<\/status>/.exec(block.text)?.[1];
        if (id && status) index.notifications.set(id, { status, ...span });
      }
    }
  }

  async function update(file) {
    const token = epoch;
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw historyError('invalid-history', 'The agent transcript is not a regular file.');
      let index = files.get(file);
      if (index && stat.ino === index.ino && stat.dev === index.dev && stat.size === index.size && stat.mtimeMs === index.mtimeMs) return index;
      if (index) {
        const previousGuard = stat.size >= index.size ? await guard(handle, index.size) : null;
        if (stat.ino !== index.ino || stat.dev !== index.dev || !previousGuard || previousGuard.head !== index.guard.head || previousGuard.tail !== index.guard.tail || stat.size === index.size) index = null;
      }
      if (!index) index = { rows: [], latest: new Map(), tools: new Map(), results: new Map(), notifications: new Map(), offset: 0, line: 0, cwd: '', ino: stat.ino, dev: stat.dev };
      let position = index.offset, carry = Buffer.alloc(0), carryStart = position;
      while (position < stat.size) {
        const chunk = await readBytes(handle, position, Math.min(CHUNK_BYTES, stat.size - position));
        position += chunk.length;
        const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        let start = 0, end;
        while ((end = buffer.indexOf(10, start)) !== -1) {
          const length = end - start;
          if (length > MAX_RECORD_BYTES) throw historyError('record-too-large', 'An agent record is too large for the inline viewer. Open the original transcript.');
          index.line++;
          const text = buffer.subarray(start, end).toString('utf8').trim();
          if (text) {
            let entry;
            try { entry = JSON.parse(text); }
            catch (_) { throw historyError('invalid-history', 'The agent transcript contains an unreadable record. Refresh or open the original transcript.'); }
            add(index, entry, { start: carryStart + start, length });
          }
          start = end + 1; index.offset = carryStart + start;
        }
        carry = buffer.subarray(start); carryStart += start;
        if (carry.length > MAX_RECORD_BYTES) throw historyError('record-too-large', 'An agent record is too large for the inline viewer. Open the original transcript.');
      }
      index.partial = carry.length > 0;
      index.size = stat.size; index.mtimeMs = stat.mtimeMs; index.guard = await guard(handle, stat.size);
      index.records = index.rows.filter(row => row.display && index.latest.get(row.key) === row);
      index.revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (token === epoch) {
        files.delete(file); files.set(file, index);
        while (files.size > MAX_FILES) files.delete(files.keys().next().value);
      }
      return index;
    } finally { await handle.close(); }
  }

  async function getIndex(file) {
    if (pending.has(file)) return pending.get(file);
    const promise = update(file).catch(error => { files.delete(file); if (error.code !== 'ENOENT') error.transcriptPath = file; throw error; }).finally(() => pending.delete(file));
    pending.set(file, promise);
    return promise;
  }

  async function read(file, span) {
    if (!span) return null;
    const handle = await fs.promises.open(file, 'r');
    try {
      const bytes = await readBytes(handle, span.start, span.length);
      try { return JSON.parse(bytes.toString('utf8')); }
      catch (_) { files.delete(file); throw historyError('history-changed', 'The transcript changed. Refresh this view to read the current history.'); }
    } finally { await handle.close(); }
  }

  return { getIndex, read, clear() { epoch++; files.clear(); }, get size() { return files.size; } };
}

module.exports = { createAgentJournal, historyError, blocks };
