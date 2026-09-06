import { getActiveClaudeSessionId, reportHealth } from './enhance_shared.js';
import { createExecutionLifecycle } from './execution_lifecycle.js';

/**
 * incipit runtime kernel.
 *
 * Lean shape after the 2026-05-15 unwind: this module owns the host-state
 * semantic bridge consumer, a small event bus (subscribe/emit), an idle
 * task scheduler, a streaming dirty-root set, and the assistant-turn
 * "settled + quiet window" signal. It does NOT install a body mutation
 * observer; feature modules keep their own filtered observers because
 * centralizing the dispatch turned every added node into a fixed cost.
 *
 * Host state is sourced from `globalThis.__incipitHostState` (written by
 * the install-time `j4(()=>...)` patch), then cross-checked with cheap
 * runtime evidence before terminal events are emitted. The kernel still
 * does not own a fiber walk or a body mutation bus: richer feature-local
 * probes register through `registerBusyProbe()`.
 */

const HOST_STATE_CACHE_MS = 20;
const PERF_HEALTH_FLUSH_MS = 500;
const STREAM_DIRTY_MAX_ROOTS = 80;
const STREAM_SETTLED_QUIET_MS = 360;
const SEND_BUTTON_DOM_CACHE_MS = 32;
const COMPOSITE_BUSY_RECHECK_MS = 160;
const COMPOSITE_BUSY_RECHECK_MAX_MS = 8000;
// How recently the bridge object must have been produced for its busy=false
// to vouch for "idle" when every other probe missed. Producer writes
// `updatedAt` with Date.now() (see install.js buildHostStateBridgePreamble),
// so the comparison must stay in the Date.now() clock domain — never mix
// with performance.now(). Streaming refreshes the bridge many times per
// second (messages signal), so 30s is generous; a bridge frozen past it
// with zero corroborating DOM/fiber evidence is a zombie, not an idle vote.
const BRIDGE_IDLE_TRUST_MS = 30000;
const MARKDOWN_ROOT_SELECTOR = '[data-incipit-markdown-root], [class*="root_"]';

const subscribers = new Map();
const executionLifecycle = createExecutionLifecycle((event, payload) => emit(event, payload));
const dirtyRootsByKind = new Map();
const dirtyCounts = Object.create(null);
const perfCounters = Object.create(null);
const pendingIdleTasks = new Map();
const capabilityStatus = new Map();

let perfFlushTimer = 0;
let initialized = false;
let bridgeListenerBound = false;
let lastHostStateAt = 0;
let lastRuntimeDirtyAt = 0;
let assistantFinalizedTimer = 0;
let assistantFinalizedToken = 0;
let sendButtonDomCachedAt = 0;
let sendButtonDomCachedValue = null;
let compositeBusyRecheckTimer = 0;
let compositeBusyRecheckUntil = 0;
let lastCompositeBusy = null;

const hostState = {
  busy: false,
  pendingInput: false,
  partialTail: false,
  sessionId: null,
  cwd: null,
  messagesVersion: 0,
  source: 'init',
  updatedAt: 0,
  bridgeUpdatedAt: 0,
};

const busyProbes = new Map();

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

