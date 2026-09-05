import { configureDiffSource, fetchToolDiff, clearDiffSource } from './diff/source.js';
import { getDiffModel, clearDiffModels } from './diff/client.js';
import { createDiffPreview, closeFullDiff } from './diff/view.js';
import { subscribe } from './runtime_kernel.js';
import { markActivityDirty } from './activity_groups.js';

const controllers = new Map();
const foldChoices = new Map();
const FILE_CHANGES = new Set(['Edit', 'MultiEdit', 'Write']);
/** Row label per tool as [settled, running, failed]; unknown tools keep their raw name. */
const LABELS = {
  Edit: ['Edited', 'Editing', 'Edit'], MultiEdit: ['Edited', 'Editing', 'Edit'], Write: ['Wrote', 'Writing', 'Write'],
  Read: ['Read', 'Reading', 'Read'], ReadCoalesced: ['Read', 'Reading', 'Read'],
  Bash: ['Ran command', 'Running command', 'Command'],
  Grep: ['Searched', 'Searching', 'Search'], Glob: ['Found files', 'Finding files', 'Find files'],
  WebSearch: ['Searched the web', 'Searching the web', 'Web search'], WebFetch: ['Fetched', 'Fetching', 'Fetch'],
  TodoWrite: ['Updated tasks', 'Updating tasks', 'Update tasks'],
  Task: ['Ran agent', 'Running agent', 'Agent'], Agent: ['Ran agent', 'Running agent', 'Agent'],
  AskUserQuestion: ['Asked a question', 'Asking a question', 'Question'],
};
/** Category that activity group summaries count; anything else is "other". */
const KINDS = {
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', Read: 'read', ReadCoalesced: 'read',
  Bash: 'command', Grep: 'search', Glob: 'search', WebSearch: 'search',
};
const ICONS = {
  file: '<path d="M9 2H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z"/><path d="M9 2v6h6M6 11h6M6 13h4"/>',
  edit: '<path d="M10 3H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5"/><path d="m9 11-3 1 1-3 7-7 2 2z"/>',
  terminal: '<rect x="2" y="3" width="14" height="12" rx="2"/><path d="m5 6 3 3-3 3m5 0h3"/>',
  search: '<circle cx="8" cy="8" r="5"/><path d="m12 12 4 4"/>',
  tool: '<path d="m5 3-2 2 4 4-4 4 2 2 4-4 4 4 2-2-4-4 4-4-2-2-4 4z"/>',
};
let initialized = false;
let identityProvider = null;
let visibilityObserver = null;
let activeSession = '';
let sweepTimer = null;

function setAttribute(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function node(tag, attr, text) {
  const value = document.createElement(tag);
  if (attr) value.setAttribute(attr, '');
  if (text !== undefined) value.textContent = text;
  return value;
}

function iconFor(name) {
  const icon = FILE_CHANGES.has(name) ? 'edit' : name === 'Bash' ? 'terminal' :
    ['Read', 'ReadCoalesced'].includes(name) ? 'file' : ['Grep', 'Glob', 'WebSearch'].includes(name) ? 'search' : 'tool';
  return '<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[icon] + '</svg>';
}

function fileName(value) { return String(value || '').split(/[/\\]/).pop() || ''; }

function identity() {
  try { return identityProvider ? identityProvider() : {}; }
  catch (_) { return {}; }
}

function publicState(data) {
  if (data.result?.is_error || ['error', 'failed', 'failure'].includes(data.status)) return 'error';
  if (data.result?.type === 'tool_result' && data.result.tool_use_id === data.block?.id) return 'complete';
  if (['pending', 'running', 'in_progress'].includes(data.status)) return 'running';
  if (data.result || ['success', 'succeeded', 'completed', 'complete', 'ok'].includes(data.status)) return 'complete';
  return 'unknown';
}

/**
 * The host writes result fingerprints such as "Found 3 lines" into a
 * secondaryLine block beside the summary. The row mirrors that text instead of
 * letting it render as a second line under the heading.
 */
function hostFingerprint(root) {
  for (const candidate of root.querySelectorAll('[class*="secondaryLine_"]')) {
    if (candidate.closest('[class*="toolBody_"], [data-incipit-tool-heading]')) continue;
    if (candidate.closest('[class*="toolUse_"]') !== root) continue;
    return (candidate.textContent || '').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function inputVersion(block) {
  const input = block.input || {};
  return [block.id, block.name, input.file_path, input.old_string, input.new_string, input.content,
    input.edits, input.replace_all];
}

function sameVersion(a, b) { return a && a.length === b.length && a.every((value, i) => value === b[i]); }

function rememberChoice(key, open) {
  foldChoices.delete(key); foldChoices.set(key, open);
  while (foldChoices.size > 1000) foldChoices.delete(foldChoices.keys().next().value);
}

function observeNativeState(root, onChange) {
  const observer = new MutationObserver(records => {
    if (records.some(record => !record.target.closest('[data-incipit-tool-heading], [data-incipit-file-tool-body], [data-incipit-tool-error]'))) onChange?.();
  });
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'aria-busy'], subtree: true });
  return observer;
}

