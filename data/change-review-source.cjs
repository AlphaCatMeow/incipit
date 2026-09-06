'use strict';

const fs = require('fs');
const { createToolDiffSource } = require('./tool-diff-source.cjs');
const MAX_BYTES = 32 * 1024 * 1024;

function check(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Review closed.'), { name: 'AbortError' });
}

async function readText(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('The saved file exceeds the review text limit.');
    const bytes = await handle.readFile();
    if (bytes.includes(0)) throw new Error('The saved file is binary.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

function applyOperation(before, operation) {
  if (typeof before !== 'string' || !operation) return null;
  const input = operation.input || {};
  if (operation.name === 'Write') return typeof input.content === 'string' ? input.content : null;
  let after = before;
  for (const edit of Array.isArray(input.edits) ? input.edits : [input]) {
    if (typeof edit?.old_string !== 'string' || typeof edit.new_string !== 'string') return null;
    const old = edit.old_string, next = edit.new_string;
    if (!old) { if (after !== '') return null; after = next; continue; }
    const start = after.indexOf(old);
    if (start < 0) return null;
    if (input.replace_all === true || edit.replace_all === true) after = after.split(old).join(next);
    else {
      if (after.indexOf(old, start + old.length) !== -1) return null;
      after = after.slice(0, start) + next + after.slice(start + old.length);
    }
  }
  return after;
}

/** Reconstruct one turn from successful tool identities; current disk is never its endpoint. */
function createChangeReviewSource() {
  const targets = new Map();
  const tools = createToolDiffSource({ includeSnapshots: true,
    resolveTargetFromIdentity: (sessionId, cwd) => targets.get(sessionId + '\0' + cwd) });
  let queue = Promise.resolve(), queued = 0, generation = 0;

  async function inspect(request, options, token) {
    const { file, sessionId, cwd, target, backupPath, legacyCurrentText, legacyCurrentPath } = request;
    const signal = options.signal;
    const current = () => { check(signal); if (token !== generation) throw Object.assign(new Error('Review source closed.'), { name: 'AbortError' }); };
    current();
    const { buildDiffModel } = await import('./diff/model.js');
    const modelOptions = { signal, budgetMs: 4, yieldControl: () => new Promise(resolve => setImmediate(resolve)) };
    const identity = sessionId + '\0' + cwd;
    targets.set(identity, target);
    while (targets.size > 8) targets.delete(targets.keys().next().value);
    const ids = Array.from(file.toolIds || []);
    let before = null, after = null, continuous = true, bytes = 0;
    const parts = [];
    if (!ids.length) {
      // Older histories without tool identities can use only a captured, unchanged endpoint.
      if (legacyCurrentText === undefined && !legacyCurrentPath) throw new Error('This older history has no saved tool changes or verified endpoint.');
      before = file.backupFileName === null ? '' : backupPath ? await readText(backupPath) : null;
      if (before === null) throw new Error('No historical baseline was saved for this file.');
      const endpoint = legacyCurrentPath ? await readText(legacyCurrentPath) : legacyCurrentText;
      current();
      return buildDiffModel({ oldText: before, newText: endpoint, filePath: file.filePath,
        source: 'review-snapshot', notice: 'Showing the captured review endpoint verified against the current file.' }, modelOptions);
    }
    for (let i = 0; i < ids.length; i++) {
      current();
      const payload = await tools.request({ sessionId, cwd, toolUseId: ids[i], filePath: file.filePath }, { signal });
      current();
      let snapshot = payload.snapshot;
      if (i === 0 && !snapshot) {
        try { before = file.backupFileName === null ? '' : backupPath ? await readText(backupPath) : null; } catch (_) {}
        after = before;
      }
      if (snapshot) {
        if (i === 0) before = snapshot.oldText;
        else if (after !== snapshot.oldText) continuous = false;
        after = snapshot.newText;
      } else {
        const previous = after;
        after = applyOperation(after, payload.operation);
        if (previous !== null && after !== null) snapshot = { oldText: previous, newText: after };
        else continuous = false;
      }
      let part;
      if (payload.state === 'ready') part = await buildDiffModel(payload, modelOptions);
      else if (snapshot) part = await buildDiffModel({ ...snapshot, filePath: file.filePath }, modelOptions);
      else if (payload.operation) {
        const input = payload.operation.input;
        const edits = (Array.isArray(input.edits) ? input.edits : [input]).map(edit => ({ oldText: edit?.old_string, newText: edit?.new_string }));
        if (edits.every(edit => typeof edit.oldText === 'string' && typeof edit.newText === 'string')) {
          part = await buildDiffModel({ source: 'tool-input', edits, filePath: file.filePath }, modelOptions);
        } else if (typeof input.content === 'string') {
          part = await buildDiffModel({ source: 'tool-input', proposedText: input.content, filePath: file.filePath }, modelOptions);
        }
      }
      if (part) {
        bytes += part.byteSize;
        if (bytes > MAX_BYTES) throw new Error('This review exceeds the inline limit. Open the session history to inspect all operations.');
        parts.push({ index: i + 1, model: part });
      } else parts.push({ index: i + 1, error: payload.error || payload.notice || 'No saved patch.' });
    }
    current();
    if (continuous && before !== null && after !== null) return buildDiffModel({ oldText: before, newText: after,
      filePath: file.filePath, source: 'review-history', notice: '' }, modelOptions);
    const rows = [];
    for (const part of parts) {
      const detail = part.error ? ': ' + part.error : part.model?.source === 'tool-input' ? ' · Known input without saved file context' : '';
      rows.push({ kind: 'gap', text: 'Operation ' + part.index + detail, oldLine: null, newLine: null });
      if (part.model) for (const row of part.model.rows) rows.push(row);
    }
    const model = await buildDiffModel({ rows, filePath: file.filePath, source: 'review-operations',
      notice: 'The saved operations do not form a continuous file snapshot. Each recorded operation is shown separately; counts describe these operations, not the net change.' }, modelOptions);
    return model;
  }

  return {
    request(request, options = {}) {
      if (queued >= 32) return Promise.reject(new Error('Too many reviews are loading. Retry shortly.'));
      queued++;
      const token = generation;
      const work = queue.then(() => inspect(request, options, token));
      queue = work.then(() => undefined, () => undefined);
      return work.finally(() => queued--);
    },
    dispose() { generation++; targets.clear(); tools.dispose(); },
  };
}

module.exports = { createChangeReviewSource };
