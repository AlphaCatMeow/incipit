/** Read-only completion follows the host process, including stop and disconnect. */
export function executionBusy(state, fallback = null) {
  // The native busy signal spans tool execution and clears on result/process reset.
  // A partial transcript tail can survive either event and is not a live process.
  if (state?.source === 'bridge') return state.busy === true || state.pendingInput === true;
  return fallback;
}

/** Keep terminal review separate from the stricter natural-end mutation gate. */
export function createExecutionLifecycle(emit, delay = 360) {
  let identity = '', busy = null, timer = null, generation = 0;
  return {
    update(state, fallback) {
      const key = (state.sessionId || '') + '\0' + (state.cwd || '');
      const next = executionBusy(state, fallback);
      if (identity === key && next === busy) return;
      clearTimeout(timer); generation++;
      const changed = identity !== key;
      identity = key; busy = next;
      if (!state.sessionId || next === null) return;
      const payload = { ...state, busy: next, reason: changed ? 'session' : 'execution' };
      if (next) emit('executionStarted', payload);
      else {
        const token = generation;
        timer = setTimeout(() => { if (token === generation) emit('executionSettled', payload); }, delay);
      }
    },
    dispose() { generation++; clearTimeout(timer); identity = ''; busy = null; },
  };
}