function cleanDetail(detail) {
  if (!detail || typeof detail !== 'object') return detail == null ? null : detail;
  const out = {};
  for (const key of Object.keys(detail).slice(0, 12)) {
    const value = detail[key];
    if (value == null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else out[key] = String(value).slice(0, 160);
  }
  return out;
}

export function reportCapability(name, status = 'ok', detail = null) {
  const key = String(name || 'unknown');
  const next = String(status || 'ok') + ':' + JSON.stringify(cleanDetail(detail) || {});
  if (capabilityStatus.get(key) === next) return;
  capabilityStatus.set(key, next);
  reportHealth('capability.' + key, status, detail);
}

export function capabilityStatusOf(name) {
  const raw = capabilityStatus.get(String(name || 'unknown'));
  if (!raw) return null;
  const i = raw.indexOf(':');
  return i >= 0 ? raw.slice(0, i) : raw;
}

function flushPerfHealth() {
  perfFlushTimer = 0;
  reportHealth('perf.runtime', 'ok', { ...perfCounters });
}

export function bumpPerfCounter(name, amount = 1) {
  const key = String(name || 'unknown');
  const n = Number(amount);
  perfCounters[key] = (perfCounters[key] || 0) + (Number.isFinite(n) ? n : 1);
  if (perfFlushTimer) return;
  perfFlushTimer = setTimeout(flushPerfHealth, PERF_HEALTH_FLUSH_MS);
}

export function subscribe(eventName, handler) {
  if (typeof handler !== 'function') return () => {};
  const key = String(eventName || 'unknown');
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(handler);
  return () => { set.delete(handler); };
}

export function emit(eventName, payload = null) {
  const key = String(eventName || 'unknown');
  const set = subscribers.get(key);
  if (set && set.size) {
    for (const handler of Array.from(set)) {
      try { handler(payload); } catch (_) {}
    }
  }
  try {
    window.dispatchEvent(new CustomEvent('incipit:' + key, { detail: payload }));
  } catch (_) {}
}

function requestIdle(fn, timeout) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(fn, { timeout });
  }
  return setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 0 }), 0);
}

export function scheduleIdleTask(key, fn, options = {}) {
  if (typeof fn !== 'function') return false;
  const id = String(key || 'anonymous');
  if (pendingIdleTasks.has(id)) return false;
  const delay = Math.max(0, Number(options.delay) || 0);
  const timeout = Math.max(1, Number(options.timeout) || 800);
  const arm = () => {
    const idleId = requestIdle(deadline => {
      pendingIdleTasks.delete(id);
      try { fn(deadline); } catch (_) {}
    }, timeout);
    pendingIdleTasks.set(id, { kind: 'idle', id: idleId });
  };
  if (delay > 0) {
    const timer = setTimeout(arm, delay);
    pendingIdleTasks.set(id, { kind: 'timeout', id: timer });
  } else {
    arm();
  }
  return true;
}

// Only `closest(markdownRoot)` — earlier revisions tried five `closest()`
// calls per dirty node (markdown/pre/toolUse/userBubble/message). The cost
// of those during streaming dwarfed the cost of just storing the raw node.
function normalizeDirtyRoot(nodeOrRoot) {
  let node = nodeOrRoot || null;
  if (node && node.nodeType !== 1) node = node.parentElement || null;
  if (!node || node.nodeType !== 1) return null;
  if (node.closest) {
    const markdownRoot = node.closest(MARKDOWN_ROOT_SELECTOR);
    if (markdownRoot) return markdownRoot;
  }
  return node;
}

export function markStreamDirty(kind, nodeOrRoot = null) {
  const key = String(kind || 'generic');
  lastRuntimeDirtyAt = nowMs();
  dirtyCounts[key] = (dirtyCounts[key] || 0) + 1;
  bumpPerfCounter('dirty.' + key, 1);
  const root = normalizeDirtyRoot(nodeOrRoot);
  if (!root) return;
  let set = dirtyRootsByKind.get(key);
  if (!set) {
    set = new Set();
    dirtyRootsByKind.set(key, set);
  }
  set.add(root);
  if (set.size > STREAM_DIRTY_MAX_ROOTS) {
    const first = set.values().next().value;
    if (first) set.delete(first);
  }
}

export function takeStreamDirtyRoots(kind) {
  const key = String(kind || 'generic');
  const set = dirtyRootsByKind.get(key);
  if (!set || !set.size) return [];
  dirtyRootsByKind.delete(key);
  const out = [];
  for (const root of set) {
    if (root && root.isConnected !== false) out.push(root);
  }
  return out;
}

export function hasStreamDirty(kind) {
  const key = String(kind || 'generic');
  const set = dirtyRootsByKind.get(key);
  return !!(set && set.size);
}

function normalizeSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value) ? value : null;
}

