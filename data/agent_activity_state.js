const sessions = new Map();
const listeners = new Map();
const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
const MAX_TASKS = 128;
let initialized = false;
let signalSession = null;
let signalSessionId = '';
let signalCleanup = null;

function number(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function string(value) { return typeof value === 'string' ? value : ''; }
function sessionTasks(sessionId) {
  let tasks = sessions.get(sessionId);
  if (!tasks) {
    tasks = new Map(); sessions.set(sessionId, tasks);
    while (sessions.size > 4) sessions.delete(sessions.keys().next().value);
  }
  return tasks;
}

function publish(sessionId, task) {
  const tasks = sessionTasks(sessionId);
  tasks.delete(task.taskId); tasks.set(task.taskId, task);
  while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value);
  for (const key of [task.toolUseId, task.taskId]) {
    if (!key) continue;
    for (const callback of listeners.get(sessionId + ':' + key) || []) callback(task);
  }
}

/** Keep only the workflow fields the view understands; do not mutate host payloads. */
export function normalizeWorkflowProgress(progress) {
  if (!Array.isArray(progress)) return null;
  if (progress.length > 4096) throw new Error('The workflow progress snapshot is too large for this view.');
  const records = new Map();
  for (const item of progress) {
    if (!item || !['workflow_phase', 'workflow_agent'].includes(item.type) || !Number.isSafeInteger(item.index) || item.index < 0) continue;
    if (item.type === 'workflow_phase') records.set('phase:' + item.index, { type: item.type, index: item.index, title: string(item.title), kind: string(item.kind) });
    else {
      const next = { type: item.type, index: item.index, label: string(item.label), agentId: string(item.agentId), agentType: string(item.agentType),
        phaseIndex: number(item.phaseIndex), phaseTitle: string(item.phaseTitle), state: string(item.state),
        model: string(item.model), error: string(item.error), queuedAt: number(item.queuedAt), startedAt: number(item.startedAt),
        lastProgressAt: number(item.lastProgressAt), durationMs: number(item.durationMs), tokens: number(item.tokens), toolCalls: number(item.toolCalls),
        promptPreview: string(item.promptPreview), resultPreview: string(item.resultPreview), lastToolName: string(item.lastToolName),
        lastToolSummary: string(item.lastToolSummary), attempt: number(item.attempt), lastAttemptReason: string(item.lastAttemptReason),
        cached: item.cached === true, skipped: item.skipped === true, blocked: item.blocked === true };
      records.set('agent:' + item.index, next);
    }
  }
  return [...records.values()];
}

/** Consume one observed official task event without changing the session state machine. */
export function consumeTaskEvent(event) {
  const sessionId = string(event?.sessionId), message = event?.message;
  if (!sessionId || !message || message.type !== 'system') return;
  const tasks = sessionTasks(sessionId);
  if (message.subtype === 'background_tasks_changed') {
    if (!Array.isArray(message.tasks)) return;
    const present = new Set(message.tasks.map(task => task.task_id));
    for (const task of [...tasks.values()]) {
      if (task.isBackgrounded && !TERMINAL.has(task.status) && task.status !== 'paused' && !present.has(task.taskId)) publish(sessionId, { ...task, status: 'unknown', noLongerReported: true });
    }
    return;
  }
  const taskId = string(message.task_id);
  if (!taskId) return;
  const previous = tasks.get(taskId);
  const task = { ...previous, taskId, toolUseId: string(message.tool_use_id) || previous?.toolUseId || '', observed: true };
  if (message.subtype === 'task_started') {
    if (previous && TERMINAL.has(previous.status)) return;
    if (!['local_agent', 'local_workflow'].includes(message.task_type)) return;
    Object.assign(task, { type: message.task_type, description: string(message.description), status: 'running', isBackgrounded: message.is_backgrounded === true, noLongerReported: false });
  } else if (message.subtype === 'task_progress') {
    if (previous && TERMINAL.has(previous.status)) return;
    task.status = 'running';
    task.description = string(message.description) || task.description || '';
    task.summary = string(message.summary);
    task.lastToolName = string(message.last_tool_name);
    if (message.usage) task.usage = { tokens: number(message.usage.total_tokens), toolCalls: number(message.usage.tool_uses), durationMs: number(message.usage.duration_ms) };
    if (Array.isArray(message.workflow_progress)) {
      task.type = 'local_workflow';
      try { task.progress = normalizeWorkflowProgress(message.workflow_progress); task.progressError = ''; }
      catch (error) { task.progressError = error.message; }
    }
  } else if (message.subtype === 'task_updated') {
    const patch = message.patch;
    if (!patch || typeof patch !== 'object') return;
    if (typeof patch.status === 'string') task.status = patch.status;
    if (typeof patch.is_backgrounded === 'boolean') task.isBackgrounded = patch.is_backgrounded;
    if (typeof patch.summary === 'string') task.summary = patch.summary;
  } else if (message.subtype === 'task_notification') {
    task.status = string(message.status) || previous?.status || 'unknown';
    task.summary = string(message.summary);
    task.outputFile = string(message.output_file);
    if (message.usage) task.usage = { tokens: number(message.usage.total_tokens), toolCalls: number(message.usage.tool_uses), durationMs: number(message.usage.duration_ms) };
  } else return;
  publish(sessionId, task);
}

