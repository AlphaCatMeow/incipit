'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');

const runtime = read('data/legacy/task_indicator.js');
const model = read('data/legacy/task_indicator_model.js');
const legacy = read('data/enhance_legacy.js');
const shared = read('data/enhance_shared.js');
const css = read('data/task_indicator.css');
const install = read('src/install.js');
const menu = read('src/menu.js');
const i18nEn = read('src/i18n.js');
const pkg = read('package.json');

assert.ok(runtime.includes('export function initLegacyTaskIndicator(ctx)'));
assert.ok(runtime.includes("runLegacyInit('task_indicator'"));
assert.ok(legacy.includes("import { initLegacyTaskIndicator } from './legacy/task_indicator.js'"));
assert.ok(legacy.includes('initLegacyTaskIndicator(legacyContext);'));

for (const adapter of [
  'locateActiveSessionState',
  'getActiveSessionId',
]) {
  assert.ok(legacy.includes(`${adapter},`), `legacy context must provide ${adapter}`);
}

assert.ok(runtime.includes("import { findLatestTaskSnapshot } from './task_indicator_model.js'"),
  'runtime must read snapshots through the pure model module, not re-derive TodoWrite parsing inline');
assert.ok(runtime.includes('signalValue(session && session.messages)'));
assert.ok(runtime.includes("subscribe('sessionChanged'"));
assert.ok(runtime.includes("subscribe('messagesChanged'"));

assert.ok(runtime.includes("root.addEventListener('pointerenter', () => setExpanded(true));"));
assert.ok(runtime.includes("root.addEventListener('pointerleave', scheduleCollapse);"));
assert.ok(runtime.includes("root.addEventListener('focusin', () => setExpanded(true));"));
assert.ok(runtime.includes('function scheduleCollapse()'));
assert.ok(runtime.includes('const COLLAPSE_DELAY_MS = 180;'));

assert.ok(runtime.includes('function findComposer()'));
assert.ok(runtime.includes('function positionNow()'));
assert.ok(runtime.includes("window.addEventListener('scroll', schedulePosition, true);"));
assert.ok(runtime.includes("window.addEventListener('resize', schedulePosition, true);"));

assert.ok(runtime.includes('function destroy()'));
assert.ok(runtime.includes('unsubscribe();'));
assert.ok(runtime.includes('root.remove();'));
assert.ok(runtime.includes('globalThis.__incipitTaskIndicator'));

assert.ok(runtime.includes("t('task_progress')"));
assert.ok(runtime.includes("t('task_step'"));
assert.ok(runtime.includes("t('task_completed_count'"));
for (const key of [
  'task_progress',
  'task_step',
  'task_completed_count',
  'task_running',
  'task_pending',
  'task_completed',
]) {
  assert.ok(runtime.includes(`${key}:`), `STR dictionaries must define ${key}`);
}

assert.ok(model.includes('export function normalizeTaskSnapshot'));
assert.ok(model.includes('export function normalizeTaskStatus'));
assert.ok(model.includes('export function normalizeTaskText'));
assert.ok(model.includes('export function findLatestTaskSnapshot'));
assert.ok(model.includes("block.name === 'TodoWrite'"));
assert.ok(!model.includes('document.'), 'the model module must stay DOM-free');

assert.ok(css.includes('[data-incipit-task-indicator]'));
assert.ok(css.includes('[data-incipit-task-pill]'));
assert.ok(css.includes('[data-incipit-task-panel]'));
assert.ok(css.includes('[data-incipit-task-row][data-status="completed"]'));
assert.ok(css.includes("[data-incipit-task-indicator][data-expanded=\"1\"] [data-incipit-task-panel]"));
assert.ok(css.includes('pointer-events: none;'));
assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
assert.ok(!/::[-\w]*scrollbar/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));

assert.ok(shared.includes("ensureStylesheet('incipit-task-indicator-link', 'task_indicator.css')"));
assert.ok(install.includes("[path.join('data', 'task_indicator.css'), 'task_indicator.css']"));
assert.ok(menu.includes("'task_indicator.css':      'apply.report.desc.task_indicator_css'"));
assert.ok(i18nEn.includes("'apply.report.desc.task_indicator_css': 'task progress indicator styles'"));
assert.ok(pkg.includes('tests/task-indicator-model.test.js'));
assert.ok(pkg.includes('tests/task-indicator-runtime.test.js'));
assert.ok(pkg.includes('"test:task-indicator"'));

console.log('task-indicator-runtime: checks PASSED');