function bridgeState() {
  const raw = globalThis.__incipitHostState;
  if (!raw || typeof raw !== 'object') {
    if (typeof globalThis.__incipitPublishHostState === 'function') {
      reportCapability('runtime.hostState.semanticBridge', 'pending', { reason: 'waiting-for-session' });
    } else {
      reportCapability('runtime.hostState.semanticBridge', 'degraded', { reason: 'helper-missing' });
    }
    return null;
  }
  reportCapability('runtime.hostState.semanticBridge', 'ok');
  return raw;
}

export function registerBusyProbe(name, probe) {
  const key = String(name || 'anonymous');
  if (typeof probe !== 'function') {
    busyProbes.delete(key);
    return () => {};
  }
  busyProbes.set(key, probe);
  return () => {
    if (busyProbes.get(key) === probe) busyProbes.delete(key);
  };
}

function runBusyProbes() {
  let sawFalse = false;
  let legacyCompositeFalse = false;
  for (const [name, probe] of busyProbes.entries()) {
    try {
      const result = probe();
      if (result === true) return true;
      if (result === false) {
        sawFalse = true;
        if (name === 'legacy.compositeBusy') legacyCompositeFalse = true;
      }
    } catch (_) {}
  }
  return legacyCompositeFalse ? 'legacy-false' : (sawFalse ? false : null);
}

function nodeIsRendered(node) {
  return !!(
    node &&
    (node.offsetWidth || node.offsetHeight ||
      (node.getClientRects && node.getClientRects().length))
  );
}

function readSendButtonDomState() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return null;
  let buttons;
  try {
    buttons = document.querySelectorAll('[data-incipit-send-button], [class*="sendButton"]');
  } catch (_) {
    return null;
  }
  let sawSend = false;
  for (const button of buttons) {
    if (!nodeIsRendered(button)) continue;
    if (button.querySelector?.('[class*="stopIcon"], [data-incipit-stop-icon]')) return 'stop';
    if (button.querySelector?.('[class*="sendIcon"], [data-incipit-send-icon]')) {
      sawSend = true;
      continue;
    }
    const state = button.getAttribute?.('data-incipit-send-state');
    if (state === 'stop') return 'stop';
    if (state === 'send') sawSend = true;
  }
  return sawSend ? 'send' : null;
}

function sendButtonDomState() {
  const now = nowMs();
  if (sendButtonDomCachedAt && now - sendButtonDomCachedAt <= SEND_BUTTON_DOM_CACHE_MS) {
    return sendButtonDomCachedValue;
  }
  sendButtonDomCachedValue = readSendButtonDomState();
  sendButtonDomCachedAt = now;
  return sendButtonDomCachedValue;
}

function compositeBusyState(state = hostState) {
  if (state && state.busy === true) return true;
  if (state && state.pendingInput === true) return true;

  const probeState = runBusyProbes();
  if (probeState === true) return true;
  if (state && state.partialTail === true) return true;
  if (probeState === 'legacy-false') return false;

  const domState = sendButtonDomState();
  if (domState === 'stop') return true;
  if (domState === 'send' && nowMs() - lastRuntimeDirtyAt > 1500) return false;

  if (probeState === false) return false;
  return null;
}

function rawStateLooksIdle(state = hostState) {
  return !!(
    state &&
    state.busy !== true &&
    state.pendingInput !== true &&
    state.partialTail !== true
  );
}

function cancelCompositeBusyRecheck() {
  compositeBusyRecheckUntil = 0;
  if (compositeBusyRecheckTimer) {
    clearTimeout(compositeBusyRecheckTimer);
    compositeBusyRecheckTimer = 0;
  }
}

function scheduleCompositeBusyRecheck(reason = 'composite-recheck') {
  if (!rawStateLooksIdle(hostState)) {
    cancelCompositeBusyRecheck();
    return;
  }
  const now = nowMs();
  if (!compositeBusyRecheckUntil) {
    compositeBusyRecheckUntil = now + COMPOSITE_BUSY_RECHECK_MAX_MS;
  }
  if (now > compositeBusyRecheckUntil) {
    compositeBusyRecheckUntil = 0;
    return;
  }
  if (compositeBusyRecheckTimer) return;
  compositeBusyRecheckTimer = setTimeout(() => {
    compositeBusyRecheckTimer = 0;
    try { refreshHostState(reason); } catch (_) {}
  }, COMPOSITE_BUSY_RECHECK_MS);
}

