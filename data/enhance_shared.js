import { defineCapability } from './capability.js';
import { reactFiberForElement } from './capability/fingerprints/fiber.js';

/**
 * Shared runtime helpers for incipit webview modules.
 *
 * This file is deliberately small and side-effect-light. `enhance.js` imports
 * it on the critical path, while lazy modules reuse the same config, asset
 * resolver, DOM freeze, and app-var helpers.
 */

export const CFG = (() => {
  const raw = (typeof globalThis !== 'undefined' && globalThis.__incipitConfig) || {};
  const f = (raw && typeof raw.features === 'object') ? raw.features : {};
  const t = (raw && typeof raw.theme === 'object') ? raw.theme : {};
  const palette = ['warm-black', 'ink-black', 'warm-white'].includes(t.palette)
    ? t.palette
    : 'warm-black';
  const language = raw.language === 'zh' ? 'zh' : 'en';
  const bodyBold = (palette === 'warm-white' && t.bodyBold === true);
  return Object.freeze({
    math: f.math !== false,
    sessionUsage: f.sessionUsage !== false,
    language,
    palette,
    bodyBold,
  });
})();

export const DEBUG = (() => {
  try { return localStorage.getItem('claudeEnhanceDebug') === '1'; } catch { return false; }
})();

export const log  = (...a) => console.log('[Claude Enhance]', ...a);
export const warn = (...a) => console.warn('[Claude Enhance]', ...a);
export const dbg  = (...a) => { if (DEBUG) console.log('[Claude Enhance:dbg]', ...a); };

function sanitizeHealthDetail(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  const type = typeof value;
  if (type === 'string') return value.length > 240 ? value.slice(0, 240) + '...' : value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'function') return '[function]';
  if (type !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= 2) return '[object]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 12).map(item => sanitizeHealthDetail(item, depth + 1, seen));
  }
  const out = {};
  for (const key of Object.keys(value).slice(0, 16)) {
    out[key] = sanitizeHealthDetail(value[key], depth + 1, seen);
  }
  return out;
}

function createHealthRegistry() {
  const entries = new Map();
  const history = [];
  const MAX_HISTORY = 80;

  function set(name, status = 'ok', detail = null) {
    const key = String(name || 'unknown');
    const entry = Object.freeze({
      status: String(status || 'ok'),
      detail: sanitizeHealthDetail(detail),
      updatedAt: new Date().toISOString(),
    });
    entries.set(key, entry);
    history.push({ name: key, ...entry });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    if (DEBUG) dbg('health', key, entry.status, entry.detail);
    return entry;
  }

  function snapshot() {
    const out = {};
    for (const [key, entry] of entries) out[key] = { ...entry };
    return out;
  }

  function events() {
    return history.map(entry => ({ ...entry }));
  }

  return Object.freeze({
    set,
    get(name) {
      const entry = entries.get(String(name || 'unknown'));
      return entry ? { ...entry } : null;
    },
    snapshot,
    events,
  });
}