function resetSession(sessionId) {
  if (sessionId === activeSession) return;
  activeSession = sessionId || '';
  for (const controller of [...controllers.values()]) controller.dispose();
  controllers.clear(); foldChoices.clear(); clearDiffSource(); clearDiffModels(); closeFullDiff();
}

export function initToolCards(options) {
  identityProvider = options.getIdentity;
  configureDiffSource(options.getApi);
  if (initialized) return;
  initialized = true;
  activeSession = identity().sessionId || '';
  if (typeof IntersectionObserver === 'function') {
    visibilityObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const controller = controllers.get(entry.target);
        if (!controller) continue;
        controller.intersecting = entry.isIntersecting;
        if (entry.isIntersecting) controller.prefetch();
        else controller.releaseSource?.();
      }
    }, { rootMargin: '240px' });
  }
  subscribe('sessionChanged', state => resetSession(state.sessionId || ''));
  window.addEventListener('pagehide', () => resetSession(''));
}

function clearRootMarks(root) {
  delete root.dataset.incipitToolHeadline; delete root.dataset.incipitToolCollapsed; delete root.dataset.incipitToolKind;
  delete root.dataset.incipitToolName; delete root.dataset.incipitToolId; delete root.dataset.incipitToolExpandable;
  root.removeAttribute('data-incipit-tool-state');
}

/**
 * One activity row: glyph in the rail column, tense-aware action label, basename
 * or command description, counts, host fingerprint, failure text and a caret
 * that only shows on hover or focus. Nothing else hangs under the row; the full
 * path of a single file is reachable through the shared path tooltip.
 */