function maintainCompositeBusyRecheck(compositeBusy, reason) {
  if (compositeBusy && rawStateLooksIdle(hostState)) {
    scheduleCompositeBusyRecheck(reason);
    return;
  }
  cancelCompositeBusyRecheck();
}

function cancelAssistantFinalized() {
  assistantFinalizedToken++;
  if (assistantFinalizedTimer) {
    clearTimeout(assistantFinalizedTimer);
    assistantFinalizedTimer = 0;
  }
}

function scheduleAssistantFinalized(payload) {
  const token = ++assistantFinalizedToken;
  if (assistantFinalizedTimer) clearTimeout(assistantFinalizedTimer);
  const check = () => {
    assistantFinalizedTimer = 0;
    if (token !== assistantFinalizedToken) return;
    if (compositeBusyState(hostState) === true) {
      assistantFinalizedTimer = setTimeout(check, STREAM_SETTLED_QUIET_MS);
      return;
    }
    const quietFor = nowMs() - lastRuntimeDirtyAt;
    if (quietFor < STREAM_SETTLED_QUIET_MS) {
      assistantFinalizedTimer = setTimeout(check, STREAM_SETTLED_QUIET_MS - quietFor);
      return;
    }
    bumpPerfCounter('assistantTurnFinalized', 1);
    emit('assistantTurnFinalized', {
      ...(payload || {}),
      quietFor: Math.round(quietFor),
      source: 'runtime-kernel',
    });
  };
  assistantFinalizedTimer = setTimeout(check, 0);
}

// Bridge-only: when the install-time patch wired `j4(()=>publishHostState)`,
// SessionState signal changes write `globalThis.__incipitHostState` and fire
// `incipit:hostState`. If the patch is missing (degraded), this returns a
// neutral { busy:false } so each consumer can fall back to its own probe;
// we deliberately do NOT add a second fiber walk here.
function computeHostState() {
  const bridge = bridgeState();
  if (bridge) {
    const sessionId =
      normalizeSessionId(bridge.sessionId) ||
      normalizeSessionId(bridge.sessionID) ||
      getActiveClaudeSessionId({ allowStaleState: true, skipFiber: true });
    const messagesVersion = Number.isFinite(bridge.messagesVersion)
      ? bridge.messagesVersion
      : hostState.messagesVersion;
    const cwd = typeof bridge.cwd === 'string' && bridge.cwd
      ? bridge.cwd
      : null;
    return {
      busy: bridge.busy === true,
      pendingInput: bridge.pendingInput === true,
      partialTail: bridge.partialTail === true,
      sessionId,
      cwd,
      messagesVersion,
      source: 'bridge',
      bridgeUpdatedAt: Number(bridge.updatedAt) || 0,
    };
  }
  return {
    busy: false,
    pendingInput: false,
    partialTail: false,
    sessionId: getActiveClaudeSessionId({ allowStaleState: true, skipFiber: true }),
    cwd: null,
    messagesVersion: hostState.messagesVersion,
    source: 'no-bridge',
    bridgeUpdatedAt: 0,
  };
}