export const health = (() => {
  const existing = globalThis.__incipitHealth;
  if (existing && typeof existing.set === 'function' && typeof existing.snapshot === 'function') {
    return existing;
  }
  const registry = createHealthRegistry();
  try {
    Object.defineProperty(globalThis, '__incipitHealth', {
      value: registry,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (_) {
    globalThis.__incipitHealth = registry;
  }
  return registry;
})();

export function reportHealth(name, status = 'ok', detail = null) {
  try { return health.set(name, status, detail); }
  catch (_) { return null; }
}

export const BASE_URL = (() => {
  try {
    return new URL('./', import.meta.url);
  } catch {
    const s = document.currentScript;
    if (s && s.src) return new URL('./', s.src);
    return new URL('./', location.href);
  }
})();

export const assetURL = (rel) => new URL(rel, BASE_URL).href;

let cachedClaudeConnection = null;
let lastClaudeConnectionMissAt = 0;

function normalizeSessionId(value) {
  if (typeof value !== 'string' || !value) return null;
  return /^[A-Za-z0-9-]+$/.test(value) ? value : null;
}

function isClaudeConnectionLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const a = obj.activeSessionId;
  if (!a || typeof a !== 'object' || !('value' in a)) return false;
  const s = obj.sessionStates;
  if (!s || typeof s !== 'object' || !('value' in s)) return false;
  return true;
}

function findClaudeConnectionInValue(value, depth, seen) {
  if (!value || typeof value !== 'object' || depth < 0) return null;
  if (isClaudeConnectionLike(value)) return value;
  if (value.nodeType || value.window === value) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const preferred = ['comms', 'connection', 'value', 'current', 'context'];
  for (const key of preferred) {
    const v = value[key];
    if (!v || typeof v !== 'object') continue;
    const hit = findClaudeConnectionInValue(v, depth - 1, seen);
    if (hit) return hit;
  }
  let scanned = 0;
  for (const key of Object.keys(value)) {
    if (preferred.includes(key)) continue;
    if (++scanned > 25) break;
    const v = value[key];
    if (!v || typeof v !== 'object') continue;
    const hit = findClaudeConnectionInValue(v, depth - 1, seen);
    if (hit) return hit;
  }
  return null;
}

const connectionCap = defineCapability({
  name: 'runtime.fiber.connection',
  layer: 'fiber',
  presence: 'always',
  shapeValidate: isClaudeConnectionLike,
  staleAfterMs: 800,
  probe() {
    if (cachedClaudeConnection && isClaudeConnectionLike(cachedClaudeConnection)) {
      return { ok: true, value: cachedClaudeConnection, reason: 'ok', detail: { source: 'cache' } };
    }
    const now = Date.now();
    if (lastClaudeConnectionMissAt && now - lastClaudeConnectionMissAt < 800) {
      return { ok: false, value: null, reason: 'shapeMiss', detail: { via: 'missCooldown' } };
    }
    const anchors = [
      document.querySelector('[class*="root_"]'),
      document.querySelector('[class*="messagesContainer_"]'),
      document.querySelector('[class*="userMessage_"]'),
      document.querySelector('[class*="inputContainer_"]'),
      document.body && document.body.firstElementChild,
      document.body,
    ];
    let sawAnchor = false;
    let sawFiber = false;
    for (const anchor of anchors) {
      if (!anchor) continue;
      sawAnchor = true;
      let f = reactFiberForElement(anchor);
      if (f) sawFiber = true;
      for (let i = 0; i < 120 && f; i++) {
        let conn = findClaudeConnectionInValue(f.memoizedProps, 6, new WeakSet());
        if (!conn) conn = findClaudeConnectionInValue(f.stateNode, 6, new WeakSet());
        if (!conn) conn = findClaudeConnectionInValue(f.memoizedState, 6, new WeakSet());
        if (conn) {
          cachedClaudeConnection = conn;
          return { ok: true, value: conn, reason: 'ok', detail: { source: 'fiber' } };
        }
        f = f.return;
      }
    }
    lastClaudeConnectionMissAt = now;
    return {
      ok: false,
      value: null,
      reason: sawAnchor ? (sawFiber ? 'shapeMiss' : 'noFiber') : 'notMounted',
    };
  },
});

export function locateClaudeConnection() {
  const result = connectionCap.read();
  return result.ok ? result.value : null;
}

function getVsCodeApi() {
  try {
    if (typeof globalThis.__incipitGetVsCodeApi === 'function') {
      return globalThis.__incipitGetVsCodeApi();
    }
    if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
  } catch (_) {}
  return null;
}

function getVsCodeStateSessionId(options = {}) {
  const api = getVsCodeApi();
  if (!api || typeof api.getState !== 'function') return null;
  let state = null;
  try { state = api.getState(); } catch (_) { return null; }
  if (!state || typeof state !== 'object') return null;
  const id = normalizeSessionId(state.sessionID) || normalizeSessionId(state.sessionId);
  if (!id) return null;
  if (!options.allowStaleState &&
      Number.isFinite(state.sessionUpdatedAt) &&
      Date.now() - state.sessionUpdatedAt > 10 * 60 * 1000) {
    return null;
  }
  return id;
}

export function getActiveClaudeSessionId(options = {}) {
  if (options.skipFiber !== true) {
    const conn = locateClaudeConnection();
    if (conn) {
      try {
        const v = normalizeSessionId(conn.activeSessionId.value);
        if (v) return v;
      } catch (_) {}
    }
  }
  return getVsCodeStateSessionId(options);
}

export function pageNonce() {
  const el = document.querySelector('script[nonce]');
  return el ? (el.nonce || el.getAttribute('nonce') || '') : '';
}

export function loadCSS(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error('CSS load failed: ' + href));
    document.head.appendChild(link);
  });
}

export function loadJS(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const nonce = pageNonce();
    if (nonce) { s.nonce = nonce; s.setAttribute('nonce', nonce); }
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('JS load failed: ' + src));
    document.head.appendChild(s);
  });
}

