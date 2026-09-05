import { buildDiffModel, diffAbortError } from './model.js';

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 48;
const MAX_PENDING = 32;
const WORKER_TIMEOUT_MS = 20000;
const WORKER_ENTRY = `
const controllers = new Map();
self.onmessage = async event => {
  const message = event.data || {};
  if (message.cancel) { controllers.get(message.id)?.abort(); return; }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try { self.postMessage({ id: message.id, model: await buildDiffModel(message.payload, { signal: controller.signal }) }); }
  catch (error) { self.postMessage({ id: message.id, error: { name: error.name, message: error.message } }); }
  finally { controllers.delete(message.id); }
};
`;
const cache = new Map();
const entries = new Map();
const queue = [];
const workerRequests = new Map();
let cacheBytes = 0;
let generation = 0;
let active = 0;
let sequence = 0;
let worker = null;
let workerLoading = null;
let workerLoaderController = null;
let workerState = 'uninitialized';
let workerReason = '';
let workerUrl = null;
let computed = 0;
let cacheHits = 0;

function reportMode() {
  globalThis.__incipitHealth?.set?.('diff.compute', workerState === 'disabled' ? 'degraded' : 'ok', {
    mode: workerState === 'ready' ? 'worker' : 'cooperative', reason: workerReason,
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

function transportError(message, code = 'worker-failure') {
  return Object.assign(new Error(message), { transport: true, code });
}

function disableWorker(error, instance = worker) {
  if (instance && worker && instance !== worker) return;
  workerState = 'disabled'; workerReason = error.message;
  if (worker) worker.terminate();
  worker = null;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
  for (const request of [...workerRequests.values()]) request.finish(error);
  reportMode();
}

async function getWorker() {
  if (workerState === 'disabled') return null;
  if (worker) return worker;
  if (workerLoading) return workerLoading;
  if (typeof Worker === 'undefined' || typeof fetch !== 'function') {
    disableWorker(transportError('Workers are unavailable in this runtime.'));
    return null;
  }
  const epoch = generation;
  const controller = new AbortController();
  let timedOut = false;
  const loadTimer = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
  workerLoaderController = controller;
  let loading;
  loading = Promise.resolve().then(async () => {
    try {
      const response = await fetch(new URL('./model.js', import.meta.url), { signal: controller.signal });
      if (!response.ok) throw transportError('The local diff worker could not be loaded.');
      const source = await response.text();
      if (epoch !== generation) throw diffAbortError();
      const url = URL.createObjectURL(new Blob([source, WORKER_ENTRY], { type: 'text/javascript' }));
      let instance;
      try { instance = new Worker(url, { type: 'module', name: 'incipit-diff' }); }
      catch (error) { URL.revokeObjectURL(url); throw error; }
      workerUrl = url; worker = instance; workerState = 'ready'; workerReason = '';
      instance.onmessage = event => {
        const message = event.data || {};
        const request = workerRequests.get(message.id);
        if (!request) return;
        if (message.error) request.finish(Object.assign(new Error(message.error.message), { name: message.error.name || 'Error' }));
        else if (message.model && Array.isArray(message.model.rows)) request.finish(null, message.model);
        else request.finish(transportError('The diff worker returned an invalid response.'));
      };
      instance.onerror = event => {
        event.preventDefault?.();
        disableWorker(transportError(event.message || 'The diff worker stopped unexpectedly.'), instance);
      };
      instance.onmessageerror = () => disableWorker(transportError('A diff worker message could not be decoded.'), instance);
      reportMode();
      return instance;
    } catch (error) {
      if (epoch !== generation || (error.name === 'AbortError' && !timedOut)) return null;
      disableWorker(transportError(timedOut ? 'The local worker load timed out.' : error.message || 'The webview does not allow a diff worker.'));
      return null;
    } finally {
      clearTimeout(loadTimer);
      if (workerLoading === loading) workerLoading = null;
      if (workerLoaderController === controller) workerLoaderController = null;
    }
  });
  workerLoading = loading;
  return loading;
}

function computeInWorker(instance, entry) {
  return new Promise((resolve, reject) => {
    const signal = entry.controller.signal;
    if (signal.aborted) { reject(diffAbortError()); return; }
    const id = ++sequence;
    let finished = false;
    let timer;
    const finish = (error, model) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      workerRequests.delete(id);
      if (error) reject(error); else resolve(model);
    };
    const abort = () => {
      try { instance.postMessage({ id, cancel: true }); } catch (_) {}
      finish(diffAbortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    workerRequests.set(id, { finish });
    timer = setTimeout(() => disableWorker(transportError('Diff computation timed out. Try a smaller view or retry.', 'worker-timeout'), instance), WORKER_TIMEOUT_MS);
    try { instance.postMessage({ id, payload: entry.payload }); }
    catch (error) { finish(transportError(error.message || 'The diff could not be sent to the worker.')); }
  });
}

async function compute(entry) {
  const signal = entry.controller.signal;
  const instance = await getWorker();
  if (signal.aborted || entry.generation !== generation) throw diffAbortError();
  if (instance && instance === worker && workerState === 'ready') {
    try { return await computeInWorker(instance, entry); }
    catch (error) {
      if (signal.aborted || error.name === 'AbortError' || !error.transport || error.code === 'worker-timeout') throw error;
      disableWorker(error, instance);
    }
  }
  return buildDiffModel(entry.payload, { signal, budgetMs: 4 });
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
  const id = String(key) + ':' + await contentKey(payload, signal, epoch);
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
  workerLoaderController?.abort();
  workerLoaderController = null; workerLoading = null;
  for (const entry of [...entries.values()]) { entry.controller.abort(); finishEntry(entry, diffAbortError()); }
  queue.length = 0; cache.clear(); cacheBytes = 0;
  if (worker) worker.terminate();
  worker = null;
  for (const request of [...workerRequests.values()]) request.finish(diffAbortError());
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null; workerState = 'uninitialized'; workerReason = '';
}

export function getDiffModelHealth() {
  return { mode: workerState === 'ready' ? 'worker' : 'cooperative', reason: workerReason, active,
    pending: entries.size, queued: queue.filter(entry => !entry.finished).length,
    cached: cache.size, cacheBytes, maxCacheBytes: MAX_CACHE_BYTES, computed, cacheHits };
}
