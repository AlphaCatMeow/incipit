const STORE_VERSION = 1;
const DEFAULT_STORAGE_KEY = 'incipit.conversationOutline.bookmarks.v1';

function readonlySet(source) {
  let view = null;
  view = Object.freeze({
    get size() { return source.size; },
    has(value) { return source.has(value); },
    entries() { return source.entries(); },
    keys() { return source.keys(); },
    values() { return source.values(); },
    forEach(callback, thisArg) {
      source.forEach(value => callback.call(thisArg, value, value, view));
    },
    [Symbol.iterator]() { return source[Symbol.iterator](); },
  });
  return view;
}

const EMPTY_BOOKMARKS = readonlySet(new Set());

function cleanId(value) {
  return typeof value === 'string' && value ? value : null;
}

function parseState(raw) {
  if (!raw) return { conversations: new Map(), recency: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORE_VERSION || !parsed.conversations ||
        typeof parsed.conversations !== 'object') {
      return { conversations: new Map(), recency: [] };
    }

    const conversations = new Map();
    for (const [conversationId, values] of Object.entries(parsed.conversations)) {
      const id = cleanId(conversationId);
      if (!id || !Array.isArray(values)) continue;
      const messageIds = new Set(values.map(cleanId).filter(Boolean));
      if (messageIds.size) conversations.set(id, messageIds);
    }
    const recency = Array.isArray(parsed.recency)
      ? parsed.recency.map(cleanId).filter(id => id && conversations.has(id))
      : [];
    for (const id of conversations.keys()) if (!recency.includes(id)) recency.push(id);
    return { conversations, recency };
  } catch (_) {
    return { conversations: new Map(), recency: [] };
  }
}

export function createOutlineBookmarkStore(options = {}) {
  const storage = options.storage || null;
  const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
  const maxConversations = Math.max(1, Math.floor(Number(options.maxConversations) || 200));
  const listeners = new Set();
  let raw = null;
  try { raw = storage && storage.getItem(storageKey); } catch (_) {}
  const state = parseState(raw);
  const snapshots = new Map();

  function evictOverflow() {
    while (state.recency.length > maxConversations) {
      const evicted = state.recency.shift();
      if (evicted) {
        state.conversations.delete(evicted);
        snapshots.delete(evicted);
      }
    }
  }

  function serialize() {
    const conversations = {};
    for (const id of state.recency) {
      const values = state.conversations.get(id);
      if (values && values.size) conversations[id] = Array.from(values);
    }
    return JSON.stringify({ version: STORE_VERSION, conversations, recency: state.recency.slice() });
  }

  function persist() {
    try {
      if (storage && typeof storage.setItem === 'function') storage.setItem(storageKey, serialize());
    } catch (_) {}
  }

  function notify() {
    for (const listener of Array.from(listeners)) {
      try { listener(); } catch (_) {}
    }
  }

  const beforePruneSize = state.recency.length;
  evictOverflow();
  if (state.recency.length !== beforePruneSize) persist();

  function get(conversationId) {
    const id = cleanId(conversationId);
    if (!id) return EMPTY_BOOKMARKS;
    const values = state.conversations.get(id);
    if (!values) return EMPTY_BOOKMARKS;
    let snapshot = snapshots.get(id);
    if (!snapshot) {
      snapshot = readonlySet(values);
      snapshots.set(id, snapshot);
    }
    return snapshot;
  }

  function toggle(conversationId, messageId) {
    const id = cleanId(conversationId);
    const message = cleanId(messageId);
    if (!id || !message) return false;

    const next = new Set(state.conversations.get(id) || EMPTY_BOOKMARKS);
    const pinned = !next.has(message);
    if (pinned) next.add(message);
    else next.delete(message);

    const oldRecencyIndex = state.recency.indexOf(id);
    if (oldRecencyIndex >= 0) state.recency.splice(oldRecencyIndex, 1);
    if (next.size) {
      state.conversations.set(id, next);
      snapshots.set(id, readonlySet(next));
      state.recency.push(id);
    } else {
      state.conversations.delete(id);
      snapshots.delete(id);
    }

    evictOverflow();
    persist();
    notify();
    return pinned;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return Object.freeze({ get, subscribe, toggle });
}
