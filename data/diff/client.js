import { buildDiffModel, diffAbortError } from './model.js';

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 48;
const MAX_PENDING = 32;
const cache = new Map();
const entries = new Map();
const queue = [];
let cacheBytes = 0;
let generation = 0;
let active = 0;
let computed = 0;
let cacheHits = 0;

function reportMode() {
  globalThis.__incipitHealth?.set?.('diff.compute', 'ok', {
    mode: 'cooperative', reason: 'The host CSP forbids source fetches and blob workers.',
  });
}

function* fingerprintParts(value, depth = 0) {
  if (depth > 24) throw new TypeError('Diff payload is too deeply nested.');
  if (value === null || value === undefined) { yield String(value); return; }
  if (typeof value === 'string') { yield 's' + value.length + ':'; yield value; return; }
  if (typeof value === 'number' || typeof value === 'boolean') { yield typeof value + ':' + String(value) + ';'; return; }
  if (Array.isArray(value)) {
    yield '[' + value.length + ':';
    for (const item of value) yield* fingerprintParts(item, depth + 1);
    yield ']'; return;
  }
  if (typeof value !== 'object') throw new TypeError('Diff payload must contain serializable data.');
  yield '{';
  for (const key of Object.keys(value).sort()) {
    yield* fingerprintParts(key, depth + 1);
    yield* fingerprintParts(value[key], depth + 1);
  }
  yield '}';
}

async function contentKey(payload, signal, epoch) {
  let a = 2166136261, b = 2246822519, length = 0;
  let deadline = performance.now() + 4;
  for (const part of fingerprintParts(payload)) {
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      a = Math.imul(a ^ code, 16777619);
      b = Math.imul(b ^ code, 3266489917);
      length++;
      if ((length & 4095) === 0 && performance.now() >= deadline) {
        if (signal?.aborted || epoch !== generation) throw diffAbortError();
        await new Promise(resolve => setTimeout(resolve, 0));
        deadline = performance.now() + 4;
      }
    }
  }
  if (signal?.aborted || epoch !== generation) throw diffAbortError();
  return (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36) + ':' + length;
}

async function compute(entry) {
  if (entry.controller.signal.aborted || entry.generation !== generation) throw diffAbortError();
  reportMode();
  return buildDiffModel(entry.payload, { signal: entry.controller.signal, budgetMs: 4 });
}

function finishEntry(entry, error, model) {
  if (entry.finished) return;
  entry.finished = true;
  if (entries.get(entry.id) === entry) entries.delete(entry.id);
  if (!error && !entry.controller.signal.aborted && entry.generation === generation && entry.subscribers.size) {
    const bytes = model.byteSize;
    if (Number.isFinite(bytes) && bytes <= MAX_CACHE_BYTES) {
      const previous = cache.get(entry.id);
      if (previous) cacheBytes -= previous.bytes;
      cache.delete(entry.id); cache.set(entry.id, { model, bytes }); cacheBytes += bytes;
      while (cacheBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
        const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
      }
    }
    computed++;
  }
  for (const subscriber of entry.subscribers) {
    subscriber.signal?.removeEventListener('abort', subscriber.abort);
    if (error) subscriber.reject(error); else subscriber.resolve(model);
  }
  entry.subscribers.clear();
}

function pumpQueue() {
  if (active) return;
  let entry;
  while ((entry = queue.shift())) {
    if (entry.finished || entry.controller.signal.aborted || !entry.subscribers.size) continue;
    active++;
    compute(entry).then(model => finishEntry(entry, null, model), error => finishEntry(entry, error))
      .finally(() => { active--; pumpQueue(); });
    break;
  }
}

/** Coalesce readers of the same immutable payload; one reader may cancel independently. */
export async function getDiffModel(payload, { key = '', signal } = {}) {
  const epoch = generation;
  if (signal?.aborted) throw diffAbortError();
  const revision = key && typeof payload.revision === 'string' && /^[a-f0-9]{64}$/.test(payload.revision)
    ? JSON.stringify([payload.schemaVersion, payload.source, payload.sessionId, payload.toolUseId, payload.filePath, payload.revision]) : null;
  const id = String(key) + ':' + (revision || await contentKey(payload, signal, epoch));
  const hit = cache.get(id);
  if (hit) { cache.delete(id); cache.set(id, hit); cacheHits++; return hit.model; }
  let entry = entries.get(id);
  if (!entry || entry.controller.signal.aborted) {
    if (entries.size >= MAX_PENDING) throw new Error('Too many diff requests are queued. Retry after the current view finishes.');
    entry = { id, payload, generation: epoch, controller: new AbortController(), subscribers: new Set(), finished: false };
    entries.set(id, entry); queue.push(entry);
  }
  return new Promise((resolve, reject) => {
    const subscriber = { resolve, reject, signal, abort: null };
    subscriber.abort = () => {
      if (!entry.subscribers.delete(subscriber)) return;
      signal?.removeEventListener('abort', subscriber.abort);
      reject(diffAbortError());
      if (!entry.subscribers.size) {
        entry.controller.abort();
        finishEntry(entry, diffAbortError());
      }
    };
    entry.subscribers.add(subscriber);
    if (signal?.aborted) subscriber.abort();
    else signal?.addEventListener('abort', subscriber.abort, { once: true });
    pumpQueue();
  });
}

/** Release model ownership and in-flight computations at a session boundary. */
export function clearDiffModels() {
  generation++;
  for (const entry of [...entries.values()]) { entry.controller.abort(); finishEntry(entry, diffAbortError()); }
  queue.length = 0; cache.clear(); cacheBytes = 0;
}

export function getDiffModelHealth() {
  return { mode: 'cooperative', reason: 'host-csp', active,
    pending: entries.size, queued: queue.filter(entry => !entry.finished).length,
    cached: cache.size, cacheBytes, maxCacheBytes: MAX_CACHE_BYTES, computed, cacheHits };
}
