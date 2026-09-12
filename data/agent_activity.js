import { buildHeadline, publicState } from './tool_headline.js';
import { configureAgentActivitySource, fetchAgentActivity, clearAgentActivitySource } from './agent_activity_source.js';
import { initTaskActivityState, bindTaskSignal, getTaskActivity, subscribeTaskActivity } from './agent_activity_state.js';
import { createAgentHistoryView } from './agent_history_view.js';
import { createWorkflowActivityView, workflowModel } from './workflow_activity.js';
import { createAgentRichText } from './agent_rich_text.js';
import { element, action, activityStatus, statusLabel, usageLabel, errorView, foldBody, sourceAction } from './agent_activity_dom.js';

const choices = new Map();
const cards = new Set();
let configuration = {};
let visibilityBound = false;
let viewSequence = 0;

export function isAgentActivityTool(name) { return ['Agent', 'Task', 'Workflow', 'RunWorkflow'].includes(name); }

export function initAgentActivities(options) {
  configuration = options;
  configureAgentActivitySource(options.getApi); initTaskActivityState();
  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => { for (const card of cards) card.visibilityChanged(); });
  }
}

export function clearAgentActivities() { choices.clear(); clearAgentActivitySource(); }

function remember(key, value) {
  choices.delete(key); choices.set(key, value);
  while (choices.size > 1000) choices.delete(choices.keys().next().value);
}