export function refreshHostState(reason = 'refresh') {
  const prevBusy = hostState.busy;
  const prevPendingInput = hostState.pendingInput;
  const prevPartialTail = hostState.partialTail;
  const prevSessionId = hostState.sessionId;
  const prevCwd = hostState.cwd;
  const prevMessagesVersion = hostState.messagesVersion;
  const next = computeHostState();
  hostState.busy = next.busy === true;
  hostState.pendingInput = next.pendingInput === true;
  hostState.partialTail = next.partialTail === true;
  hostState.sessionId = next.sessionId || null;
  hostState.cwd = next.cwd || null;
  hostState.messagesVersion = Number.isFinite(next.messagesVersion) ? next.messagesVersion : 0;
  hostState.source = next.source || 'unknown';
  hostState.bridgeUpdatedAt = Number(next.bridgeUpdatedAt) || 0;
  hostState.updatedAt = nowMs();
  lastHostStateAt = hostState.updatedAt;

  const sessionChanged = prevSessionId !== hostState.sessionId || prevCwd !== hostState.cwd;
  const rawBusyChanged =
    prevBusy !== hostState.busy ||
    prevPendingInput !== hostState.pendingInput ||
    prevPartialTail !== hostState.partialTail;
  const prevCompositeBusy = lastCompositeBusy;
  const compositeBusy = compositeBusyState(hostState) === true;
  const compositeChanged = !sessionChanged && (
    prevCompositeBusy !== null
      ? prevCompositeBusy !== compositeBusy
      : (rawBusyChanged && compositeBusy)
  );
  lastCompositeBusy = compositeBusy;

  if (sessionChanged) {
    cancelAssistantFinalized();
    cancelCompositeBusyRecheck();
    emit('sessionChanged', { ...hostState, reason });
  }
  if (prevMessagesVersion !== hostState.messagesVersion ||
      prevPartialTail !== hostState.partialTail) {
    emit('messagesChanged', { ...hostState, reason });
  }
  if (rawBusyChanged || compositeChanged) {
    const payload = {
      ...hostState,
      rawBusy: hostState.busy,
      busy: compositeBusy,
      previousBusy: prevCompositeBusy !== null ? prevCompositeBusy : prevBusy,
      previousRawBusy: prevBusy,
      previousCompositeBusy: prevCompositeBusy,
      reason,
    };
    emit('busyChanged', payload);
    if (compositeChanged) {
      emit(compositeBusy ? 'streamStarted' : 'streamSettled', payload);
      if (compositeBusy) cancelAssistantFinalized();
      else scheduleAssistantFinalized(payload);
    } else if (compositeBusy) {
      cancelAssistantFinalized();
    }
  }
  maintainCompositeBusyRecheck(compositeBusy, reason);
  executionLifecycle.update(hostState, compositeBusyState(hostState));
  return { ...hostState };
}

export function getHostState(options = {}) {
  const now = nowMs();
  if (options.refresh === true || !lastHostStateAt || now - lastHostStateAt > HOST_STATE_CACHE_MS) {
    return refreshHostState(options.reason || 'read');
  }
  return { ...hostState };
}

// Throws when no probe surface can answer, so callers fall back to their
// own probes (fiber walk / DOM send-state). Bridge-less mode does NOT mean
// "not busy" — it means "kernel cannot tell, ask elsewhere". Order matters:
// a composite false carries real evidence (legacy probe false, or a rendered
// send icon plus a quiet window) and never needs the bridge to vouch for it.
// The bare bridge short-circuit only covers "composite unknown", and there a
// stale bridge must NOT pass: a bridge object whose producer effect died
// (host swapped SessionState internals without a webview reload) freezes
// busy=false forever, and with every DOM/fiber probe already missing there
// is nothing left to catch a live stream. Fresh-bridge-or-throw keeps the
// 2026-06-09 "all probes missed must not collapse to idle" guarantee.
export function conversationIsBusy() {
  const state = getHostState();
  const composite = compositeBusyState(state);
  if (composite === true) return true;
  if (composite === false) return false;
  if (state.source === 'bridge' &&
      state.bridgeUpdatedAt > 0 &&
      Date.now() - state.bridgeUpdatedAt <= BRIDGE_IDLE_TRUST_MS) {
    return false;
  }
  throw new Error('host state bridge unavailable');
}

export function initRuntimeKernel() {
  if (initialized) return;
  initialized = true;
  reportCapability('runtime.kernel', 'ok');
  if (!bridgeListenerBound && typeof window !== 'undefined' && window.addEventListener) {
    bridgeListenerBound = true;
    try {
      window.addEventListener('incipit:hostState', () => {
        try { refreshHostState('semantic-bridge'); } catch (_) {}
      });
    } catch (_) {}
  }
  refreshHostState('init');
}
