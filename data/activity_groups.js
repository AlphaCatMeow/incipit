/**
 * Activity groups: connected runs of tool, thinking and interim note rows.
 *
 * The host renders each assistant message as one sibling row inside a turn.
 * This module classifies those rows, stamps the data attributes that theme.css
 * turns into the left rail (glyph column, connector line, note dots), and
 * mounts a summary header inside the first row of every run that has at least
 * two items. It never moves or removes host nodes: React keeps ownership of
 * every row, and all incipit state lives in attributes and one header button.
 *
 * Row vocabulary:
 * - `tool`: a row containing a host tool-use island (`tool_cards.js` stamps the
 *   tool kind and state that the summary reads back from the DOM).
 * - `thinking`: a row containing a host thinking disclosure.
 * - `note`: assistant prose that is followed by more tool or thinking rows in
 *   the same turn; the trailing prose after the last tool is the answer and
 *   stays a normal message.
 */
import { subscribe } from './runtime_kernel.js';

const TURN_SELECTOR = '[class*="turn_"]';
const TOOL_SELECTOR = '[class*="toolUse_"]';
const THINKING_SELECTOR = 'details[class*="thinking"]';
const TEXT_SELECTOR = '[class*="root_"]';
const HEADER_ATTR = 'data-incipit-activity-header';
const LIVE_THINKING = /^Thinking(\.\.\.|…)/;
const MAX_REMEMBERED_GROUPS = 500;
const LIVE_PHRASES = { read: 'Reading file', edit: 'Editing file', command: 'Running command', search: 'Searching' };

const dirtyTurns = new Set();
const collapsedGroups = new Map();
let frame = 0;
let initialized = false;

function plural(count, noun) { return count + ' ' + noun + (count === 1 ? '' : 's'); }

function setAttribute(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function removeAttribute(node, name) {
  if (node.hasAttribute(name)) node.removeAttribute(name);
}

function rememberCollapsed(key, collapsed) {
  collapsedGroups.delete(key);
  if (collapsed) collapsedGroups.set(key, true);
  while (collapsedGroups.size > MAX_REMEMBERED_GROUPS) collapsedGroups.delete(collapsedGroups.keys().next().value);
}

export function initActivityGroups() {
  if (initialized) return;
  initialized = true;
  subscribe('sessionChanged', () => collapsedGroups.clear());
  window.addEventListener('pagehide', () => {
    dirtyTurns.clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  });
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(flush);
}

/** Queue the turn that contains `node` for re-layout on the next frame. */
export function markActivityDirty(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const turn = element?.closest?.(TURN_SELECTOR);
  if (!turn) return;
  dirtyTurns.add(turn);
  schedule();
}

/** Queue every turn under `root`; used at start-up and when a transcript remounts. */
export function scanActivityTurns(root) {
  if (!root?.querySelectorAll) return;
  for (const turn of root.querySelectorAll(TURN_SELECTOR)) dirtyTurns.add(turn);
  if (dirtyTurns.size) schedule();
}

function flush() {
  frame = 0;
  const turns = Array.from(dirtyTurns);
  dirtyTurns.clear();
  const deadline = performance.now() + 4;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].isConnected) {
      try { layoutTurn(turns[i]); }
      catch (error) { try { console.warn('[incipit] activity layout failed:', error); } catch (_) {} }
    }
    if (performance.now() >= deadline && i + 1 < turns.length) {
      for (let j = i + 1; j < turns.length; j++) dirtyTurns.add(turns[j]);
      schedule();
      return;
    }
  }
}

function classifyRow(row) {
  const className = typeof row.className === 'string' ? row.className : '';
  if (className.includes('userMessageContainer')) return 'user';
  if (className.includes('spinnerRow')) return 'skip';
  if (!className.includes('timelineMessage')) return 'boundary';
  if (row.querySelector(TOOL_SELECTOR)) return 'tool';
  if (row.querySelector(THINKING_SELECTOR)) return 'thinking';
  if (row.querySelector(TEXT_SELECTOR)) return 'text';
  // A message that has not rendered its block yet must not split a run.
  return 'skip';
}

function clearRow(row) {
  removeAttribute(row, 'data-incipit-activity');
  removeAttribute(row, 'data-incipit-activity-edge');
  removeAttribute(row, 'data-incipit-activity-collapsed');
  removeHeader(row);
}

function removeHeader(row) {
  const header = row.querySelector(':scope > [' + HEADER_ATTR + ']');
  if (header) header.remove();
  removeAttribute(row, 'data-incipit-activity-has-header');
}

function layoutTurn(turn) {
  const rows = Array.from(turn.children);
  const kinds = rows.map(classifyRow);
  // Prose becomes a note only when more activity follows it in the same turn.
  let activityAhead = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const kind = kinds[i];
    if (kind === 'tool' || kind === 'thinking') activityAhead = true;
    else if (kind === 'text') kinds[i] = activityAhead ? 'note' : 'text';
    else if (kind !== 'skip') activityAhead = false;
  }
  const groups = [];
  let current = null;
  rows.forEach((row, i) => {
    const kind = kinds[i];
    if (kind === 'tool' || kind === 'thinking' || kind === 'note') {
      if (!current) { current = []; groups.push(current); }
      current.push({ row, kind });
      return;
    }
    if (kind !== 'skip') current = null;
    clearRow(row);
  });
  for (const group of groups) applyGroup(group);
}

