import { configureDiffSource, fetchToolDiff, clearDiffSource } from './diff/source.js';
import { getDiffModel, clearDiffModels } from './diff/client.js';
import { createDiffPreview, closeFullDiff } from './diff/view.js';
import { subscribe } from './runtime_kernel.js';
import { markActivityDirty } from './activity_groups.js';
import { FILE_CHANGES, publicState, buildHeadline } from './tool_headline.js';
import { initAgentActivities, clearAgentActivities, createAgentActivityCard, isAgentActivityTool } from './agent_activity.js';

const controllers = new Map();
const foldChoices = new Map();
let initialized = false;
let identityProvider = null;
let visibilityObserver = null;
let activeSession = '';
let activeCwd = '';
let sweepTimer = null;

function node(tag, attr, text) {
  const value = document.createElement(tag);
  if (attr) value.setAttribute(attr, '');
  if (text !== undefined) value.textContent = text;
  return value;
}

function identity() {
  try { return identityProvider ? identityProvider() : {}; }
  catch (_) { return {}; }
}

function inputVersion(block) {
  const input = block.input || {};
  return [block.id, block.name, input.file_path, input.old_string, input.new_string, input.content,
    input.replace_all, ...(Array.isArray(input.edits) ? input.edits.flatMap(edit =>
      [edit?.old_string, edit?.new_string, edit?.replace_all]) : [])];
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

function resetSession(sessionId, cwd = '') {
  if (sessionId === activeSession && cwd === activeCwd) return;
  if (sessionId === activeSession && !activeCwd && cwd) {
    activeCwd = cwd;
    for (const controller of controllers.values()) controller.identityReady?.();
    return;
  }
  activeSession = sessionId || '';
  activeCwd = cwd;
  for (const controller of [...controllers.values()]) controller.dispose();
  controllers.clear(); foldChoices.clear(); clearDiffSource(); clearDiffModels(); closeFullDiff();
  clearAgentActivities();
}

export function initToolCards(options) {
  identityProvider = options.getIdentity;
  configureDiffSource(options.getApi);
  initAgentActivities(options);
  if (initialized) return;
  initialized = true;
  activeSession = identity().sessionId || '';
  activeCwd = identity().cwd || '';
  if (typeof IntersectionObserver === 'function') {
    visibilityObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const controller = controllers.get(entry.target);
        if (!controller) continue;
        controller.intersecting = entry.isIntersecting;
        controller.setVisible?.(entry.isIntersecting);
        if (entry.isIntersecting) controller.prefetch();
        else controller.releaseSource?.();
      }
    }, { rootMargin: '240px' });
  }
  subscribe('sessionChanged', state => resetSession(state.sessionId || '', state.cwd || ''));
  subscribe('executionSettled', () => {
    for (const controller of controllers.values()) controller.refreshCounts?.();
  });
  window.addEventListener('pagehide', () => resetSession(''));
}

function clearRootMarks(root) {
  delete root.dataset.incipitToolHeadline; delete root.dataset.incipitToolCollapsed; delete root.dataset.incipitToolKind;
  delete root.dataset.incipitToolName; delete root.dataset.incipitToolId; delete root.dataset.incipitToolExpandable;
  root.removeAttribute('data-incipit-tool-state');
}

