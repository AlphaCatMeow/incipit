export function element(tag, attr, text) {
  const node = document.createElement(tag);
  if (attr) node.setAttribute(attr, '');
  if (text !== undefined) node.textContent = text;
  return node;
}

export function action(label, onClick) {
  const button = element('button', 'data-incipit-agent-action', label); button.type = 'button';
  button.addEventListener('click', event => { event.stopPropagation(); onClick(event); });
  return button;
}

export function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

export function activityStatus(value) {
  if (['completed', 'complete', 'done', 'success'].includes(value)) return 'complete';
  if (['failed', 'failure', 'error'].includes(value)) return 'error';
  if (['running', 'progress'].includes(value)) return 'running';
  if (['pending', 'queued'].includes(value)) return 'queued';
  if (['waiting_input', 'waiting_for_input', 'waiting'].includes(value)) return 'waiting';
  if (value === 'paused') return 'paused';
  if (['killed', 'stopped', 'skipped'].includes(value)) return 'stopped';
  return 'unknown';
}

export function statusLabel(state) {
  return { complete: 'Completed', error: 'Failed', running: 'Running', queued: 'Queued', waiting: 'Needs input', paused: 'Paused', stopped: 'Stopped', unknown: 'Status not recorded' }[state] || 'Status not recorded';
}

export function usageLabel(usage) {
  if (!usage) return '';
  const parts = [];
  if (Number.isFinite(usage.toolCalls)) parts.push(usage.toolCalls + (usage.toolCalls === 1 ? ' tool' : ' tools'));
  if (Number.isFinite(usage.tokens)) parts.push(new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(usage.tokens) + ' tokens');
  if (Number.isFinite(usage.durationMs)) {
    const seconds = Math.floor(usage.durationMs / 1000);
    parts.push(seconds >= 60 ? Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's' : seconds + 's');
  }
  return parts.join(' · ');
}

export function copyAction(textProvider) {
  let timer;
  const button = action('Copy', async () => {
    clearTimeout(timer);
    try { await navigator.clipboard.writeText(textProvider()); button.textContent = 'Copied'; button.removeAttribute('data-incipit-copy-error'); }
    catch (error) { button.textContent = 'Retry copy'; button.title = error.message; button.setAttribute('data-incipit-copy-error', ''); return; }
    timer = setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1400);
  });
  return button;
}

export function sourceAction(path, options) {
  const target = path && options.fileAction?.(path);
  return target ? action('Open transcript', () => target.open()) : null;
}

export function errorView(error, retry) {
  const box = element('div', 'data-incipit-agent-notice'); box.setAttribute('role', 'status');
  box.dataset.incipitAgentNotice = error.state === 'permission' ? 'permission' : error.state === 'unavailable' ? 'empty' : 'error';
  box.append(element('span', '', error.error || error.message || String(error)));
  if (retry) box.append(action('Retry', retry));
  return box;
}

/** A shared fold body; only an explicit toggle enables the height transition. */
export function foldBody(toggle, { onOpen, onClose, onClosed } = {}) {
  const root = element('div', 'data-incipit-agent-fold');
  const inner = element('div', 'data-incipit-agent-fold-inner'); root.append(inner);
  root.hidden = true; inner.inert = true;
  let open = false, timer = null, generation = 0;
  return { root, inner,
    setOpen(value, animate = true) {
      if (value === open) return;
      open = value; const token = ++generation; clearTimeout(timer);
      if (animate) root.setAttribute('data-incipit-agent-animating', '');
      else root.removeAttribute('data-incipit-agent-animating');
      if (value) {
        root.hidden = false; inner.inert = false; onOpen?.();
        if (animate) requestAnimationFrame(() => { if (token === generation) root.dataset.incipitAgentOpen = '1'; });
        else root.dataset.incipitAgentOpen = '1';
      } else {
        if (root.contains(document.activeElement)) toggle?.focus({ preventScroll: true });
        inner.inert = true; root.dataset.incipitAgentOpen = '0'; onClose?.();
      }
      timer = setTimeout(() => {
        if (token !== generation) return;
        root.removeAttribute('data-incipit-agent-animating');
        if (!open) { root.hidden = true; onClosed?.(); }
      }, animate ? 240 : 0);
    },
    dispose() { generation++; clearTimeout(timer); onClose?.(); onClosed?.(); },
    get open() { return open; },
  };
}
