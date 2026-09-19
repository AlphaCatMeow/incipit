/**
 * Activity groups: connected runs of tool and thinking rows.
 *
 * The host renders each assistant message as one sibling row inside a turn.
 * This module classifies those rows, stamps the data attributes that theme.css
 * turns into the left rail (glyph column and connector line), and mounts a
 * summary header inside the first row as soon as a run begins. It never moves
 * or removes host nodes: React keeps ownership of every
 * row, and all incipit state lives in attributes and one header button.
 *
 * Row vocabulary:
 * - `tool`: a row containing a host tool-use island (`tool_cards.js` stamps the
 *   tool kind and state that the summary reads back from the DOM).
 * - `thinking`: a row containing a host thinking block, either the `<details>`
 *   disclosure or the static `<div>` the host renders when the thinking text
 *   is empty or redacted.
 * - `text`: assistant prose. Prose is the answer or a progress report addressed
 *   to the user, so it stays a normal message and ends the current run; the
 *   next tool or thinking row starts a new run.
 */
import { subscribe, getHostState } from './runtime_kernel.js';

const TURN_SELECTOR = '[class*="turn_"]';
const TOOL_SELECTOR = '[class*="toolUse_"]';
const THINKING_SELECTOR = 'details[class*="thinking"], div[class*="thinking_"]';
const THINKING_SUMMARY_SELECTOR = '[class*="thinkingSummary"]';
const TEXT_SELECTOR = '[class*="root_"]';
const HEADER_ATTR = 'data-incipit-activity-header';
const LIVE_THINKING = /^Thinking(\.\.\.|…)/;
const MAX_REMEMBERED_GROUPS = 500;
const LIVE_PHRASES = { read: 'Reading file', edit: 'Editing file', command: 'Running command', search: 'Searching', agent: 'Running agent', workflow: 'Running workflow' };
// Matches `--incipit-fold-duration`; the attribute that carries the CSS
// transition is removed once the fold has settled so nothing animates later.
const FOLD_MS = 220;

const dirtyTurns = new Set();
const collapsedGroups = new Map();
const groupAliases = new Map();
let groupSequence = 0;
const animatingRows = new Map();
const pendingRows = new Map();
const ownedHeaderLayouts = new WeakMap();
const enteringRows = new Map();
const seenTools = new Set();
let knownTurns = new WeakSet();
let scheduleOwner = null;
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
  subscribe('sessionChanged', () => { collapsedGroups.clear(); groupAliases.clear(); seenTools.clear(); knownTurns = new WeakSet(); clearEntrances(); });
  window.addEventListener('pagehide', () => {
    dirtyTurns.clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const timer of animatingRows.values()) clearTimeout(timer);
    animatingRows.clear();
    clearEntrances();
  });
}

function schedule() {
  if (scheduleOwner) { scheduleOwner(); return; }
  if (!frame) frame = requestAnimationFrame(flush);
}

/** Share the tool decorator's frame so headings and rail geometry paint together. */
export function configureActivityScheduler(scheduleFrame) { scheduleOwner = scheduleFrame; }

function clearEntrances() {
  for (const [row, pending] of pendingRows) { clearTimeout(pending.timer); row.removeAttribute('data-incipit-activity-preparing'); }
  for (const [row, timer] of enteringRows) { clearTimeout(timer); row.removeAttribute('data-incipit-activity-entering'); }
  pendingRows.clear(); enteringRows.clear();
}

/** Stage a newly mounted live tool; only known turns are eligible for entry motion. */
export function stageActivityTool(root) {
  const row = root.closest('[class*="timelineMessage"]'), turn = root.closest(TURN_SELECTOR);
  if (!row || !turn) return;
  if (root.dataset.incipitToolHeadline === '1' && knownTurns.has(turn)) return;
  // Publish the parent heading even while the first tool is awaiting its fiber.
  dirtyTurns.add(turn); schedule();
  if (root.dataset.incipitToolHeadline === '1' || pendingRows.has(row) || getHostState().busy !== true) return;
  if (!root.querySelector('[class*="toolSummary"]') || root.querySelector('[role="dialog"], [class*="permission"]')) return;
  row.setAttribute('data-incipit-activity-preparing', '1');
  const timer = setTimeout(() => {
    pendingRows.delete(row); row.removeAttribute('data-incipit-activity-preparing');
  }, 500);
  pendingRows.set(row, { timer, knownTurn: knownTurns.has(turn) });
}

