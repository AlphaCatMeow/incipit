'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');

const runtime = read('data/legacy/conversation_outline.js');
const legacy = read('data/enhance_legacy.js');
const shared = read('data/enhance_shared.js');
const css = read('data/conversation_outline.css');
const install = read('src/install.js');

assert.ok(runtime.includes("export function initLegacyConversationOutline(ctx)"));
assert.ok(runtime.includes("runLegacyInit('conversation_outline'"));
assert.ok(legacy.includes("import { initLegacyConversationOutline } from './legacy/conversation_outline.js'"));
assert.ok(legacy.includes('initLegacyConversationOutline(legacyContext);'));
assert.ok(legacy.includes('function isSlashCommandInvocationRecord(record)'));
assert.ok(legacy.includes('function isInternalCommandProtocolRecord(record)'));
assert.ok(legacy.includes('!isInternalCommandProtocolRecord(record)'));
assert.ok(legacy.includes("classified.hadArrayContent ? '' : raw"));

for (const adapter of [
  'locateActiveSessionState',
  'transcriptRecordForElement',
  'transcriptRecordIndex',
  'recordUuid',
  'recordBetaMessageId',
  'getActiveSessionId',
  'isOutlineUserRecord',
  'outlineTextForRecord',
]) {
  assert.ok(legacy.includes(`${adapter},`), `legacy context must provide ${adapter}`);
}

assert.ok(runtime.includes('signalValue(session && session.messages)'));
assert.ok(runtime.includes("subscribe('sessionChanged'"));
assert.ok(runtime.includes("subscribe('messagesChanged'"));
assert.ok(runtime.includes("subscribe('assistantTurnFinalized'"));
assert.ok(runtime.includes("viewport.addEventListener('scroll', onViewportScroll, { passive: true })"));
assert.ok(runtime.includes('let sampledEntries = [];'));
assert.ok(runtime.includes('resolveNearestMarkerKey(entries, sampledEntries, activeRowKey)'));
assert.ok(runtime.includes("event.pointerType === 'touch' || event.pointerType === 'pen'"));
assert.ok(runtime.includes('coarsePointer && event.detail !== 0'));
assert.ok(runtime.includes("root.addEventListener('pointerenter', updatePointerModeFromEvent);"),
  'hovering anywhere on the rail must not expand the panel by itself');
assert.ok(runtime.includes("button.addEventListener('pointerenter', event => {"),
  'the panel expands only when the pointer hovers a marker indicator');
assert.ok(runtime.includes('const outside = !!(expanded && root && !root.contains(event.target));'));
assert.ok(runtime.includes("containerObserver.observe(viewport, { childList: true, subtree: true })"));
assert.ok(!runtime.includes('containerObserver.observe(document.body'));
assert.ok(runtime.includes("previewObserver.observe(content, { childList: true, subtree: true, characterData: true })"));
assert.ok(runtime.includes('function mutationChangesMessageRows(mutation)'));
assert.ok(runtime.includes('if (mutations.some(mutationChangesMessageRows)) indexMountedRows();'));
assert.ok(runtime.includes('anchorResizeObserver = new ResizeObserver(scheduleMeasure);'));
assert.ok(runtime.includes('jumpController.cancel();'));
assert.ok(runtime.includes("report('degraded', { reason: 'target-not-mounted' })"));
assert.ok(runtime.includes("!mountedRow(rowKey)"));
assert.ok(runtime.includes('const HOST_FOLLOW_DISTANCE_PX = 50;'));
assert.ok(runtime.includes('function destroy()'));
assert.ok(runtime.includes('unsubscribe();'));
assert.ok(runtime.includes('cancelAnimationFrame(measureFrame)'));
assert.ok(runtime.includes('root.remove();'));
assert.ok(runtime.includes("node.setAttribute('aria-current', 'location')"));
assert.ok(runtime.includes('const item = matchedItem || fallbackItem;'));
assert.ok(runtime.includes('resolveNearestMarkerKey(entries, sampledEntries, focusedRowKey)'));

assert.ok(css.includes('[data-incipit-conversation-outline]'));
assert.ok(css.includes('[data-incipit-outline-marker][data-active="1"]'));
assert.ok(css.includes('[data-incipit-outline-item][data-pinned="1"]'));
assert.ok(css.includes('pointer-events: none;'));
assert.ok(css.includes('max-height: min(78%, 560px);'));
assert.ok(css.includes('overflow-y: auto;'));
assert.ok(css.includes('left: 6px;'), 'outline is anchored to the left side');
assert.ok(css.includes('inset: 0 auto 0 0;'), 'marker rail grows from the left edge');
assert.ok(css.includes('align-items: flex-start;'), 'markers align to the left edge');
assert.ok(css.includes('justify-content: flex-start;'), 'marker strokes grow into the panel');
assert.ok(css.includes('transform: translateY(-50%) translateX(-8px);'),
  'collapsed panel sits outside the left edge');
assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
assert.ok(!/::[-\w]*scrollbar/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));

assert.ok(shared.includes("ensureStylesheet('incipit-conversation-outline-link', 'conversation_outline.css')"));
assert.ok(install.includes("[path.join('data', 'conversation_outline.css'), 'conversation_outline.css']"));
assert.ok(install.includes("const LOCAL_ASSET_TREES = ['katex', 'hljs', 'fonts', 'effort-brain', 'capability', 'legacy', 'mermaid'];"));
assert.ok(!install.includes("legacy: new Set(['conversation_outline.js'"));

console.log('conversation-outline-runtime: 59 checks PASSED');
