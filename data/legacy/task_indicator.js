import { SEL } from '../host_probe.js';
import { CFG } from '../enhance_shared.js';
import { reportCapability, subscribe } from '../runtime_kernel.js';
import { runLegacyInit } from './registry.js';
import { findLatestTaskSnapshot } from './task_indicator_model.js';

const COLLAPSE_DELAY_MS = 180;

const STR = Object.freeze({
  en: Object.freeze({
    task_progress: 'Task Progress',
    task_step: 'Step {current}/{total}',
    task_completed_count: '{completed}/{total} done',
    task_running: 'In progress',
    task_pending: 'Pending',
    task_completed: 'All done',
  }),
  zh: Object.freeze({
    task_progress: '任务进度',
    task_step: '第 {current}/{total} 步',
    task_completed_count: '{completed}/{total} 已完成',
    task_running: '进行中',
    task_pending: '待处理',
    task_completed: '全部完成',
  }),
});

function t(key, vars) {
  const dict = STR[CFG.language] || STR.en;
  const raw = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : (STR.en[key] || key);
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

function signalValue(signal) {
  try { return signal && typeof signal === 'object' && 'value' in signal ? signal.value : signal; }
  catch (_) { return null; }
}

function svgEl(paths, viewBox = '0 0 24 24') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function makeCheckIcon() {
  return svgEl(['M20 6 9 17l-5-5']);
}

function makeStatusIcon(status) {
  if (status === 'completed') return makeCheckIcon();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '8');
  if (status === 'in_progress') {
    circle.setAttribute('fill', 'currentColor');
    circle.setAttribute('stroke', 'none');
  } else {
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2');
  }
  svg.appendChild(circle);
  return svg;
}

function findComposer() {
  const footer = document.querySelector(SEL.inputFooter);
  const container = footer && footer.closest('[class*="inputContainer_"]');
  return container || document.querySelector('[class*="inputContainer_"]');
}

