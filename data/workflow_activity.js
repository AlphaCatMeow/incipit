import { buildHeadline } from './tool_headline.js';
import { createAgentHistoryView } from './agent_history_view.js';
import { normalizeWorkflowProgress } from './agent_activity_state.js';
import { createAgentRichText } from './agent_rich_text.js';
import { element, action, activityStatus, statusLabel, usageLabel, setText, foldBody, copyAction } from './agent_activity_dom.js';

function agentState(agent) {
  if (agent.skipped) return 'stopped';
  if (agent.state === 'start') return agent.startedAt === null ? 'queued' : 'running';
  return activityStatus(agent.state);
}

/** Group only explicit phase indices; never infer membership from arrival order. */
export function workflowModel(activity, task) {
  const recorded = activity?.workflow;
  const recordedState = activityStatus(activity?.status);
  const savedTerminal = recorded && ['complete', 'error', 'stopped', 'paused'].includes(recordedState);
  const ownerState = savedTerminal ? recordedState : activityStatus(task?.status || activity?.status);
  let progress = [], progressError = '';
  try { progress = (savedTerminal ? normalizeWorkflowProgress(recorded.progress || []) : task?.progress || normalizeWorkflowProgress(recorded?.progress || [])) || []; }
  catch (error) { progressError = error.message; }
  const phases = new Map(), agents = [];
  for (const row of progress) {
    if (row.type === 'workflow_phase') phases.set(row.index, { key: 'phase:' + row.index, index: row.index, title: row.title || 'Phase ' + row.index, agents: [] });
  }
  for (const row of progress) if (row.type === 'workflow_agent') {
    const key = row.phaseIndex;
    if (!phases.has(key)) phases.set(key, { key: key === null ? 'unassigned' : 'phase:' + key, index: key, title: row.phaseTitle || (key === null ? 'Agents' : 'Phase ' + key), agents: [] });
    let displayState = agentState(row);
    if (['running', 'queued'].includes(displayState) && !['running', 'queued'].includes(ownerState)) displayState = 'unknown';
    const agent = { ...row, displayState }; phases.get(key).agents.push(agent); agents.push(agent);
  }
  for (const declared of recorded?.phases || []) {
    const title = typeof declared === 'string' ? declared : declared?.title;
    if (title && ![...phases.values()].some(phase => phase.title === title)) phases.set('declared:' + title, { key: 'declared:' + title, title, agents: [], index: null });
  }
  if (!agents.length && activity?.agents?.length) {
    const phase = { key: 'recorded', title: 'Recorded agents', index: null, agents: [] };
    for (const [index, agent] of activity.agents.entries()) {
      const row = { ...agent, index: index + 1, label: agent.description || agent.agentType || 'Agent ' + (index + 1), displayState: 'unknown' };
      phase.agents.push(row); agents.push(row);
    }
    phases.set('recorded', phase);
  }
  const counts = { total: agents.length, running: 0, queued: 0, complete: 0, error: 0, stopped: 0, unknown: 0 };
  for (const agent of agents) counts[agent.displayState in counts ? agent.displayState : 'unknown']++;
  const recordedUsage = { tokens: recorded?.tokens, toolCalls: recorded?.toolCalls, durationMs: recorded?.durationMs };
  const usage = savedTerminal ? recordedUsage : task?.usage || recordedUsage;
  return { phases: [...phases.values()].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity)), counts, usage, state: ownerState,
    error: task?.progressError || progressError || recorded?.error || '', result: recorded?.result, resultTruncated: recorded?.resultTruncated === true,
    logs: recorded?.logs || [], logsTruncated: recorded?.logsTruncated === true, snapshotPath: recorded?.snapshotPath };
}