function buildHeadline(root, options) {
  const header = node('div', 'data-incipit-tool-heading');
  const toggle = node('button', 'data-incipit-tool-toggle'); toggle.type = 'button';
  const glyph = node('span', 'data-incipit-tool-icon');
  const label = node('span', 'data-incipit-tool-label');
  const subject = node('span', 'data-incipit-tool-subject');
  const stem = node('span', 'data-incipit-tool-filename-stem');
  const extension = node('span', 'data-incipit-tool-filename-extension');
  subject.append(stem, extension);
  const counts = node('span', 'data-incipit-tool-counts'); counts.hidden = true;
  const fingerprint = node('span', 'data-incipit-tool-fingerprint-text'); fingerprint.hidden = true;
  const state = node('span', 'data-incipit-tool-state'); state.hidden = true;
  const chevron = node('span', 'data-incipit-tool-chevron');
  toggle.append(glyph, label, subject, counts, fingerprint, state, chevron);
  header.append(toggle);
  root.insertBefore(header, root.firstChild);
  root.dataset.incipitToolHeadline = '1';
  let lastName = '', lastStatus = '', lastSubject = '';
  let isOpen = false, expandable = true;

  function sync() {
    setAttribute(root, 'data-incipit-tool-expandable', String(expandable));
    if (expandable) setAttribute(toggle, 'aria-expanded', String(isOpen));
    else toggle.removeAttribute('aria-expanded');
  }

  function update(next, canExpand) {
    const block = next.block, input = block.input || {};
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    const readPaths = block.name === 'ReadCoalesced' && Array.isArray(input.fileReads)
      ? input.fileReads.map(read => read.file_path || read.path).filter(value => typeof value === 'string' && value) : [];
    const paths = filePath ? [filePath] : readPaths;
    const isFile = paths.length > 0;
    const description = isFile ? paths.map(fileName).join(', ') : String(input.description || input.query || input.pattern ||
      (block.name === 'Bash' ? input.command || '' : '') || '').replace(/\s+/g, ' ').trim();
    const status = publicState(next);
    const labels = LABELS[block.name];
    if (lastName !== block.name) {
      lastName = block.name;
      glyph.innerHTML = iconFor(block.name);
      root.dataset.incipitToolKind = KINDS[block.name] || 'other';
      root.dataset.incipitToolName = block.name;
      label.title = labels ? '' : block.name;
    }
    if (root.dataset.incipitToolId !== block.id) root.dataset.incipitToolId = block.id;
    const labelText = labels ? labels[status === 'running' ? 1 : status === 'error' ? 2 : 0] : block.name;
    if (label.textContent !== labelText) label.textContent = labelText;
    if (lastSubject !== description) {
      lastSubject = description;
      const dot = paths.length === 1 ? description.lastIndexOf('.') : -1;
      stem.textContent = dot > 0 ? description.slice(0, dot) : description;
      extension.textContent = dot > 0 ? description.slice(dot) : '';
      subject.hidden = !description;
    }
    setAttribute(subject, 'data-incipit-tool-subject', isFile ? 'file' : 'text');
    // Single files use the shared path tooltip; everything else falls back to a
    // native title so truncated text stays reachable.
    if (paths.length === 1) {
      if (subject.dataset.incipitToolFullpath !== filePath) subject.dataset.incipitToolFullpath = filePath;
      if (subject.title) subject.title = '';
    } else {
      if (subject.dataset.incipitToolFullpath) delete subject.dataset.incipitToolFullpath;
      const hover = isFile ? paths.join('\n') : description;
      if (subject.title !== hover) subject.title = hover;
    }
    setAttribute(toggle, 'aria-label', labelText + (description ? ': ' + description : ''));
    setAttribute(root, 'data-incipit-tool-state', status);
    const statusText = status === 'error' ? 'Failed' : '';
    if (state.textContent !== statusText) state.textContent = statusText;
    state.hidden = !statusText;
    const print = FILE_CHANGES.has(block.name) ? '' : hostFingerprint(root);
    if (fingerprint.textContent !== print) fingerprint.textContent = print;
    fingerprint.hidden = !print;
    expandable = canExpand !== false;
    sync();
    if (lastStatus !== status) { lastStatus = status; markActivityDirty(root); }
  }

  toggle.addEventListener('click', event => { event.stopPropagation(); if (expandable) options.toggle(); });
  header.addEventListener('click', event => event.stopPropagation());
  return {
    header, toggle,
    update,
    setOpen(value) { isOpen = value; sync(); },
    setCounts(stats) {
      counts.replaceChildren(); counts.hidden = !stats;
      if (stats) counts.append(node('span', 'data-incipit-tool-added', '+' + stats.added), node('span', 'data-incipit-tool-removed', '−' + stats.removed));
    },
  };
}

