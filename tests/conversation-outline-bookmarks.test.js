'use strict';

const assert = require('assert');

class MemoryStorage {
  constructor(initial = null) {
    this.value = initial;
  }
  getItem() { return this.value; }
  setItem(_key, value) { this.value = value; }
}

(async () => {
  const { createOutlineBookmarkStore } = await import('../data/legacy/conversation_outline_store.js');

  const storage = new MemoryStorage();
  const store = createOutlineBookmarkStore({ storage });
  const emptyA = store.get('conversation-a');
  assert.strictEqual(emptyA, store.get('conversation-a'), 'empty snapshots must be reference-stable');
  assert.strictEqual(emptyA.size, 0);
  assert.strictEqual(emptyA.add, undefined, 'bookmark snapshots must not expose mutators');

  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  assert.strictEqual(store.toggle('conversation-a', 'message-1'), true);
  const pinnedA = store.get('conversation-a');
  assert.ok(pinnedA.has('message-1'));
  assert.strictEqual(pinnedA.delete, undefined, 'non-empty snapshots must remain read-only');
  assert.strictEqual(pinnedA, store.get('conversation-a'), 'unchanged snapshots must keep their reference');
  assert.strictEqual(store.get('conversation-b').size, 0, 'bookmarks must be isolated by conversation');
  assert.strictEqual(notifications, 1);

  assert.strictEqual(store.toggle('conversation-a', 'message-1'), false);
  assert.strictEqual(store.get('conversation-a').size, 0);
  assert.strictEqual(notifications, 2);
  unsubscribe();
  store.toggle('conversation-a', 'message-2');
  assert.strictEqual(notifications, 2, 'unsubscribe must stop notifications');

  const serialized = JSON.parse(storage.value);
  assert.strictEqual(serialized.version, 1);
  assert.deepStrictEqual(serialized.conversations['conversation-a'], ['message-2']);

  const restarted = createOutlineBookmarkStore({ storage });
  assert.ok(restarted.get('conversation-a').has('message-2'), 'bookmarks must survive store recreation');

  const corrupt = createOutlineBookmarkStore({ storage: new MemoryStorage('{broken') });
  assert.strictEqual(corrupt.get('conversation-a').size, 0, 'corrupt JSON must fail closed');
  assert.doesNotThrow(() => corrupt.toggle('conversation-a', 'message-1'));

  const unavailable = createOutlineBookmarkStore({
    storage: {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('quota'); },
    },
  });
  assert.strictEqual(unavailable.toggle('conversation-a', 'message-1'), true);
  assert.ok(unavailable.get('conversation-a').has('message-1'), 'storage failures must retain in-memory state');

  const capacityStorage = new MemoryStorage();
  const capacity = createOutlineBookmarkStore({ storage: capacityStorage, maxConversations: 2 });
  capacity.toggle('oldest', 'm1');
  capacity.toggle('middle', 'm2');
  capacity.toggle('newest', 'm3');
  assert.strictEqual(capacity.get('oldest').size, 0);
  assert.ok(capacity.get('middle').has('m2'));
  assert.ok(capacity.get('newest').has('m3'));
  const capacityRestart = createOutlineBookmarkStore({ storage: capacityStorage, maxConversations: 2 });
  assert.strictEqual(capacityRestart.get('oldest').size, 0, 'memory and persistence must share eviction');
  assert.ok(capacityRestart.get('middle').has('m2'));
  assert.ok(capacityRestart.get('newest').has('m3'));

  console.log('conversation-outline-bookmarks: 23 checks PASSED');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