function countLabel(agents) {
  const counts = new Map();
  for (const agent of agents) counts.set(agent.displayState, (counts.get(agent.displayState) || 0) + 1);
  return ['running', 'queued', 'complete', 'error', 'stopped', 'unknown'].filter(key => counts.has(key)).map(key =>
    counts.get(key) + ' ' + ({ running: 'running', queued: 'queued', complete: 'done', error: 'failed', stopped: 'stopped', unknown: 'recorded' }[key])).join(' · ') || 'No agents recorded';
}

function createWorkflowAgent(initial, scope, options, phaseKey) {
  let agent = initial, history = null, agentId = '', disposed = false;
  const root = element('div', 'data-incipit-workflow-agent'); root.setAttribute('data-incipit-agent-card', ''); root.setAttribute('data-incipit-tool-use', '');
  const key = options.key + ':' + phaseKey + ':agent:' + agent.index;
  const data = () => ({ block: { type: 'tool_use', id: key, name: 'Agent', input: { description: agent.label || 'Agent ' + agent.index } } });
  const headline = buildHeadline(root, { getIdentity: () => scope, toggle: () => toggle(!fold.open) });
  const fold = foldBody(headline.toggle, { onOpen: show, onClose: () => history?.setActive(false), onClosed: () => { history?.dispose(); history = null; fold.inner.replaceChildren(); } });
  root.append(fold.root);

  function toggle(open) { options.choices.set(key, open); headline.setOpen(open); fold.setOpen(open); }
  function show() {
    if (disposed) return;
    if (agent.agentId && scope.toolUseId) {
      if (!history || agentId !== agent.agentId) {
        history?.dispose(); agentId = agent.agentId; fold.inner.replaceChildren();
        if (agent.attempt > 1) fold.inner.append(element('div', 'data-incipit-agent-notice', `Attempt ${agent.attempt}${agent.lastAttemptReason ? ' · ' + agent.lastAttemptReason : ''}`));
        history = createAgentHistoryView({ ...scope, agentId }, { ...options, isRunning: () => agent.displayState === 'running' });
        fold.inner.append(history.root);
      } else history.setActive(true);
    } else {
      fold.inner.replaceChildren(element('div', 'data-incipit-agent-notice', agent.displayState === 'queued' ? 'Queued. Detailed activity appears when this agent starts.' : 'The host has not recorded an agent transcript for this step.'));
      if (agent.promptPreview) {
        const prompt = element('details', 'data-incipit-agent-raw-details'); prompt.append(element('summary', '', 'Task preview'), createAgentRichText(agent.promptPreview)); fold.inner.append(prompt);
      }
      if (agent.resultPreview) fold.inner.append(createAgentRichText(agent.resultPreview));
    }
    if (agent.error) {
      let error = fold.inner.querySelector(':scope > [data-incipit-agent-error]');
      if (!error) { error = element('div', 'data-incipit-agent-error'); fold.inner.prepend(error); }
      setText(error, agent.error);
    }
  }

  const controller = { root,
    update(next) {
      const oldId = agent.agentId, oldState = agent.displayState; agent = next;
      const state = agent.displayState;
      const label = agent.label || 'Agent ' + agent.index;
      const detail = usageLabel({ tokens: agent.tokens, toolCalls: agent.toolCalls, durationMs: agent.durationMs });
      headline.update(data(), true, { state, label, description: '',
        ariaLabel: `${label} · ${statusLabel(state)}${detail ? ' · ' + detail : ''}`,
        stateText: agent.cached ? 'Cached' : agent.blocked ? 'Blocked' : agent.skipped ? 'Skipped' : state === 'unknown' ? 'Recorded' : state === 'complete' ? 'Done' : statusLabel(state), detail });
      if (root.dataset.incipitAgentState !== state) root.dataset.incipitAgentState = state;
      headline.toggle.title = `${label} · ${statusLabel(state)}${detail ? ' · ' + detail : ''}`;
      if (fold.open && (oldId !== agent.agentId || oldState !== state || !history)) {
        show();
        if (oldState !== state && !['running', 'queued'].includes(state)) history?.refresh();
      }
    },
    setActive(value) { if (fold.open) history?.setActive(value); },
    dispose() { disposed = true; fold.dispose(); history?.dispose(); },
  };
  controller.update(initial);
  if (options.choices.get(key)) { headline.setOpen(true); fold.setOpen(true, false); }
  return controller;
}

