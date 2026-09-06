const pending = new Map();
const queue = [];
const instance = Math.random().toString(36).slice(2);
let getApi = null, initialized = false, sequence = 0, active = 0;

function abortError() { return new DOMException('Activity reading was cancelled.', 'AbortError'); }

export function configureAgentActivitySource(apiProvider) {
  getApi = apiProvider;
  if (initialized) return;
  initialized = true;
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.__incipit !== true || message.type !== 'agent_activity_response') return;
    const request = pending.get(message.requestId);
    if (!request) return;
    const value = message.payload;
    if (!value || value.sessionId !== request.identity.sessionId || value.toolUseId !== request.identity.toolUseId || (value.agentId || '') !== (request.identity.agentId || '')) {
      settle(request, new Error('The activity response did not match this agent.')); return;
    }
    settle(request, null, value);
  });
}

function settle(request, error, payload) {
  if (request.finished) return;
  request.finished = true;
  clearTimeout(request.timer); pending.delete(request.id);
  request.signal?.removeEventListener('abort', request.abort);
  if (error && request.started) {
    try { getApi?.()?.postMessage({ __incipit: true, type: 'agent_activity_cancel', requestId: request.id }); } catch (_) {}
  }
  if (request.started) active--;
  if (error) request.reject(error); else request.resolve(payload);
  pump();
}

function pump() {
  while (active < 2 && queue.length) {
    const request = queue.shift();
    if (request.finished) continue;
    try {
      const api = getApi?.();
      if (!api || typeof api.postMessage !== 'function') throw new Error('The Claude Code host connection is unavailable.');
      request.started = true; active++;
      request.timer = setTimeout(() => settle(request, new Error('Reading agent activity timed out. Retry to reload it.')), 15000);
      api.postMessage({ __incipit: true, type: 'badge_identity_update', sessionId: request.identity.sessionId, cwd: request.identity.cwd, includeHistory: false });
      api.postMessage({ __incipit: true, type: 'agent_activity_request', requestId: request.id, ...request.identity });
    } catch (error) { settle(request, error); }
  }
}

export function fetchAgentActivity(identity, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!identity.sessionId || !identity.cwd || !identity.toolUseId) return Promise.reject(new Error('The current session or agent identity is not available yet.'));
  if (pending.size >= 32) return Promise.reject(new Error('Too many agent histories are loading. Retry shortly.'));
  return new Promise((resolve, reject) => {
    const request = { id: 'agent-activity-' + instance + '-' + (++sequence), identity, signal, resolve, reject, finished: false, started: false };
    request.abort = () => settle(request, abortError());
    pending.set(request.id, request); queue.push(request);
    signal?.addEventListener('abort', request.abort, { once: true });
    if (signal?.aborted) request.abort();
    pump();
  });
}

export function clearAgentActivitySource() {
  queue.length = 0;
  for (const request of [...pending.values()]) settle(request, abortError());
}