function isLiveThinking(row) {
  const summary = row.querySelector(THINKING_SELECTOR + ' > summary');
  return !!summary && LIVE_THINKING.test((summary.textContent || '').trim());
}

function livePhrase(root) {
  const kind = root.dataset.incipitToolKind || 'other';
  if (kind === 'edit' && root.dataset.incipitToolName === 'Write') return 'Writing file';
  return LIVE_PHRASES[kind] || ('Running ' + (root.dataset.incipitToolName || 'tool'));
}

function collectStats(members) {
  const stats = { read: 0, edit: 0, command: 0, search: 0, other: 0, tools: 0, thinking: 0, notes: 0, failed: 0, live: '', key: '' };
  for (const { row, kind } of members) {
    if (kind === 'note') { stats.notes++; continue; }
    if (kind === 'thinking') {
      stats.thinking++;
      if (isLiveThinking(row)) stats.live = 'Thinking';
      continue;
    }
    for (const root of row.querySelectorAll(TOOL_SELECTOR)) {
      if (root.parentElement?.closest(TOOL_SELECTOR)) continue;
      stats.tools++;
      const toolKind = root.dataset.incipitToolKind;
      stats[toolKind in LIVE_PHRASES ? toolKind : 'other']++;
      if (!stats.key && root.dataset.incipitToolId) stats.key = root.dataset.incipitToolId;
      const state = root.dataset.incipitToolState;
      if (state === 'error') stats.failed++;
      if (state === 'running') stats.live = livePhrase(root);
    }
  }
  return stats;
}

function describe(stats) {
  let text = stats.live;
  if (!text) {
    const parts = [];
    if (stats.read) parts.push('read ' + plural(stats.read, 'file'));
    if (stats.edit) parts.push('edited ' + plural(stats.edit, 'file'));
    if (stats.command) parts.push('ran ' + plural(stats.command, 'command'));
    if (stats.search) parts.push(stats.search === 1 ? 'searched once' : 'searched ' + stats.search + ' times');
    if (stats.other) parts.push(plural(stats.other, parts.length ? 'other tool call' : 'tool call'));
    if (!parts.length) parts.push(stats.thinking > 1 ? 'thought ' + stats.thinking + ' times' : 'thought');
    text = parts.join(', ');
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  const tail = [];
  if (stats.notes) tail.push(plural(stats.notes, 'note'));
  if (stats.failed) tail.push(stats.failed + ' failed');
  return tail.length ? text + ' · ' + tail.join(' · ') : text;
}

function onHeaderClick(event) {
  event.stopPropagation();
  const header = event.currentTarget;
  const key = header.dataset.incipitActivityGroup;
  if (!key) return;
  rememberCollapsed(key, collapsedGroups.get(key) !== true);
  const turn = header.closest(TURN_SELECTOR);
  if (turn) layoutTurn(turn);
}

function mountHeader(row, key, label, collapsed) {
  let header = row.querySelector(':scope > [' + HEADER_ATTR + ']');
  if (!header) {
    header = document.createElement('button');
    header.type = 'button';
    header.setAttribute(HEADER_ATTR, '');
    header.appendChild(document.createElement('span')).setAttribute('data-incipit-activity-header-text', '');
    header.appendChild(document.createElement('span')).setAttribute('data-incipit-activity-header-caret', '');
    header.addEventListener('click', onHeaderClick);
  }
  header.dataset.incipitActivityGroup = key;
  const text = header.firstElementChild;
  if (text.textContent !== label) text.textContent = label;
  setAttribute(header, 'aria-expanded', String(!collapsed));
  if (row.firstChild !== header) row.insertBefore(header, row.firstChild);
  setAttribute(row, 'data-incipit-activity-has-header', '1');
}

function applyGroup(members) {
  const stats = collectStats(members);
  // Single tool rows read fine on their own; the summary earns its line once a
  // run has at least two items, matching the reference activity list.
  const showHeader = stats.tools > 0 && stats.tools + stats.notes >= 2 && !!stats.key;
  const collapsed = showHeader && collapsedGroups.get(stats.key) === true;
  const label = showHeader ? describe(stats) : '';
  members.forEach(({ row, kind }, index) => {
    setAttribute(row, 'data-incipit-activity', kind);
    setAttribute(row, 'data-incipit-activity-edge',
      members.length === 1 ? 'only' : index === 0 ? 'first' : index === members.length - 1 ? 'last' : 'middle');
    if (collapsed) setAttribute(row, 'data-incipit-activity-collapsed', '1');
    else removeAttribute(row, 'data-incipit-activity-collapsed');
    if (index === 0 && showHeader) mountHeader(row, stats.key, label, collapsed);
    else removeHeader(row);
  });
}