export function ensureDomFreeze() {
  const key = '__incipitDomFreeze';
  const existing = globalThis[key];
  if (existing &&
      existing.nativeSet &&
      existing.nativeRemove &&
      existing.nativeToggle) {
    return existing;
  }

  const nativeSet = Element.prototype.setAttribute;
  const nativeRemove = Element.prototype.removeAttribute;
  const nativeToggle = Element.prototype.toggleAttribute;
  let nativeOpenGet = null;
  let nativeOpenSet = null;

  Element.prototype.setAttribute = function(name, value) {
    if (name === 'open' && this.__claudeFrozen) return;
    return nativeSet.call(this, name, value);
  };
  Element.prototype.removeAttribute = function(name) {
    if (name === 'open' && this.__claudeFrozen) return;
    return nativeRemove.call(this, name);
  };
  Element.prototype.toggleAttribute = function(name, force) {
    if (name === 'open' && this.__claudeFrozen) return this.hasAttribute('open');
    return nativeToggle.call(this, name, force);
  };

  if (typeof HTMLDetailsElement !== 'undefined') {
    const desc = Object.getOwnPropertyDescriptor(HTMLDetailsElement.prototype, 'open');
    if (desc && desc.set) {
      nativeOpenGet = desc.get || null;
      nativeOpenSet = desc.set;
      Object.defineProperty(HTMLDetailsElement.prototype, 'open', {
        configurable: true,
        get: desc.get,
        set: function(value) {
          if (this.__claudeFrozen) return;
          nativeOpenSet.call(this, value);
        },
      });
    }
  }

  const freeze = Object.freeze({
    nativeSet,
    nativeRemove,
    nativeToggle,
    nativeOpenGet,
    nativeOpenSet,
  });
  try {
    Object.defineProperty(globalThis, key, {
      value: freeze,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (_) {
    globalThis[key] = freeze;
  }
  return freeze;
}

const SOFT_PALETTE = Object.freeze({
  'warm-black': Object.freeze({ background: '#1f1f1e', foreground: '#f8f8f6', secondary: '#bcbcb9' }),
  'ink-black': Object.freeze({ background: '#0a0b0b', foreground: '#fbfbfc', secondary: '#aaaaab' }),
  'warm-white': Object.freeze({ background: '#f8f8f6', foreground: '#0d0d0d', secondary: '#797569' }),
});
const SOFT_BG = SOFT_PALETTE[CFG.palette].background;
const SOFT_FG = SOFT_PALETTE[CFG.palette].foreground;
const SOFT_FG_2 = SOFT_PALETTE[CFG.palette].secondary;

export const APP_VAR_OVERRIDES = {
  '--app-background': SOFT_BG,
  '--app-primary-background': SOFT_BG,
  '--app-root-background': SOFT_BG,
  '--app-secondary-background': SOFT_BG,
  '--app-tool-background': SOFT_BG,
  '--app-header-background': SOFT_BG,
  '--app-input-background': SOFT_BG,
  '--app-input-secondary-background': SOFT_BG,
  '--app-menu-background': SOFT_BG,
  '--app-primary-foreground': SOFT_FG,
  '--app-input-foreground': SOFT_FG,
  '--app-input-secondary-foreground': SOFT_FG,
  '--app-menu-foreground': SOFT_FG,
  '--app-secondary-foreground': SOFT_FG_2,
  '--app-secondary-text': SOFT_FG_2,
  '--app-monospace-font-family': 'var(--incipit-code-font)',
};

let appVarApplyScheduled = false;
let appVarSelfWriting = false;

export function applyAppVarOverrides() {
  appVarSelfWriting = true;
  try {
    writeAppVarsTo(document.documentElement);
    if (document.body) writeAppVarsTo(document.body);
  } finally {
    appVarSelfWriting = false;
  }
}

function writeAppVarsTo(el) {
  if (!el || !el.style) return;
  const style = el.style;
  for (const [k, v] of Object.entries(APP_VAR_OVERRIDES)) {
    if (style.getPropertyValue(k) === v && style.getPropertyPriority(k) === 'important') continue;
    style.setProperty(k, v, 'important');
  }
}

function scheduleApplyAppVarOverrides() {
  if (appVarApplyScheduled) return;
  appVarApplyScheduled = true;
  requestAnimationFrame(() => {
    appVarApplyScheduled = false;
    applyAppVarOverrides();
  });
}

export function setupAppVarObserver() {
  if (globalThis.__incipitAppVarObserverInstalled) return;
  const observer = new MutationObserver(() => {
    if (appVarSelfWriting) return;
    scheduleApplyAppVarOverrides();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  globalThis.__incipitAppVarObserverInstalled = true;
  globalThis.__incipitAppVarObserver = observer;
}

export function applyBodyBoldFlag() {
  const root = document.documentElement;
  if (!root) return;
  if (CFG.bodyBold) root.setAttribute('data-incipit-body-bold', '');
  else root.removeAttribute('data-incipit-body-bold');
}

export function injectStyles() {
  function ensureStylesheet(id, fileName) {
    const href = assetURL(fileName);
    let link = document.getElementById(id);
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      document.head.appendChild(link);
    }
    if (link.rel !== 'stylesheet') link.rel = 'stylesheet';
    if (link.href !== href) link.href = href;
    return link;
  }
  ensureStylesheet('claude-enhance-styles-link', 'theme.css');
  ensureStylesheet('incipit-conversation-outline-link', 'conversation_outline.css');
  ensureStylesheet('incipit-task-indicator-link', 'task_indicator.css');
  const overrides = [
    ['warm-white', 'incipit-warm-white-link', 'warm-white-override.css'],
    ['ink-black', 'incipit-ink-black-link', 'ink-black-override.css'],
  ];
  for (const [palette, id, fileName] of overrides) {
    const existing = document.getElementById(id);
    if (CFG.palette !== palette) {
      if (existing) existing.remove();
      continue;
    }
    ensureStylesheet(id, fileName);
  }
}

export function whenDOMReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}