function createFileCard(root, initial, options) {
  let data = initial;
  let version = inputVersion(data.block);
  const session = identity();
  const key = (session.sessionId || '') + ':' + data.block.id;
  let open = foldChoices.get(key) === true;
  let disposed = false, closeTimer = null, transitionGeneration = 0, revision = 0;
  let sourcePayload = null, sourcePromise = null, sourceController = null, view = null, sourceKnown = false;
  // Exact input-derived counts show at once; the historical patch replaces
  // them when it arrives, and a result that has not been saved yet is polled
  // with backoff instead of waiting for an unrelated mutation.
  let provisional = options.estimateStats?.(data.block) || null;
  let pendingTimer = null, pendingAttempts = 0;
  const PENDING_RETRY_MS = [400, 800, 1600, 3200, 6400, 12800];
  const body = node('div', 'data-incipit-file-tool-body');
  const inner = node('div', 'data-incipit-file-tool-inner');
  const diff = node('div');
  inner.appendChild(diff); body.appendChild(inner); body.hidden = !open; body.inert = !open;
  root.dataset.incipitFileTool = '1';
  root.dataset.incipitToolCollapsed = String(!open);
  const headline = buildHeadline(root, { toggle: () => setOpen(!open) });
  const nativeStateObserver = observeNativeState(root, options.onNativeChange);
  const toolError = node('div', 'data-incipit-tool-error'); toolError.hidden = true;
  root.appendChild(toolError);
  root.appendChild(body);
  const bodyId = 'incipit-tool-preview-' + Math.random().toString(36).slice(2);
  body.id = bodyId; headline.toggle.setAttribute('aria-controls', bodyId);
  headline.setOpen(open);
  headline.setCounts(provisional);
  body.addEventListener('click', event => event.stopPropagation());

  function schedulePendingRetry() {
    if (disposed || pendingTimer || pendingAttempts >= PENDING_RETRY_MS.length) return;
    pendingTimer = setTimeout(() => { pendingTimer = null; controller.prefetch(); }, PENDING_RETRY_MS[pendingAttempts++]);
  }

  async function loadSource(signal, refresh = false) {
    if (sourcePayload && !refresh) return sourcePayload;
    if (sourcePromise && !refresh) return sourcePromise;
    sourceController?.abort(); sourceController = new AbortController();
    const controller = sourceController;
    const epoch = revision;
    const current = identity();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const promise = fetchToolDiff({ sessionId: current.sessionId, cwd: current.cwd,
      toolUseId: data.block.id, filePath: data.block.input.file_path }, { signal: controller.signal })
      .then(payload => {
        if (disposed || epoch !== revision) throw Object.assign(new Error('Diff view changed.'), { name: 'AbortError' });
        if (payload.state === 'ready') {
          sourceKnown = true;
          if (open) sourcePayload = payload;
          headline.setCounts(payload.quality === 'coarse' ? provisional : payload.stats);
        } else if (payload.state === 'pending') schedulePendingRetry();
        return payload;
      }).finally(() => {
        signal?.removeEventListener('abort', abort);
        if (sourcePromise === promise) sourcePromise = null;
      });
    sourcePromise = promise;
    return promise;
  }

  async function loadModel({ signal, refresh }) {
    if (publicState(data) === 'error') throw new Error('This tool failed; there is no completed file change.');
    const payload = await loadSource(signal, refresh);
    if (!payload.ok) throw Object.assign(new Error(payload.error || payload.notice || 'The historical diff is unavailable.'), { code: payload.code });
    if (payload.state === 'pending') throw new Error('The result is still being saved. Retry in a moment.');
    if (payload.state !== 'ready') {
      const input = data.block.input;
      const edits = Array.isArray(input.edits) ? input.edits.map(edit => ({ oldText: edit.old_string, newText: edit.new_string })) :
        [{ oldText: input.old_string, newText: input.new_string }];
      if (edits.every(edit => typeof edit.oldText === 'string' && typeof edit.newText === 'string')) {
        return getDiffModel({ source: 'tool-input', filePath: input.file_path, edits, lineNumbers: 'relative',
          notice: 'No saved context; showing the replacement only.' }, { signal });
      }
      if (data.block.name === 'Write' && typeof input.content === 'string') {
        return getDiffModel({ source: 'tool-input', filePath: input.file_path, proposedText: input.content,
          notice: 'No saved original; showing the requested contents, so line counts are unverified.' }, { signal });
      }
      throw new Error('No saved file snapshot. Open the current file to inspect it.');
    }
    return getDiffModel(payload, { key, signal });
  }

  function ensureView() {
    if (view) return;
    view = createDiffPreview(diff, { filePath: data.block.input.file_path, loadModel, language: options.language,
      onStats: stats => headline.setCounts(stats || provisional) });
  }

  function setOpen(value) {
    if (disposed) return;
    open = value; rememberChoice(key, value);
    const token = ++transitionGeneration;
    clearTimeout(closeTimer);
    if (!value) {
      view?.rememberPosition();
      if (body.contains(document.activeElement)) headline.toggle.focus({ preventScroll: true });
    }
    headline.setOpen(value);
    root.dataset.incipitToolCollapsed = String(!value);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (value) {
      body.hidden = false; body.inert = false; ensureView(); view.setVisible(true);
      requestAnimationFrame(() => { if (token === transitionGeneration) body.dataset.incipitExpanded = '1'; });
    } else {
      if (body.contains(document.activeElement)) headline.toggle.focus({ preventScroll: true });
      body.inert = true; body.dataset.incipitExpanded = '0';
      const finish = () => { if (token === transitionGeneration) { body.hidden = true; view?.setVisible(false); sourcePayload = null; } };
      if (reduced) finish(); else closeTimer = setTimeout(finish, 260);
    }
  }

  const controller = {
    kind: 'file',
    toolId: data.block.id,
    intersecting: !visibilityObserver,
    releaseSource() { if (!open) sourcePayload = null; },
    prefetch() {
      if (disposed || publicState(data) !== 'complete' || sourceKnown || sourcePromise) return;
      loadSource().catch(error => {
        if (error.name !== 'AbortError') globalThis.__incipitHealth?.set?.('tool.diffSource', 'degraded', { reason: error.message });
      });
    },
    update(next) {
      const previousState = publicState(data);
      const previousPath = data.block.input.file_path;
      data = next;
      const nextVersion = inputVersion(next.block);
      if (!sameVersion(version, nextVersion)) {
        version = nextVersion; revision++; sourcePayload = null; sourceKnown = false; sourceController?.abort(); sourcePromise = null;
        clearTimeout(pendingTimer); pendingTimer = null; pendingAttempts = 0;
        provisional = options.estimateStats?.(next.block) || null;
        headline.setCounts(provisional);
        if (previousPath !== next.block.input.file_path) { view?.dispose(); view = null; diff.replaceChildren(); }
        else view?.invalidate();
      }
      headline.update(next, true);
      const failed = publicState(next) === 'error';
      const content = next.result && next.result.content;
      const message = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block && block.type === 'text').map(block => block.text || '').join('\n') : '';
      toolError.hidden = !failed;
      if (failed) {
        headline.setCounts(null);
        const text = message || 'The file operation failed. Inspect the tool result before retrying.';
        if (toolError.textContent !== text) toolError.textContent = text;
        if (previousState !== 'error') { sourceController?.abort(); sourcePayload = null; view?.invalidate(); }
      }
      if (!headline.header.isConnected) root.insertBefore(headline.header, root.firstChild);
      if (!toolError.isConnected) root.appendChild(toolError);
      if (!body.isConnected) root.appendChild(body);
      if (open) {
        ensureView();
        if (previousPath !== next.block.input.file_path) view.setVisible(true);
        else if (previousState !== 'complete' && publicState(next) === 'complete' && !sourcePayload) view.invalidate();
      }
      if (controller.intersecting) controller.prefetch();
    },
    dispose() {
      if (disposed) return;
      disposed = true; revision++; transitionGeneration++; clearTimeout(closeTimer); clearTimeout(pendingTimer);
      sourceController?.abort(); view?.dispose(); visibilityObserver?.unobserve(root);
      nativeStateObserver.disconnect();
      headline.header.remove(); body.remove(); toolError.remove(); delete root.dataset.incipitFileTool;
      clearRootMarks(root);
      controllers.delete(root);
      markActivityDirty(root);
    },
  };
  if (open) setOpen(true);
  visibilityObserver?.observe(root);
  return controller;
}