function createTaskIndicatorController(ctx) {
  let root = null;
  let pill = null;
  let panel = null;
  let panelHeader = null;
  let panelStatus = null;
  let panelProgress = null;
  let panelList = null;
  let pillIcon = null;
  let pillLabel = null;
  let pillCount = null;

  let expanded = false;
  let collapseTimer = 0;
  let snapshot = null;
  let currentSessionId = null;
  let repositionScheduled = false;
  let destroyed = false;
  const unsubscribers = [];

  function report(status, detail = null) {
    try { reportCapability('taskIndicator', status, detail); } catch (_) {}
  }

  function statusLabel(state) {
    if (state === 'completed') return t('task_completed');
    if (state === 'running') return t('task_running');
    return t('task_pending');
  }

  function setExpanded(next) {
    const value = !!next;
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = 0; }
    if (expanded === value) return;
    expanded = value;
    if (root) root.setAttribute('data-expanded', expanded ? '1' : '0');
  }

  function scheduleCollapse() {
    if (collapseTimer) return;
    collapseTimer = setTimeout(() => {
      collapseTimer = 0;
      setExpanded(false);
    }, COLLAPSE_DELAY_MS);
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !expanded) return;
    if (!root || !root.contains(event.target)) return;
    setExpanded(false);
    if (pill) pill.focus();
  }

  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.setAttribute('data-incipit-task-indicator', '');
    root.setAttribute('data-expanded', '0');
    root.hidden = true;

    panel = document.createElement('div');
    panel.setAttribute('data-incipit-task-panel', '');

    panelHeader = document.createElement('div');
    panelHeader.setAttribute('data-incipit-task-panel-header', '');
    const title = document.createElement('span');
    title.setAttribute('data-incipit-task-panel-title', '');
    title.textContent = t('task_progress');
    panelStatus = document.createElement('span');
    panelStatus.setAttribute('data-incipit-task-panel-status', '');
    panelHeader.appendChild(title);
    panelHeader.appendChild(panelStatus);
    panel.appendChild(panelHeader);

    panelProgress = document.createElement('div');
    panelProgress.setAttribute('data-incipit-task-panel-progress', '');
    panel.appendChild(panelProgress);

    panelList = document.createElement('div');
    panelList.setAttribute('data-incipit-task-panel-list', '');
    panel.appendChild(panelList);

    pill = document.createElement('button');
    pill.type = 'button';
    pill.setAttribute('data-incipit-task-pill', '');
    pillIcon = document.createElement('span');
    pillIcon.setAttribute('data-incipit-task-pill-icon', '');
    pillLabel = document.createElement('span');
    pillLabel.setAttribute('data-incipit-task-pill-label', '');
    const sep = document.createElement('span');
    sep.setAttribute('data-incipit-task-pill-sep', '');
    sep.textContent = '·';
    pillCount = document.createElement('span');
    pillCount.setAttribute('data-incipit-task-pill-count', '');
    pill.appendChild(pillIcon);
    pill.appendChild(pillLabel);
    pill.appendChild(sep);
    pill.appendChild(pillCount);
    pill.addEventListener('click', event => {
      event.preventDefault();
      setExpanded(!expanded);
    });

    root.appendChild(panel);
    root.appendChild(pill);

    root.addEventListener('pointerenter', () => setExpanded(true));
    root.addEventListener('pointerleave', scheduleCollapse);
    root.addEventListener('focusin', () => setExpanded(true));
    root.addEventListener('focusout', event => {
      if (!root.contains(event.relatedTarget)) scheduleCollapse();
    });
    root.addEventListener('keydown', onKeyDown);

    document.body.appendChild(root);
    return root;
  }

  function makeRow(item) {
    const row = document.createElement('div');
    row.setAttribute('data-incipit-task-row', '');
    row.setAttribute('data-status', item.status);
    const icon = document.createElement('span');
    icon.setAttribute('data-incipit-task-row-icon', '');
    icon.appendChild(makeStatusIcon(item.status));
    const text = document.createElement('span');
    text.setAttribute('data-incipit-task-row-text', '');
    text.textContent = item.text;
    row.appendChild(icon);
    row.appendChild(text);
    return row;
  }

  function render() {
    if (!snapshot || snapshot.total === 0) {
      if (root) root.hidden = true;
      return;
    }
    ensureRoot();
    root.hidden = false;
    root.setAttribute('data-state', snapshot.state);

    pillIcon.replaceChildren(makeStatusIcon(snapshot.state === 'completed' ? 'completed' : 'in_progress'));
    pillLabel.textContent = t('task_step', { current: snapshot.currentIndex, total: snapshot.total });
    pillCount.textContent = t('task_completed_count', { completed: snapshot.completed, total: snapshot.total });

    panelStatus.textContent = statusLabel(snapshot.state);
    panelProgress.textContent =
      `${t('task_step', { current: snapshot.currentIndex, total: snapshot.total })} · ` +
      t('task_completed_count', { completed: snapshot.completed, total: snapshot.total });

    panelList.replaceChildren(...snapshot.items.map(makeRow));
    schedulePosition();
  }

  function positionNow() {
    repositionScheduled = false;
    if (!root || root.hidden) return;
    const composer = findComposer();
    if (!composer) return;
    const rect = composer.getBoundingClientRect();
    root.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    root.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
  }

  function schedulePosition() {
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(positionNow);
  }

  function refresh() {
    if (destroyed) return;
    const session = ctx.locateActiveSessionState();
    const messages = signalValue(session && session.messages);
    const records = Array.isArray(messages) ? messages : [];
    const nextSessionId = ctx.getActiveSessionId() || signalValue(session && session.sessionId) || null;
    if (nextSessionId !== currentSessionId) {
      currentSessionId = nextSessionId;
      setExpanded(false);
    }
    snapshot = findLatestTaskSnapshot(records);
    render();
    report(snapshot && snapshot.total ? 'ok' : 'pending', { total: snapshot ? snapshot.total : 0 });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe(); } catch (_) {}
    }
    window.removeEventListener('scroll', schedulePosition, true);
    window.removeEventListener('resize', schedulePosition, true);
    if (collapseTimer) clearTimeout(collapseTimer);
    if (root) root.remove();
    root = null;
    report('pending', { reason: 'destroyed' });
  }

  window.addEventListener('scroll', schedulePosition, true);
  window.addEventListener('resize', schedulePosition, true);
  unsubscribers.push(subscribe('sessionChanged', refresh));
  unsubscribers.push(subscribe('messagesChanged', refresh));

  refresh();
  return Object.freeze({ destroy, refresh });
}

export function initLegacyTaskIndicator(ctx) {
  let controller = null;
  runLegacyInit('task_indicator', ctx, () => {
    const previous = globalThis.__incipitTaskIndicator;
    if (previous && typeof previous.destroy === 'function') previous.destroy();
    controller = createTaskIndicatorController(ctx);
    globalThis.__incipitTaskIndicator = controller;
  });
  return controller;
}