/** A workflow's phase tree is published with parent headings before any child rows. */
export function createWorkflowActivityView(scope, options) {
  const root = element('section', 'data-incipit-workflow');
  const summary = element('div', 'data-incipit-workflow-summary');
  const total = element('span', 'data-incipit-workflow-total');
  const usage = element('span', 'data-incipit-workflow-usage'); summary.append(total, usage);
  const notice = element('div', 'data-incipit-workflow-notice');
  const phasesRoot = element('div', 'data-incipit-workflow-phases');
  const resultRoot = element('div', 'data-incipit-workflow-result');
  const invocationRoot = element('div', 'data-incipit-workflow-invocation');
  root.append(summary, notice, phasesRoot, resultRoot, invocationRoot);
  const phases = new Map();
  let disposed = false, resultSignature = null, modelSignature = '', invocationSignature = '';

  function createPhase(phase) {
    let current = phase, limit = 40;
    const node = element('section', 'data-incipit-workflow-phase');
    const heading = element('button', 'data-incipit-workflow-phase-heading'); heading.type = 'button';
    const number = element('span', 'data-incipit-workflow-phase-number');
    const title = element('span', 'data-incipit-workflow-phase-title');
    const stats = element('span', 'data-incipit-workflow-phase-stats');
    const caret = element('span', 'data-incipit-workflow-caret'); caret.setAttribute('aria-hidden', 'true');
    heading.append(number, title, stats, caret); node.append(heading);
    const list = element('div', 'data-incipit-workflow-agent-list');
    const more = action('Show more agents', () => { limit += 40; render(); });
    const rows = new Map(), choiceKey = options.key + ':' + phase.key;
    const fold = foldBody(heading, { onOpen: () => { render(); for (const row of rows.values()) row.setActive(true); }, onClose: () => { for (const row of rows.values()) row.setActive(false); }, onClosed: () => { for (const row of rows.values()) row.dispose(); rows.clear(); list.replaceChildren(); } });
    fold.inner.append(list, more); node.append(fold.root);
    heading.addEventListener('click', event => { event.stopPropagation(); const open = !fold.open; options.choices.set(choiceKey, open); heading.setAttribute('aria-expanded', String(open)); fold.setOpen(open); });

    function render() {
      if (!fold.open) return;
      const keep = new Set();
      current.agents.slice(0, limit).forEach((agent, index) => {
        const key = agent.index; keep.add(key);
        let row = rows.get(key);
        if (!row) { row = createWorkflowAgent(agent, scope, options, current.key); rows.set(key, row); }
        row.update(agent);
        if (list.children[index] !== row.root) list.insertBefore(row.root, list.children[index] || null);
      });
      for (const [key, row] of rows) if (!keep.has(key)) { row.dispose(); row.root.remove(); rows.delete(key); }
      more.hidden = current.agents.length <= limit;
      more.textContent = `Show more agents (${Math.max(0, current.agents.length - limit)} remaining)`;
    }
    const view = { root: node,
      update(next) {
        current = next; setText(number, current.index === null ? '·' : String(current.index).padStart(2, '0'));
        setText(title, current.title); title.title = current.title; setText(stats, countLabel(current.agents));
        node.dataset.incipitWorkflowPhaseState = current.agents.some(agent => agent.displayState === 'error') ? 'error' : current.agents.some(agent => agent.displayState === 'running') ? 'running' : 'idle';
        render();
      }, setActive(value) { for (const row of rows.values()) row.setActive(value && fold.open); },
      dispose() { fold.dispose(); for (const row of rows.values()) row.dispose(); rows.clear(); },
    };
    const open = options.choices.get(choiceKey) !== false;
    heading.setAttribute('aria-expanded', String(open)); fold.setOpen(open, false); view.update(phase);
    return view;
  }

  return { root,
    update(activity, task, invocation) {
      if (disposed) return;
      const nextInvocation = JSON.stringify([invocation, !!activity?.workflow]);
      if (invocation && nextInvocation !== invocationSignature) {
        invocationSignature = nextInvocation; invocationRoot.replaceChildren();
        const details = element('details', 'data-incipit-agent-raw-details');
        details.append(element('summary', '', 'Invocation'), element('pre', 'data-incipit-agent-raw', JSON.stringify(invocation.input || {}, null, 2))); invocationRoot.append(details);
        if (!activity?.workflow && invocation.result) {
          const text = typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result, null, 2);
          const result = element('details', 'data-incipit-agent-raw-details'); result.append(element('summary', '', 'Recorded result'), createAgentRichText(text, options)); invocationRoot.append(result);
        }
      }
      const model = workflowModel(activity, task), counts = model.counts;
      const signature = JSON.stringify(model); if (signature === modelSignature) return; modelSignature = signature;
      setText(total, `${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}${counts.complete ? ' · ' + counts.complete + ' done' : ''}${counts.running ? ' · ' + counts.running + ' running' : ''}${counts.queued ? ' · ' + counts.queued + ' queued' : ''}${counts.error ? ' · ' + counts.error + ' failed' : ''}`);
      setText(usage, usageLabel(model.usage));
      notice.replaceChildren();
      if (model.error) notice.append(element('div', 'data-incipit-agent-error', model.error));
      if (!model.phases.length) notice.append(element('div', 'data-incipit-agent-notice', ['running', 'queued'].includes(model.state) ? 'Waiting for recorded workflow progress.' : 'No detailed workflow progress was recorded.'));
      const keep = new Set();
      model.phases.forEach((phase, index) => {
        keep.add(phase.key); let view = phases.get(phase.key);
        if (!view) { view = createPhase(phase); phases.set(phase.key, view); }
        view.update(phase); if (phasesRoot.children[index] !== view.root) phasesRoot.insertBefore(view.root, phasesRoot.children[index] || null);
      });
      for (const [key, view] of phases) if (!keep.has(key)) { view.dispose(); view.root.remove(); phases.delete(key); }
      const text = model.result === undefined ? '' : typeof model.result === 'string' ? model.result : JSON.stringify(model.result, null, 2);
      const resultKey = JSON.stringify([model.result !== undefined, text, model.resultTruncated, model.logs, model.logsTruncated, model.snapshotPath]);
      if (resultKey !== resultSignature) {
        resultSignature = resultKey; resultRoot.replaceChildren();
        if (model.result !== undefined) {
          const details = element('details', 'data-incipit-agent-raw-details'); details.append(element('summary', '', 'Workflow result'), text ? createAgentRichText(text, options) : element('div', 'data-incipit-agent-notice', 'The workflow returned an empty result.')); resultRoot.append(details);
          details.append(copyAction(() => text));
          if (model.resultTruncated) details.append(element('div', 'data-incipit-agent-notice', 'This result preview is shortened. Open the run record for the full result.'));
        }
        if (model.logs.length) {
          const details = element('details', 'data-incipit-agent-raw-details'); details.append(element('summary', '', `Run notes (${model.logs.length})`), element('pre', 'data-incipit-agent-raw', model.logs.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'))); resultRoot.append(details);
          if (model.logsTruncated) details.append(element('div', 'data-incipit-agent-notice', 'More run notes are available in the original run record.'));
        }
        const source = model.snapshotPath && options.fileAction?.(model.snapshotPath);
        if (source) resultRoot.append(action('Open run record', () => source.open()));
      }
    },
    setActive(value) { for (const phase of phases.values()) phase.setActive(value); },
    dispose() { disposed = true; for (const phase of phases.values()) phase.dispose(); phases.clear(); },
  };
}