export function initTaskActivityState() {
  if (initialized) return;
  initialized = true;
  window.addEventListener('incipit:taskEvent', event => consumeTaskEvent(event.detail));
  const buffer = globalThis.__incipitTaskEventBuffer;
  if (Array.isArray(buffer)) for (const event of buffer.splice(0)) consumeTaskEvent(event);
  globalThis.__incipitTaskEventBuffer = null;
  window.addEventListener('pagehide', () => { signalCleanup?.(); signalCleanup = null; signalSession = null; signalSessionId = ''; sessions.clear(); listeners.clear(); });
}

/** The existing signal is a fallback for events delivered before the view was opened. */
export function bindTaskSignal(session, sessionId) {
  if (!session || (session === signalSession && sessionId === signalSessionId)) return;
  signalCleanup?.(); signalCleanup = null; signalSession = session; signalSessionId = sessionId;
  const signal = session.subagentTasks;
  if (typeof signal?.subscribe !== 'function') return;
  signalCleanup = signal.subscribe(value => {
    if (!(value instanceof Map)) return;
    for (const previous of [...sessionTasks(sessionId).values()]) {
      if (!previous.observed && previous.type === 'local_agent' && !TERMINAL.has(previous.status) && !value.has(previous.taskId)) publish(sessionId, { ...previous, status: 'unknown', noLongerReported: true });
    }
    for (const native of value.values()) {
      if (!native?.taskId || !native.toolUseId) continue;
      const previous = sessionTasks(sessionId).get(native.taskId);
      if (previous?.observed) continue;
      publish(sessionId, { taskId: native.taskId, toolUseId: native.toolUseId, type: 'local_agent', description: native.description || '',
        status: native.status || 'running', isBackgrounded: native.isBackgrounded === true, summary: native.summary || '',
        usage: native.usage ? { tokens: number(native.usage.totalTokens), toolCalls: number(native.usage.toolUses), durationMs: number(native.usage.durationMs) } : null });
    }
  });
}

export function getTaskActivity(sessionId, toolUseId, taskId = '') {
  const tasks = sessions.get(sessionId);
  if (!tasks) return null;
  if (taskId && tasks.has(taskId)) return tasks.get(taskId);
  return [...tasks.values()].reverse().find(task => task.toolUseId === toolUseId) || null;
}

export function subscribeTaskActivity(sessionId, id, callback) {
  const key = sessionId + ':' + id;
  let list = listeners.get(key);
  if (!list) { list = new Set(); listeners.set(key, list); }
  list.add(callback);
  return () => { list.delete(callback); if (!list.size) listeners.delete(key); };
}
