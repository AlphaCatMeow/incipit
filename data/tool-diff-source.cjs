'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 20000;
const MAX_SESSIONS = 4;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const NO_NEWLINE = '\\ No newline at end of file';
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

function sourceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function canonicalPath(value, cwd) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return '';
  const absolute = path.resolve(cwd, value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function readBytes(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, Math.min(CHUNK_BYTES, length - offset), start + offset);
    if (!result.bytesRead) throw sourceError('history-changed', 'Session history changed while it was being read.');
    offset += result.bytesRead;
  }
  return buffer;
}

async function guardAt(handle, size) {
  const length = Math.min(size, 4096);
  const head = await readBytes(handle, 0, length);
  const tail = await readBytes(handle, size - length, length);
  return { size, head: hash(head), tail: hash(tail) };
}

function sameGuard(a, b) {
  return a.size === b.size && a.head === b.head && a.tail === b.tail;
}

function parseLine(bytes) {
  try {
    const entry = JSON.parse(bytes.toString('utf8'));
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  } catch (_) {
    return null;
  }
}

function identities(entry, span) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  const results = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
      results.push({ id: block.id, role: 'assistant', ...span, uuid: entry.uuid || null });
    }
    if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      results.push({ id: block.tool_use_id, role: 'result', ...span, uuid: entry.uuid || null,
        assistantUuid: entry.sourceToolAssistantUUID || null });
    }
  }
  return results;
}

/** Validate a native hunk without interpreting code lines as patch headers. */
function validateHunks(value) {
  if (!Array.isArray(value)) return null;
  const hunks = [];
  let added = 0;
  let removed = 0;
  let oldEnd = 0, newEnd = 0;
  for (const hunk of value) {
    if (!hunk || !['oldStart', 'oldLines', 'newStart', 'newLines'].every(key =>
      Number.isSafeInteger(hunk[key]) && hunk[key] >= 0) || !Array.isArray(hunk.lines)) {
      throw sourceError('invalid-patch', 'The saved patch has invalid line ranges.');
    }
    let oldCount = 0;
    let newCount = 0;
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      if (typeof line !== 'string') throw sourceError('invalid-patch', 'The saved patch contains an invalid line.');
      if (line === NO_NEWLINE) {
        if (!i || hunk.lines[i - 1] === NO_NEWLINE) throw sourceError('invalid-patch', 'Invalid end-of-file marker.');
        continue;
      }
      if (![' ', '+', '-'].includes(line[0])) throw sourceError('invalid-patch', 'The saved patch has an unknown line marker.');
      if (line[0] !== '+') oldCount++;
      if (line[0] !== '-') newCount++;
      if (line[0] === '+') added++;
      if (line[0] === '-') removed++;
    }
    if (oldCount !== hunk.oldLines || newCount !== hunk.newLines ||
        (oldCount > 0 && hunk.oldStart < 1) || (newCount > 0 && hunk.newStart < 1)) {
      throw sourceError('invalid-patch', 'Saved patch line counts do not match its contents.');
    }
    if (hunks.length && (hunk.oldStart < oldEnd || hunk.newStart < newEnd)) {
      throw sourceError('invalid-patch', 'Saved patch hunks overlap or are out of order.');
    }
    oldEnd = hunk.oldStart + oldCount; newEnd = hunk.newStart + newCount;
    hunks.push({ oldStart: hunk.oldStart, oldLines: oldCount, newStart: hunk.newStart,
      newLines: newCount, lines: hunk.lines.slice() });
  }
  return { hunks, stats: { added, removed } };
}

function replaceOnce(before, oldText, newText, replaceAll) {
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
  if (!oldText) return before === '' ? newText : null;
  const first = before.indexOf(oldText);
  if (first < 0) return null;
  if (replaceAll) return before.split(oldText).join(newText);
  if (before.indexOf(oldText, first + oldText.length) !== -1) return null;
  return before.slice(0, first) + newText + before.slice(first + oldText.length);
}

function verifiedSnapshot(result, tool) {
  if (!tool) return null;
  const created = tool.name === 'Write' && result.type === 'create' && result.originalFile === null;
  const before = typeof result.originalFile === 'string' ? result.originalFile : (created ? '' : null);
  if (before === null) return null;
  const input = tool.input || {};
  if (tool.name === 'Write') {
    if (typeof input.content === 'string' && typeof result.content === 'string' && input.content !== result.content) return null;
    const after = typeof input.content === 'string' ? input.content :
      (typeof result.content === 'string' ? result.content : null);
    return after === null ? null : { oldText: before, newText: after };
  }
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  let after = before;
  for (const edit of edits) {
    const oldText = typeof edit.old_string === 'string' ? edit.old_string : result.oldString;
    const newText = typeof edit.new_string === 'string' ? edit.new_string : result.newString;
    after = replaceOnce(after, oldText, newText, input.replace_all === true || edit.replace_all === true || result.replaceAll === true);
    if (after === null) return null;
  }
  return { oldText: before, newText: after };
}