function createFileCard(root, initial, options) {
  let data = initial;
  let renderedState = publicState(initial);
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
  let verifiedCounts = null, retryExhausted = false;
  const PENDING_RETRY_MS = [400, 800, 1600, 3200, 6400, 12800];
  const body = node('div', 'data-incipit-file-tool-body');
  const inner = node('div', 'data-incipit-file-tool-inner');
  const diff = node('div');
  inner.appendChild(diff); body.appendChild(inner); body.hidden = !open; body.inert = !open;
  root.dataset.incipitFileTool = '1';
  root.dataset.incipitToolCollapsed = String(!open);
  const headline = buildHeadline(root, { getIdentity: identity, fileAction: options.fileAction, onRetryPaths: options.onNativeChange, toggle: () => setOpen(!open) });
  const nativeStateObserver = observeNativeState(root, options.onNativeChange);
  const toolError = node('div', 'data-incipit-tool-error'); toolError.hidden = true;
  root.appendChild(toolError);
  root.appendChild(body);
  const bodyId = 'incipit-tool-preview-' + Math.random().toString(36).slice(2);
  body.id = bodyId; headline.toggle.setAttribute('aria-controls', bodyId);
  headline.setOpen(open);
  headline.setCounts(provisional);
  const retryCounts = node('button', 'data-incipit-tool-counts-retry', 'Retry counts');
  retryCounts.type = 'button'; retryCounts.hidden = true;
  retryCounts.addEventListener('click', event => {
    event.stopPropagation(); pendingAttempts = 0; retryExhausted = false; sourceKnown = false; controller.prefetch();
  });
  headline.row.append(retryCounts);
  body.addEventListener('click', event => event.stopPropagation());

  function schedulePendingRetry() {
    if (disposed || pendingTimer || publicState(data) !== 'complete') return;
    retryExhausted = pendingAttempts >= PENDING_RETRY_MS.length;
    retryCounts.hidden = !!(verifiedCounts || provisional) || !retryExhausted;
    if (retryExhausted || !controller.intersecting) return;
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
        if (disposed || epoch !== revision || controller.signal.aborted || publicState(data) === 'error') throw Object.assign(new Error('Diff view changed.'), { name: 'AbortError' });
        if (payload.state === 'ready') {
          sourceKnown = true;
          if (open) sourcePayload = payload;
          verifiedCounts = payload.quality === 'coarse' ? null : payload.stats;
          headline.setCounts(verifiedCounts || provisional);
          retryCounts.hidden = !!(verifiedCounts || provisional);
        } else schedulePendingRetry();
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
    view = createDiffPreview(diff, { filePath: data.block.input.file_path, loadModel,
      onStats: stats => headline.setCounts(verifiedCounts || stats || provisional) });
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
    if (value) {
      body.hidden = false; body.inert = false; ensureView(); view.setVisible(true);
      requestAnimationFrame(() => { if (token === transitionGeneration) body.dataset.incipitExpanded = '1'; });
    } else {
      if (body.contains(document.activeElement)) headline.toggle.focus({ preventScroll: true });
      body.inert = true; body.dataset.incipitExpanded = '0';
      const finish = () => { if (token === transitionGeneration) { body.hidden = true; view?.setVisible(false); sourcePayload = null; } };
      closeTimer = setTimeout(finish, 260);
    }
  }

  const controller = {
    kind: 'file',
    identityReady() {
      revision++; sourceKnown = false; sourcePayload = null; sourceController?.abort(); sourcePromise = null;
      clearTimeout(pendingTimer); pendingTimer = null; pendingAttempts = 0;
      retryExhausted = false;
      verifiedCounts = null; headline.setCounts(provisional); retryCounts.hidden = true;
      headline.invalidatePaths(); view?.invalidate(); options.onNativeChange?.();
    },
    toolId: data.block.id,
    intersecting: !visibilityObserver,
    releaseSource() { if (!open) sourcePayload = null; },
    refreshCounts() {
      if (sourceKnown || !controller.intersecting) return;
      clearTimeout(pendingTimer); pendingTimer = null; pendingAttempts = 0; retryExhausted = false; controller.prefetch();
    },
    prefetch() {
      if (disposed || publicState(data) !== 'complete' || sourceKnown || sourcePromise || pendingTimer || retryExhausted) return;
      retryCounts.hidden = true;
      loadSource().catch(error => {
        if (error.name !== 'AbortError') {
          schedulePendingRetry();
          globalThis.__incipitHealth?.set?.('tool.diffSource', 'degraded', { reason: error.message });
        }
      });
    },
    update(next) {
      const previousState = renderedState;
      const previousPath = version[2];
      data = next;
      renderedState = publicState(next);
      const nextVersion = inputVersion(next.block);
      if (!sameVersion(version, nextVersion)) {
        version = nextVersion; revision++; sourcePayload = null; sourceKnown = false; sourceController?.abort(); sourcePromise = null;
        clearTimeout(pendingTimer); pendingTimer = null; pendingAttempts = 0;
        retryExhausted = false;
        verifiedCounts = null; retryCounts.hidden = true;
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
        headline.setCounts(null); retryCounts.hidden = true;
        const text = message || 'The file operation failed. Inspect the tool result before retrying.';
        if (toolError.textContent !== text) toolError.textContent = text;
        if (previousState !== 'error') {
          revision++; sourceController?.abort(); sourcePromise = null; sourcePayload = null; sourceKnown = false;
          clearTimeout(pendingTimer); pendingTimer = null; pendingAttempts = 0; retryExhausted = false;
          view?.invalidate();
        }
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
 * Return true when the recognized file or agent presentation is owned here.
 * `options.expandable(data)` tells generic rows whether the host body or a grep
 * expansion gives them anything to open; rows with a file detail always can.
 */
export function enhanceToolCard(root, data, options) {
  if (!data?.block || data.block.type !== 'tool_use' || typeof data.block.name !== 'string' || !data.block.name ||
      !data.block.input || typeof data.block.input !== 'object' || Array.isArray(data.block.input) || !options.summary) {
    controllers.get(root)?.dispose();
    return false;
  }
  if (isAgentActivityTool(data.block.name) && root.querySelector('[role="dialog"], [data-incipit-ask-request], [data-incipit-permission-surface], [class*="permissionRequest"]')) {
    controllers.get(root)?.dispose();
    return false;
  }
  const isFile = FILE_CHANGES.has(data.block.name) && typeof data.block.id === 'string' &&
    typeof data.block.input?.file_path === 'string' && data.block.input.file_path;
  const isAgent = isAgentActivityTool(data.block.name) && typeof data.block.id === 'string';
  let controller = controllers.get(root);
  const wantedKind = isAgent ? 'agent' : isFile ? 'file' : 'generic';
  if (controller && (controller.toolId !== data.block.id || controller.kind !== wantedKind)) {
    controller.dispose(); controller = null;
  }
  if (isAgent) {
    if (!controller) {
      controller = createAgentActivityCard(root, data, { ...options, onDispose: () => { visibilityObserver?.unobserve(root); controllers.delete(root); clearRootMarks(root); markActivityDirty(root); } });
      controllers.set(root, controller); visibilityObserver?.observe(root);
      if (!visibilityObserver) controller.prefetch();
    }
    controller.update(data);
    return true;
  }
  if (isFile) {
    if (!controller) { controller = createFileCard(root, data, options); controllers.set(root, controller); }
    controller.update(data);
    return true;
  }
  if (!controller) {
    if (!root.dataset.incipitToolCollapsed) root.dataset.incipitToolCollapsed = 'true';
    const headline = buildHeadline(root, { getIdentity: identity, fileAction: options.fileAction, onRetryPaths: options.onNativeChange, toggle: () => {
      options.toggle?.();
      headline.setOpen(root.dataset.incipitToolCollapsed !== 'true');
    } });
    const nativeStateObserver = observeNativeState(root, options.onNativeChange);
    controller = {
      kind: 'generic',
      identityReady() { headline.invalidatePaths(); options.onNativeChange?.(); },
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