function publishRow(row) {
  const roots = row.querySelectorAll(TOOL_SELECTOR);
  const staged = pendingRows.has(row);
  if (staged && [...roots].some(root => root.dataset.incipitToolHeadline !== '1')) return;
  const fresh = pendingRows.get(row)?.knownTurn && [...roots].some(root => root.dataset.incipitToolId && !seenTools.has(root.dataset.incipitToolId) && root.dataset.incipitToolState === 'running');
  for (const root of roots) if (root.dataset.incipitToolId) seenTools.add(root.dataset.incipitToolId);
  while (seenTools.size > 2000) seenTools.delete(seenTools.values().next().value);
  if (staged) { clearTimeout(pendingRows.get(row).timer); pendingRows.delete(row); row.removeAttribute('data-incipit-activity-preparing'); }
  if (!fresh || row.hasAttribute('data-incipit-activity-collapsed') || enteringRows.has(row)) return;
  row.setAttribute('data-incipit-activity-entering', '1');
  enteringRows.set(row, setTimeout(() => { enteringRows.delete(row); row.removeAttribute('data-incipit-activity-entering'); }, FOLD_MS + 60));
}

/** Queue the turn that contains `node` for re-layout on the next frame. */
export function markActivityDirty(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (element?.closest?.('[data-incipit-agent-history]')) return;
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

export function flushActivityGroups(deadline = performance.now() + 4) {
  frame = 0;
  const turns = Array.from(dirtyTurns);
  dirtyTurns.clear();
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

function flush() { flushActivityGroups(); }

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

function stopAnimating(row) {
  const timer = animatingRows.get(row);
  if (timer !== undefined) { clearTimeout(timer); animatingRows.delete(row); }
  removeAttribute(row, 'data-incipit-activity-animating');
}

/**
 * Flip a row's collapsed state. Only a user toggle animates: rows that join
 * an already collapsed run while streaming take the resting state at once, so
 * the fold transition never runs on the streaming hot path.
 */
function setCollapsed(row, collapsed, animate) {
  const was = row.getAttribute('data-incipit-activity-collapsed') === '1';
  if (was === collapsed) return;
  if (collapsed) row.setAttribute('data-incipit-activity-collapsed', '1');
  else row.removeAttribute('data-incipit-activity-collapsed');
  if (!animate) return;
  stopAnimating(row);
  row.setAttribute('data-incipit-activity-animating', '1');
  animatingRows.set(row, setTimeout(() => {
    animatingRows.delete(row);
    removeAttribute(row, 'data-incipit-activity-animating');
  }, FOLD_MS + 60));
}

function clearRow(row) {
  removeAttribute(row, 'data-incipit-activity');
  removeAttribute(row, 'data-incipit-activity-edge');
  removeAttribute(row, 'data-incipit-activity-group');
  removeAttribute(row, 'data-incipit-activity-collapsed');
  stopAnimating(row);
  removeHeader(row);
}

function removeHeader(row) {
  const header = row.querySelector(':scope > [' + HEADER_ATTR + ']');
  if (header) header.remove();
  removeAttribute(row, 'data-incipit-activity-has-header');
}

function layoutTurn(turn, animate = false) {
  layoutRows(Array.from(turn.children).map(row => ({ row, kind: classifyRow(row) })), animate);
  knownTurns.add(turn);
}

function layoutRows(rows, animate, context = {}) {
  const groups = [];
  let current = null;
  for (const member of rows) {
    const { row, kind } = member;
    if (kind === 'tool' || kind === 'thinking') {
      if (!current) { current = []; groups.push(current); }
      current.push(member);
      continue;
    }
    if (kind !== 'skip') current = null;
    clearRow(row);
  }
  for (const group of groups) applyGroup(group, animate, context);
}

/** Reuse the main activity presentation for explicitly owned nested rows. */
export function createOwnedActivityGroups(keyPrefix, getRows) {
  let frame = 0, disposed = false;
  let previous = new Set();
  const layout = (animate = false) => {
    if (disposed) return;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const rows = getRows(), keep = new Set(rows.map(member => member.row));
    for (const row of previous) if (!keep.has(row)) clearRow(row);
    previous = keep;
    layoutRows(rows, animate, { keyPrefix, onToggle: layout, owned: true });
  };
  return {
    layout,
    schedule() { if (!disposed && !frame) frame = requestAnimationFrame(() => layout()); },
    dispose() { disposed = true; if (frame) cancelAnimationFrame(frame); for (const row of previous) clearRow(row); previous.clear(); },
  };
}

function isLiveThinking(row) {
  const summary = row.querySelector(THINKING_SUMMARY_SELECTOR);
  return !!summary && LIVE_THINKING.test((summary.textContent || '').trim());
}

function livePhrase(root) {
  const kind = root.dataset.incipitToolKind || 'other';
  if (kind === 'edit' && root.dataset.incipitToolName === 'Write') return 'Writing file';
  return LIVE_PHRASES[kind] || ('Running ' + (root.dataset.incipitToolName || 'tool'));
}

function collectStats(members) {
  const stats = { read: 0, edit: 0, command: 0, search: 0, agent: 0, workflow: 0, other: 0, tools: 0, thinking: 0, failed: 0, live: '', key: '' };
  for (const { row, kind, tools } of members) {
    if (kind === 'thinking') {
      stats.thinking++;
      if (isLiveThinking(row)) stats.live = 'Thinking';
      continue;
    }
    for (const root of tools || row.querySelectorAll(TOOL_SELECTOR)) {
      if (!tools && root.parentElement?.closest(TOOL_SELECTOR)) continue;
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
    if (stats.agent) parts.push(plural(stats.agent, 'agent call'));
    if (stats.workflow) parts.push(plural(stats.workflow, 'workflow'));
    if (stats.other) parts.push(plural(stats.other, parts.length ? 'other tool call' : 'tool call'));
    text = parts.join(', ');
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return stats.failed ? text + ' · ' + stats.failed + ' failed' : text;
}

function onHeaderClick(event) {
  event.stopPropagation();
  const header = event.currentTarget;
  const key = header.dataset.incipitActivityGroup;
  if (!key) return;
  rememberCollapsed(key, collapsedGroups.get(key) !== true);
  const ownedLayout = ownedHeaderLayouts.get(header);
  if (ownedLayout) { ownedLayout(true); return; }
  const turn = header.closest(TURN_SELECTOR);
  if (turn) layoutTurn(turn, true);
}

function mountHeader(row, key, label, collapsed, onToggle) {
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
  if (onToggle) ownedHeaderLayouts.set(header, onToggle);
  const text = header.firstElementChild;
  if (text.textContent !== label) text.textContent = label;
  setAttribute(header, 'aria-expanded', String(!collapsed));
  if (row.firstChild !== header) row.insertBefore(header, row.firstChild);
  setAttribute(row, 'data-incipit-activity-has-header', '1');
}

function applyGroup(members, animate, context = {}) {
  const stats = collectStats(members);
  if (stats.key && context.keyPrefix) stats.key = context.keyPrefix + ':' + stats.key;
  const previous = members.map(({ row }) => row.getAttribute('data-incipit-activity-group')).find(Boolean);
  const key = (previous && collapsedGroups.has(previous) ? previous : null) || groupAliases.get(stats.key) || previous || stats.key || 'incipit-activity-' + (++groupSequence);
  if (stats.key) {
    groupAliases.delete(stats.key); groupAliases.set(stats.key, key);
    while (groupAliases.size > MAX_REMEMBERED_GROUPS) groupAliases.delete(groupAliases.keys().next().value);
  }
  const collapsed = collapsedGroups.get(key) === true;
  const label = describe(stats) || (stats.thinking ? 'Thinking' : 'Activity');
  members.forEach(({ row, kind, setActive }, index) => {
    setAttribute(row, 'data-incipit-activity', kind);
    setAttribute(row, 'data-incipit-activity-group', key);
    setAttribute(row, 'data-incipit-activity-edge',
      members.length === 1 ? 'only' : index === 0 ? 'first' : index === members.length - 1 ? 'last' : 'middle');
    if (index === 0) mountHeader(row, key, label, collapsed, context.onToggle);
    else removeHeader(row);
    setCollapsed(row, collapsed, animate);
    setActive?.(!collapsed);
    if (!context.owned) publishRow(row);
  });
}
