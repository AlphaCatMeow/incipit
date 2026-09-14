import { diffAbortError } from './model.js';

const requests = new Map();
const shared = new Map();
const queue = [];
const MAX_ACTIVE = 2;
const TIMEOUT_MS = 15000;
let getApi = null;
let listening = false;
let sequence = 0;
let active = 0;
const instanceId = Math.random().toString(36).slice(2);

/** Use the already captured host API; never acquire a second VS Code API object. */
export function configureDiffSource(apiProvider) {
  getApi = apiProvider;
  if (listening) return;
  listening = true;
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.__incipit !== true || message.type !== 'tool_diff_response') return;
    const entry = requests.get(message.requestId);
    if (!entry) return;
    const payload = message.payload;
    if (!payload || payload.sessionId !== entry.identity.sessionId || payload.toolUseId !== entry.identity.toolUseId) {
      settle(entry, new Error('The historical diff response did not match this tool.'));
      return;
    }
    settle(entry, null, payload);
  });
}

function settle(entry, error, payload) {
  if (entry.finished) return;
  entry.finished = true;
  clearTimeout(entry.timer);
  requests.delete(entry.requestId);
  if (error && entry.started) {
    try { getApi?.()?.postMessage({ __incipit: true, type: 'tool_diff_cancel', requestId: entry.requestId }); } catch (_) {}
  }
  if (shared.get(entry.key) === entry) shared.delete(entry.key);
  if (entry.started) active--;
  for (const waiter of entry.waiters) {
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (error) waiter.reject(error); else waiter.resolve(payload);
  }
  entry.waiters.clear();
  pump();
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    let index = queue.findIndex(entry => !entry.finished && entry.waiters.size && !entry.statsOnly);
    if (index < 0) {
      if (active) return;
      index = 0;
    }
    const entry = queue.splice(index, 1)[0];
    if (entry.finished || !entry.waiters.size) continue;
    try {
      const api = getApi && getApi();
      if (!api || typeof api.postMessage !== 'function') throw new Error('The host connection is unavailable.');
      entry.started = true; active++;
      requests.set(entry.requestId, entry);
      entry.timer = setTimeout(() => settle(entry, new Error('Historical diff lookup timed out. Retry to reload it.')), TIMEOUT_MS);
      api.postMessage({ __incipit: true, type: 'badge_identity_update', sessionId: entry.identity.sessionId,
        cwd: entry.identity.cwd, includeHistory: false, bindOnly: true });
      api.postMessage({ __incipit: true, type: 'tool_diff_request', requestId: entry.requestId, ...entry.identity, statsOnly: entry.statsOnly });
    } catch (error) { settle(entry, error); }
  }
}

/** Coalesce read-only requests while allowing a detached view to release its reader. */
export function fetchToolDiff(identity, { signal, statsOnly = false } = {}) {
  if (signal?.aborted) return Promise.reject(diffAbortError());
  if (!identity.sessionId || !identity.cwd || !identity.toolUseId || !identity.filePath) {
    return Promise.reject(new Error('The session or file identity is not available yet.'));
  }
  const key = JSON.stringify([identity.sessionId, identity.cwd, identity.toolUseId, identity.filePath, statsOnly]);
  let entry = shared.get(key);
  if (!entry) {
    if (shared.size >= (statsOnly ? 30 : 32)) return Promise.reject(new Error('Too many file previews are loading. Retry shortly.'));
    entry = { key, identity, statsOnly, requestId: 'tool-diff-' + instanceId + '-' + (++sequence), waiters: new Set(), started: false,
      finished: false, timer: null };
    shared.set(key, entry); queue.push(entry);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, abort: null };
    waiter.abort = () => {
      if (!entry.waiters.delete(waiter)) return;
      signal?.removeEventListener('abort', waiter.abort);
      reject(diffAbortError());
      if (!entry.waiters.size) settle(entry, diffAbortError());
    };
    entry.waiters.add(waiter);
    signal?.addEventListener('abort', waiter.abort, { once: true });
    if (signal?.aborted) waiter.abort();
    pump();
  });
}

export function clearDiffSource() {
  queue.length = 0;
  for (const entry of [...shared.values()]) settle(entry, diffAbortError());
}