/** Own only this tool's presentation; its original React subtree remains mounted. */
export function createAgentActivityCard(root, initial, options = {}) {
  let data = initial, activity = null, responseError = null, live = null, taskId = '', state = 'unknown';
  let scope = options.scope || { ...configuration.getIdentity?.(), toolUseId: initial.block.id, ancestors: [] };
  let key = JSON.stringify([scope.sessionId, scope.ancestors, scope.toolUseId]);
  const workflow = ['Workflow', 'RunWorkflow'].includes(data.block.name);
  let disposed = false, desiredVisible = true, visible = document.visibilityState !== 'hidden', loadController = null, loadPromise = null, generation = 0, renderFrame = 0, timer = null, settlingReads = 0;
  let contentView = null, bodyMode = '', lastFallback = '', taskCleanup = null, toolCleanup = null, statusSignature = '';
  let reloadPending = false;
  root.setAttribute('data-incipit-agent-card', workflow ? 'workflow' : 'agent');
  const headline = buildHeadline(root, { getIdentity: () => scope, toggle: () => toggle(!fold.open) });
  const body = element('div', 'data-incipit-agent-body');
  const toolbar = element('div', 'data-incipit-agent-toolbar');
  const refresh = action('Refresh', () => load(true)); toolbar.append(refresh);
  const status = element('div', 'data-incipit-agent-card-status');
  const content = element('div', 'data-incipit-agent-card-content');
  body.append(toolbar, status, content);
  const fold = foldBody(headline.toggle, { onOpen: () => { renderBody(); contentView?.setActive(true); load(); }, onClose: pause,
    onClosed: () => { contentView?.dispose(); contentView = null; content.replaceChildren(); bodyMode = ''; lastFallback = ''; } });
  fold.inner.append(body); root.append(fold.root);
  fold.root.id = 'incipit-agent-view-' + (++viewSequence); headline.toggle.setAttribute('aria-controls', fold.root.id);

  function requestRender() {
    if (!disposed && !renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
  }
  function watch() {
    live = getTaskActivity(scope.sessionId, scope.toolUseId, taskId);
    requestRender();
    if (live && ['completed', 'failed', 'killed', 'stopped'].includes(live.status) && fold.open) { settlingReads = 0; load(true); }
  }
  function bindScope() {
    toolCleanup?.(); toolCleanup = null;
    if (scope.sessionId) toolCleanup = subscribeTaskActivity(scope.sessionId, scope.toolUseId, watch);
    const session = configuration.getSession?.();
    if (session && scope.sessionId) bindTaskSignal(session, scope.sessionId);
  }
  bindScope();

  function toggle(open) {
    remember(key, open); headline.setOpen(open); root.dataset.incipitToolCollapsed = String(!open); fold.setOpen(open);
  }

  function pause() {
    clearTimeout(timer); generation++; loadController?.abort(); loadPromise = null; reloadPending = false; contentView?.setActive(false);
  }

  function updateState() {
    live = getTaskActivity(scope.sessionId, scope.toolUseId, taskId);
    const savedState = activityStatus(activity?.status);
    if (workflow && activity?.workflow && ['complete', 'error', 'stopped', 'paused'].includes(savedState)) state = savedState;
    else if (live && activityStatus(live.status) !== 'unknown') state = activityStatus(live.status);
    else if (activity) state = activityStatus(activity.status);
    else if (publicState(data) === 'error') state = 'error';
    else if (publicState(data) === 'running') state = 'running';
    else state = 'unknown';
  }

  function viewOptions() {
    const { onDispose, ...childOptions } = options;
    return { ...childOptions, key, choices: { get: value => choices.get(value), set: remember }, isRunning: () => state === 'running' || state === 'queued',
      createInvocation: (target, value, nested) => createAgentActivityCard(target, value, { ...childOptions, ...nested, onDispose: undefined }) };
  }

  function renderFallback() {
    const input = data.block.input?.prompt || data.block.input?.script || '';
    const output = data.result?.content;
    const text = typeof output === 'string' ? output : output ? JSON.stringify(output, null, 2) : '';
    const signature = JSON.stringify([input, text, responseError?.error, state]);
    if (lastFallback === signature) return; lastFallback = signature;
    content.replaceChildren();
    if (input) {
      const details = element('details', 'data-incipit-agent-raw-details'); details.append(element('summary', '', workflow ? 'Script' : 'Task input'), element('pre', 'data-incipit-agent-raw', input)); content.append(details);
    }
    if (text) {
      const details = element('details', 'data-incipit-agent-raw-details'); details.append(element('summary', '', workflow ? 'Launch details' : 'Recorded result'), createAgentRichText(text, viewOptions())); content.append(details);
    }
    content.append(element('div', 'data-incipit-agent-notice', state === 'running' ? 'Waiting for the agent history to be recorded.' : 'No detailed agent history is available for this call.'));
  }

  function renderBody() {
    if (!fold.open || disposed || !visible) return;
    const wanted = workflow ? 'workflow' : activity?.agents?.length === 1 ? 'history:' + activity.agents[0].agentId : activity?.agents?.length > 1 ? 'agents' : 'fallback';
    toolbar.hidden = wanted.startsWith('history:');
    if (bodyMode !== wanted) {
      contentView?.dispose(); contentView = null; content.replaceChildren(); bodyMode = wanted; lastFallback = '';
      if (workflow) { contentView = createWorkflowActivityView(scope, viewOptions()); content.append(contentView.root); }
      else if (wanted.startsWith('history:')) {
        contentView = createAgentHistoryView({ ...scope, agentId: activity.agents[0].agentId }, viewOptions()); content.append(contentView.root);
      } else if (wanted === 'agents') {
        const recorded = { agents: activity.agents, workflow: null };
        contentView = createWorkflowActivityView(scope, viewOptions()); content.append(contentView.root); contentView.update(recorded, null);
      }
    }
    if (workflow) contentView?.update(activity, live, { input: data.block.input, result: data.result?.content });
    else if (wanted === 'fallback') renderFallback();
    const nextStatus = JSON.stringify([responseError?.error || responseError?.message, !!loadPromise && !activity, state, activity?.notice]);
    if (nextStatus !== statusSignature) {
      statusSignature = nextStatus; status.replaceChildren();
      if (responseError) status.append(errorView(responseError, () => load(true)));
      else if (loadPromise && !activity) status.append(element('span', 'data-incipit-agent-notice', 'Loading recorded activity…'));
      else if (state === 'unknown') status.append(element('span', 'data-incipit-agent-notice', 'The host has not recorded the current task status.'));
      else if (['waiting', 'paused', 'stopped'].includes(state)) status.append(element('span', 'data-incipit-agent-notice', state === 'waiting' ? 'Waiting for input. Use the Claude Code permission or question prompt to continue.' : statusLabel(state)));
      if (activity?.notice) status.append(element('span', 'data-incipit-agent-notice', activity.notice));
    }
    const source = activity?.transcriptPath || responseError?.transcriptPath;
    if (source && !toolbar.querySelector('[data-incipit-agent-open-source]')) {
      const open = sourceAction(source, options); if (open) { open.setAttribute('data-incipit-agent-open-source', ''); toolbar.append(open); }
    }
  }

  function render() {
    if (disposed) return;
    const previousState = state;
    updateState();
    if (state !== previousState && !['running', 'queued'].includes(state) && fold.open) contentView?.refresh?.();
    const input = data.block.input || {};
    const description = activity?.title || input.description || input.name || (input.scriptPath ? String(input.scriptPath).split(/[/\\]/).pop() : '') || live?.title || '';
    const label = workflow ? state === 'running' ? 'Running workflow' : 'Workflow' : state === 'running' ? 'Running agent' : state === 'complete' ? 'Ran agent' : state === 'queued' ? 'Queued agent' : 'Agent';
    let detail = usageLabel(live?.usage);
    if (workflow) {
      const counts = workflowModel(activity, live).counts;
      detail = counts.total ? `${counts.total} agents${counts.running ? ' · ' + counts.running + ' running' : ''}${counts.error ? ' · ' + counts.error + ' failed' : ''}` : '';
    }
    headline.update(data, true, { state, label, description, detail,
      ariaLabel: `${label}${description ? ': ' + description : ''} · ${statusLabel(state)}${detail ? ' · ' + detail : ''}`,
      stateText: ['error', 'waiting', 'paused', 'stopped'].includes(state) ? statusLabel(state) : workflow && state === 'complete' ? 'Completed' : '' });
    if (root.dataset.incipitAgentState !== state) root.dataset.incipitAgentState = state;
    if (headline.toggle.getAttribute('aria-busy') !== String(state === 'running')) headline.toggle.setAttribute('aria-busy', String(state === 'running'));
    renderBody();
  }

  function schedule() {
    clearTimeout(timer);
    const pendingCompletion = !['running', 'queued'].includes(state) && (workflow ? !activity?.workflow : !activity?.agents?.length) && settlingReads < 3;
    const needsLiveLookup = state === 'running' && (workflow ? !activity?.runId || !live?.progress : !activity?.agents?.length);
    if (!disposed && visible && fold.open && (needsLiveLookup || pendingCompletion)) timer = setTimeout(() => {
      if (document.visibilityState === 'hidden') { schedule(); return; }
      settlingReads++; load(true);
    }, 2000);
  }

  function load(force = false) {
    if (disposed || !visible) return loadPromise;
    if (loadPromise) { if (force) reloadPending = true; return loadPromise; }
    if (activity && !force) return loadPromise;
    if (!scope.sessionId || !scope.cwd) { responseError = { state: 'unavailable', error: 'The session identity is not available yet.' }; render(); return; }
    const token = ++generation; loadController?.abort(); loadController = new AbortController();
    loadPromise = fetchAgentActivity({ ...scope, op: 'overview' }, { signal: loadController.signal }).then(response => {
      if (disposed || token !== generation) return;
      if (!response.ok) throw response;
      activity = response.activity; responseError = null;
      if (activity.taskId && activity.taskId !== taskId) {
        taskId = activity.taskId; taskCleanup?.(); taskCleanup = subscribeTaskActivity(scope.sessionId, taskId, watch);
      }
    }).catch(error => {
      if (disposed || token !== generation || error.name === 'AbortError') return;
      responseError = error;
    }).finally(() => {
      if (disposed || token !== generation) return;
      loadPromise = null; render();
      if (reloadPending) { reloadPending = false; load(true); }
      else schedule();
    });
    renderBody(); return loadPromise;
  }

  const controller = {
    kind: 'agent', toolId: initial.block.id, intersecting: false, root,
    update(next) { data = next; render(); },
    prefetch() { load(); },
    identityReady() {
      if (!options.scope) {
        const previousKey = key; scope = { ...configuration.getIdentity?.(), toolUseId: data.block.id, ancestors: [] };
        key = JSON.stringify([scope.sessionId, scope.ancestors, scope.toolUseId]);
        if (choices.has(previousKey)) remember(key, choices.get(previousKey));
        bindScope();
      }
      load(true);
    },
    setVisible(value) {
      desiredVisible = value;
      const next = value && document.visibilityState !== 'hidden';
      if (next === visible) return;
      visible = next; if (!next) pause(); else { render(); contentView?.setActive(fold.open); if (fold.open) load(true); }
    },
    visibilityChanged() { controller.setVisible(desiredVisible); },
    dispose() {
      if (disposed) return;
      disposed = true; cards.delete(controller); pause(); fold.dispose(); contentView?.dispose(); toolCleanup?.(); taskCleanup?.();
      if (renderFrame) cancelAnimationFrame(renderFrame);
      headline.header.remove(); fold.root.remove(); root.removeAttribute('data-incipit-agent-card'); root.removeAttribute('data-incipit-agent-state');
      options.onDispose?.();
    },
  };
  cards.add(controller);
  render(); headline.setOpen(false); root.dataset.incipitToolCollapsed = 'true';
  if (choices.get(key) === true) { headline.setOpen(true); root.dataset.incipitToolCollapsed = 'false'; fold.setOpen(true, false); }
  return controller;
}