/**
 * Read the historical result of a file tool using a project-bound JSONL.
 * Long-lived indices contain byte offsets and IDs only. Payloads are cached
 * separately with a byte limit and never persisted outside official history.
 */
function createToolDiffSource({ resolveTargetFromIdentity } = {}) {
  if (typeof resolveTargetFromIdentity !== 'function') throw new TypeError('resolveTargetFromIdentity is required');
  const sessions = new Map();
  let generation = 0;

  function release(item) {
    item.epoch++;
    item.controller.abort();
    item.records.clear();
    item.cache.clear();
    item.cacheBytes = 0;
    item.partial = Buffer.alloc(0);
  }

  function dispose() {
    generation++;
    for (const item of sessions.values()) release(item);
    sessions.clear();
  }

  function disposeSession(sessionId) {
    for (const [key, item] of sessions) if (item.sessionId === sessionId) {
      release(item);
      sessions.delete(key);
    }
  }

  function getSession(sessionId, cwd, target) {
    const key = sessionId + '\0' + canonicalPath(cwd, cwd);
    let item = sessions.get(key);
    if (item && item.target !== target) { release(item); sessions.delete(key); item = null; }
    if (!item) {
      item = { key, target, sessionId, cwd, epoch: 0, size: 0, lineStart: 0, partial: Buffer.alloc(0),
        stat: null, guard: null, records: new Map(), cache: new Map(), cacheBytes: 0,
        queue: Promise.resolve(), corrupt: false, controller: new AbortController() };
    }
    sessions.delete(key);
    sessions.set(key, item);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      release(sessions.get(oldest));
      sessions.delete(oldest);
    }
    return item;
  }

  function putIndex(item, record) {
    let group = item.records.get(record.id);
    if (!group) group = { assistant: [], result: [] };
    if (!group[record.role].some(existing => existing.start === record.start)) group[record.role].push(record);
    item.records.delete(record.id);
    item.records.set(record.id, group);
    while (item.records.size > MAX_INDEX_ENTRIES) item.records.delete(item.records.keys().next().value);
  }

  function resetIndex(item) {
    item.records.clear(); item.cache.clear(); item.cacheBytes = 0;
    item.size = 0; item.lineStart = 0; item.partial = Buffer.alloc(0); item.stat = null;
    item.guard = null; item.corrupt = false;
  }

  function checkCurrent(item, epoch, runGeneration) {
    if (generation !== runGeneration || item.epoch !== epoch || sessions.get(item.key) !== item) {
      throw sourceError('stale-request', 'The session changed before the historical diff was ready.');
    }
  }

  async function scan(item, handle, stat, requestedId, epoch, runGeneration, fromBeginning = false) {
    let position = fromBeginning ? 0 : item.size;
    let lineStart = fromBeginning ? 0 : item.lineStart;
    let carry = fromBeginning ? Buffer.alloc(0) : item.partial;
    const found = { assistant: [], result: [] };
    while (position < stat.size) {
      checkCurrent(item, epoch, runGeneration);
      const bytes = await readBytes(handle, position, Math.min(CHUNK_BYTES, stat.size - position));
      position += bytes.length;
      const data = carry.length ? Buffer.concat([carry, bytes]) : bytes;
      let begin = 0;
      let newline;
      while ((newline = data.indexOf(10, begin)) !== -1) {
        const length = newline - begin;
        if (length > MAX_RECORD_BYTES) throw sourceError('record-too-large', 'A session history record is too large to inspect safely.');
        const line = data.subarray(begin, newline);
        if (line.includes('"tool_use"') || line.includes('"tool_result"')) {
          const entry = parseLine(line);
          if (!entry) item.corrupt = true;
          for (const record of identities(entry, { start: lineStart, end: lineStart + length })) {
            if (!fromBeginning) putIndex(item, record);
            if (record.id === requestedId) found[record.role].push(record);
          }
        }
        lineStart += length + 1;
        begin = newline + 1;
      }
      carry = Buffer.from(data.subarray(begin));
      if (carry.length > MAX_RECORD_BYTES) throw sourceError('record-too-large', 'A session history record exceeds the inspection limit.');
      await new Promise(resolve => setImmediate(resolve));
    }
    // A complete final JSON value is readable without a newline, but remains
    // provisional so a later delimiter cannot index the same result twice.
    if (carry.length) {
      for (const record of identities(parseLine(carry), { start: lineStart, end: stat.size })) {
        if (record.id === requestedId) found[record.role].push(record);
      }
    }
    if (!fromBeginning) {
      item.size = stat.size; item.lineStart = lineStart; item.partial = carry;
    }
    return found;
  }

  function mergeRecords(indexed, extra) {
    const result = { assistant: [], result: [] };
    for (const role of ['assistant', 'result']) {
      for (const record of [...(indexed ? indexed[role] : []), ...extra[role]]) {
        if (!result[role].some(existing => existing.start === record.start)) result[role].push(record);
      }
    }
    return result;
  }

  async function loadEntry(handle, span) {
    const raw = await readBytes(handle, span.start, span.end - span.start);
    const entry = parseLine(raw);
    if (!entry) throw sourceError('history-changed', 'The indexed tool record is no longer readable.');
    return { entry, raw };
  }

  function cachePayload(item, key, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > MAX_CACHE_BYTES) return;
    const previous = item.cache.get(key);
    if (previous) item.cacheBytes -= previous.bytes;
    item.cache.delete(key); item.cache.set(key, { payload, bytes }); item.cacheBytes += bytes;
    while (item.cacheBytes > MAX_CACHE_BYTES && item.cache.size) {
      const oldest = item.cache.keys().next().value;
      item.cacheBytes -= item.cache.get(oldest).bytes; item.cache.delete(oldest);
    }
  }

  async function readPayload(item, handle, group, message) {
    const base = { sessionId: item.sessionId, toolUseId: message.toolUseId, filePath: message.filePath,
      schemaVersion: 1, stats: null };
    if (group.result.length > 1 || group.assistant.length > 1) {
      throw sourceError('ambiguous-tool-id', 'Multiple historical records share this tool identity.');
    }
    if (!group.result.length) return { ...base, ok: true, state: group.assistant.length ? 'pending' : 'unavailable',
      notice: group.assistant.length ? 'The tool result has not been saved yet.' :
        (item.corrupt ? 'Some session records could not be read; this tool result is unavailable.' : 'This tool was not found in the session history.') };
    const saved = await loadEntry(handle, group.result[0]);
    const content = saved.entry.message && saved.entry.message.content;
    const resultBlocks = Array.isArray(content) ? content.filter(block => block && block.type === 'tool_result') : [];
    const resultBlock = resultBlocks.find(block => block.tool_use_id === message.toolUseId);
    if (!resultBlock) throw sourceError('history-changed', 'The saved result no longer matches the requested tool.');
    if (resultBlocks.length !== 1) throw sourceError('ambiguous-result', 'This result cannot be associated with one file change.');
    if (resultBlock.is_error) return { ...base, ok: true, state: 'unavailable', notice: 'The tool failed; no completed file change is available.' };
    let tool = null;
    if (group.assistant.length) {
      const assistant = (await loadEntry(handle, group.assistant[0])).entry;
      const blocks = assistant.message && assistant.message.content;
      tool = Array.isArray(blocks) ? blocks.find(block => block.type === 'tool_use' && block.id === message.toolUseId) : null;
      if (!tool || (saved.entry.sourceToolAssistantUUID && assistant.uuid !== saved.entry.sourceToolAssistantUUID)) {
        throw sourceError('identity-mismatch', 'The historical tool input and result do not match.');
      }
      if (!FILE_TOOLS.has(tool.name)) throw sourceError('unsupported-tool', 'This tool does not provide a file diff.');
    }
    const result = saved.entry.toolUseResult;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { ...base, ok: true, state: 'unavailable', notice: 'This host version did not save structured file-change metadata.' };
    }
    const actualPath = result.filePath || (tool && tool.input && tool.input.file_path);
    const actual = canonicalPath(actualPath, item.cwd);
    if (!actual || actual !== canonicalPath(message.filePath, item.cwd) ||
        (tool && tool.input && tool.input.file_path && actual !== canonicalPath(tool.input.file_path, item.cwd))) {
      throw sourceError('file-mismatch', 'The historical tool result belongs to a different file.');
    }
    const revision = hash(saved.raw);
    const cached = item.cache.get(revision);
    if (cached) { item.cache.delete(revision); item.cache.set(revision, cached); return cached.payload; }
    let payload;
    // Creation results use an empty structuredPatch even for nonempty files.
    const patch = result.type === 'create' ? null : validateHunks(result.structuredPatch);
    if (patch) {
      payload = { ...base, ...patch, filePath: path.resolve(item.cwd, actualPath), revision,
        ok: true, state: 'ready', source: 'structured-patch', lineNumbers: 'absolute', notice: '' };
    } else {
      const snapshot = verifiedSnapshot(result, tool);
      if (snapshot) {
        const { buildDiffModel } = await import('./diff/model.js');
        const model = await buildDiffModel({ ...snapshot, source: 'snapshot' }, {
          signal: item.controller.signal,
          budgetMs: 4,
          yieldControl: () => new Promise(resolve => setImmediate(resolve)),
        });
        payload = { ...base, filePath: path.resolve(item.cwd, actualPath), revision, ok: true, state: 'ready',
          source: 'snapshot', lineNumbers: 'absolute', rows: model.rows, stats: model.stats,
          quality: model.quality, notice: model.notice };
      } else {
        payload = { ...base, revision, ok: true, state: 'unavailable',
          notice: 'No verified patch or complete before/after snapshot was saved for this change.' };
      }
    }
    cachePayload(item, revision, payload);
    return payload;
  }

  async function inspect(item, message, runGeneration, epoch) {
    const handle = await fs.promises.open(item.target, 'r');
    try {
      checkCurrent(item, epoch, runGeneration);
      const stat = await handle.stat();
      let reset = !item.stat || !sameFile(stat, item.stat) || stat.size < item.size ||
        (stat.size === item.size && stat.mtimeMs !== item.stat.mtimeMs);
      if (!reset && item.guard && !sameGuard(await guardAt(handle, item.guard.size), item.guard)) reset = true;
      if (reset) resetIndex(item);
      const extra = await scan(item, handle, stat, message.toolUseId, epoch, runGeneration);
      let group = mergeRecords(item.records.get(message.toolUseId), extra);
      if (!group.assistant.length || !group.result.length) {
        // Old identities evicted from the bounded index remain reachable.
        if (item.records.size >= MAX_INDEX_ENTRIES) group = mergeRecords(group,
          await scan(item, handle, stat, message.toolUseId, epoch, runGeneration, true));
      }
      const payload = await readPayload(item, handle, group, message);
      const after = await handle.stat();
      if (!sameFile(stat, after) || after.size < stat.size ||
          (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) {
        resetIndex(item);
        throw sourceError('history-changed', 'Session history changed while the diff was being prepared.');
      }
      checkCurrent(item, epoch, runGeneration);
      item.stat = stat; item.guard = await guardAt(handle, stat.size);
      return payload;
    } finally { await handle.close(); }
  }

  async function request(message = {}) {
    const { sessionId, cwd, toolUseId, filePath } = message;
    const base = { sessionId, toolUseId, filePath, schemaVersion: 1, stats: null };
    try {
      if (![sessionId, cwd, toolUseId, filePath].every(value => typeof value === 'string' && value && !value.includes('\0')) ||
          /[/\\]/.test(sessionId) || sessionId.length > 128 || toolUseId.length > 256 || !path.isAbsolute(cwd)) {
        throw sourceError('invalid-request', 'A valid session, project, tool identity and file path are required.');
      }
      const target = resolveTargetFromIdentity(sessionId, cwd);
      if (!target) throw sourceError('identity-unresolved', 'The session could not be located in this project.');
      const item = getSession(sessionId, cwd, target);
      const epoch = item.epoch;
      const runGeneration = generation;
      const work = item.queue.then(() => inspect(item, message, runGeneration, epoch));
      item.queue = work.then(() => undefined, () => undefined);
      return await work;
    } catch (error) {
      const denied = error.code === 'EACCES' || error.code === 'EPERM';
      return { ...base, ok: false, state: 'error', code: denied ? 'permission-denied' : (error.code || 'source-error'),
        error: denied ? 'Permission was denied while reading the session history.' : error.message };
    }
  }

  function getHealth() {
    let indexEntries = 0;
    let cacheBytes = 0;
    for (const item of sessions.values()) { indexEntries += item.records.size; cacheBytes += item.cacheBytes; }
    return { sessions: sessions.size, indexEntries, cacheBytes, maxSessions: MAX_SESSIONS,
      maxIndexEntries: MAX_INDEX_ENTRIES, maxCacheBytesPerSession: MAX_CACHE_BYTES };
  }

  return { request, dispose, disposeSession, getHealth };
}

module.exports = { createToolDiffSource };
