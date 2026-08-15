'use strict';

const assert = require('assert');

(async () => {
  const {
    buildOutlineEntries,
    buildOutlinePreview,
    createOutlineJumpController,
    parseOutlineCommandProtocol,
    resolveActiveOutlineKey,
    resolveNearestMarkerKey,
    resolveOwningUserRowKey,
    sampleOutlineEntries,
  } = await import('../data/legacy/conversation_outline_model.js');

  assert.strictEqual(buildOutlinePreview('  alpha\n\t beta  '), 'alpha beta');
  assert.strictEqual(buildOutlinePreview(' \n\t '), '\u2026');
  assert.strictEqual(
    buildOutlinePreview('a'.repeat(23) + '\ud83d\ude80' + 'z'),
    'a'.repeat(23) + '\ud83d\ude80\u2026',
    'preview truncation must count Unicode code points rather than UTF-16 code units',
  );
  assert.strictEqual(parseOutlineCommandProtocol('ordinary prose'), null);
  assert.deepStrictEqual(parseOutlineCommandProtocol(
    '<command-name>compact</command-name><command-args>focus</command-args>',
  ), { kind: 'invocation', preview: '/compact focus' });
  for (const internal of [
    '<local-command-stdout>done</local-command-stdout>',
    '<local-command-stderr>failed</local-command-stderr>',
    '<local-command-caveat>internal</local-command-caveat>',
    '<local-command-caveat>internal</local-command-caveat>\n<local-command-stdout>done</local-command-stdout>',
  ]) {
    assert.deepStrictEqual(parseOutlineCommandProtocol(internal), { kind: 'internal', preview: '' });
  }

  const records = [
    { role: 'system', id: 's', text: 'system' },
    { role: 'user', id: 'u1', text: ' first ' },
    { role: 'assistant', id: 'a1', text: 'answer' },
    { kind: 'user', rowKey: 'u2-row', messageId: 'u2', text: 'second' },
  ];
  assert.deepStrictEqual(buildOutlineEntries(records), [
    { rowKey: 'u1', messageId: 'u1', preview: 'first' },
    { rowKey: 'u2-row', messageId: 'u2', preview: 'second' },
  ]);

  const fallback = buildOutlineEntries([{ role: 'user', text: '' }]);
  assert.deepStrictEqual(fallback, [
    { rowKey: 'user-row-0', messageId: 'user-row-0', preview: '\u2026' },
  ]);

  const entries = Array.from({ length: 41 }, (_, index) => ({
    rowKey: `row-${index}`,
    messageId: `message-${index}`,
    preview: `Prompt ${index}`,
  }));
  const sampled = sampleOutlineEntries(entries, 40, new Set());
  assert.strictEqual(sampled.length, 40, 'capacity + 1 must retain a full marker set');
  assert.strictEqual(sampled[0].rowKey, 'row-0');
  assert.strictEqual(sampled[sampled.length - 1].rowKey, 'row-40');
  assert.strictEqual(new Set(sampled.map(entry => entry.rowKey)).size, sampled.length);

  const evenlySampled = sampleOutlineEntries(entries, 8, new Set());
  const evenlySampledIndexes = evenlySampled.map(entry => Number(entry.rowKey.slice(4)));
  const gaps = evenlySampledIndexes.slice(1).map((index, offset) => index - evenlySampledIndexes[offset]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'ordinary marker sampling must be uniform');

  const pinned = sampleOutlineEntries(entries, 8, new Set(['row-7', 'row-19', 'row-33']));
  for (const key of ['row-0', 'row-7', 'row-19', 'row-33', 'row-40']) {
    assert.ok(pinned.some(entry => entry.rowKey === key), `${key} must be retained`);
  }
  assert.deepStrictEqual(
    pinned.map(entry => Number(entry.rowKey.slice(4))),
    pinned.map(entry => Number(entry.rowKey.slice(4))).slice().sort((a, b) => a - b),
  );

  const nearest = resolveNearestMarkerKey(entries, [entries[0], entries[10], entries[20]], 'row-16');
  assert.strictEqual(nearest, 'row-20');
  assert.strictEqual(resolveNearestMarkerKey(entries, [entries[10], entries[20]], 'row-15'), 'row-10');

  const userRows = [
    { rowKey: 'u0', sourceIndex: 0 },
    { rowKey: 'u4', sourceIndex: 4 },
    { rowKey: 'u9', sourceIndex: 9 },
  ];
  assert.strictEqual(resolveOwningUserRowKey(userRows, 7), 'u4');
  assert.strictEqual(resolveOwningUserRowKey(userRows, 0), 'u0');
  assert.strictEqual(resolveOwningUserRowKey(userRows, -1), null);

  const anchors = [
    { rowKey: 'u0', top: 0 },
    { rowKey: 'u4', top: 300 },
    { rowKey: 'u9', top: 700 },
  ];
  assert.strictEqual(resolveActiveOutlineKey(anchors, {
    scrollTop: 350,
    clientHeight: 300,
    scrollHeight: 1100,
    anchorOffset: 8,
  }, 'u9'), 'u4');
  assert.strictEqual(resolveActiveOutlineKey(anchors, {
    scrollTop: 790,
    clientHeight: 300,
    scrollHeight: 1100,
    bottomThreshold: 24,
  }, 'u9'), 'u9');

  const order = [];
  const frames = [];
  let alignCount = 0;
  const controller = createOutlineJumpController({
    beforeJump: key => order.push(`break:${key}`),
    align: key => {
      order.push(`align:${key}`);
      alignCount++;
      return true;
    },
    requestFrame: callback => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
    maxFrames: 6,
  });
  assert.strictEqual(controller.jump('u4'), true);
  while (frames.length) frames.shift()();
  assert.strictEqual(order[0], 'break:u4', 'bottom follow must be broken before lookup/alignment');
  assert.strictEqual(alignCount, 6, 'jump correction must be finite');

  const cancellableFrames = [];
  let cancelledAlignments = 0;
  const cancellable = createOutlineJumpController({
    align: () => { cancelledAlignments++; return true; },
    requestFrame: callback => { cancellableFrames.push(callback); return cancellableFrames.length; },
    cancelFrame: () => {},
  });
  cancellable.jump('u9');
  cancellable.cancel();
  while (cancellableFrames.length) cancellableFrames.shift()();
  assert.strictEqual(cancelledAlignments, 1, 'user input cancellation must stop later correction frames');

  let missingBreaks = 0;
  const missing = createOutlineJumpController({
    beforeJump: () => { missingBreaks++; },
    align: () => false,
    requestFrame: () => { throw new Error('missing targets must not schedule correction'); },
  });
  assert.strictEqual(missing.jump('missing'), false);
  assert.strictEqual(missingBreaks, 1);

  console.log('conversation-outline-model: 31 checks PASSED');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