/**
 * Return true only when the recognized file-tool island is completely owned here.
 * `options.expandable(data)` tells generic rows whether the host body or a grep
 * expansion gives them anything to open; rows with a file detail always can.
 */
export function enhanceToolCard(root, data, options) {
  if (!data?.block || data.block.type !== 'tool_use' || typeof data.block.name !== 'string' || !data.block.name ||
      !data.block.input || typeof data.block.input !== 'object' || Array.isArray(data.block.input) || !options.summary) {
    controllers.get(root)?.dispose();
    return false;
  }
  const isFile = FILE_CHANGES.has(data.block.name) && typeof data.block.id === 'string' &&
    typeof data.block.input?.file_path === 'string' && data.block.input.file_path;
  let controller = controllers.get(root);
  if (controller && (controller.toolId !== data.block.id || (controller.kind === 'file') !== !!isFile)) {
    controller.dispose(); controller = null;
  }
  if (isFile) {
    if (!controller) { controller = createFileCard(root, data, options); controllers.set(root, controller); }
    controller.update(data);
    return true;
  }
  if (!controller) {
    if (!root.dataset.incipitToolCollapsed) root.dataset.incipitToolCollapsed = 'true';
    const headline = buildHeadline(root, { toggle: () => {
      options.toggle?.();
      headline.setOpen(root.dataset.incipitToolCollapsed !== 'true');
    } });
    const nativeStateObserver = observeNativeState(root, options.onNativeChange);
    controller = {
      kind: 'generic',
      toolId: data.block.id,
      prefetch() {},
      update(next) {
        headline.update(next, options.expandable ? options.expandable(next) : true);
        headline.setOpen(root.dataset.incipitToolCollapsed === 'false');
      },
      dispose() {
        nativeStateObserver.disconnect(); headline.header.remove(); clearRootMarks(root);
        controllers.delete(root); markActivityDirty(root);
      },
    };
    controllers.set(root, controller);
  }
  controller.update(data);
  return false;
}

export function sweepToolCards() {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    for (const [root, controller] of controllers) if (!root.isConnected) controller.dispose();
  }, 250);
}
