const bindings = new Map();
const SOURCE_ATTRIBUTE = 'data-incipit-agent-map-source';
const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="6.1" y="1.4" width="3.8" height="3.8" rx="1"/><path d="M8 5.2v2.5M3.2 10.8V8.7a1 1 0 0 1 1-1h7.6a1 1 0 0 1 1 1v2.1"/>' +
  '<rect x="1.3" y="10.8" width="3.8" height="3.8" rx="1"/><rect x="10.9" y="10.8" width="3.8" height="3.8" rx="1"/></svg>';

window.addEventListener('pagehide', () => {
  for (const binding of bindings.values()) binding.dispose();
  bindings.clear();
});

function setAttribute(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function notifyFooterLayout(footer) {
  // The host's fit observer ignores attributes. Signal one structural change
  // when the source changes visibility so the model can return to the first row.
  const marker = document.createComment('incipit footer layout');
  footer.appendChild(marker); marker.remove();
}

/** Keep React ownership in the footer and forward the header action to the native control. */
export function syncAgentMap(footer, editChip) {
  for (const [header, binding] of bindings) {
    if (!header.isConnected || !binding.footer.isConnected || !binding.editChip.isConnected ||
        (header === editChip?.parentElement && (binding.footer !== footer || binding.editChip !== editChip))) {
      binding.dispose(); bindings.delete(header);
    }
  }
  if (!footer?.isConnected || !editChip?.isConnected) return;
  const header = editChip.parentElement;
  let binding = bindings.get(header);
  if (!binding) {
    const button = document.createElement('button');
    button.type = 'button'; button.setAttribute('data-incipit-agent-map', ''); button.hidden = true;
    button.setAttribute('aria-label', 'Agent map'); button.setAttribute('aria-haspopup', 'dialog');
    button.title = 'Agent map'; button.innerHTML = ICON;
    let source = null, frame = 0, disposed = false;
    const update = () => {
      frame = 0;
      if (disposed) return;
      if (!header.isConnected || !footer.isConnected || editChip.parentElement !== header) { binding.dispose(); bindings.delete(header); return; }
      const candidates = footer.querySelectorAll('button[data-agents-dot]');
      const next = candidates.length === 1 ? candidates[0] : null;
      let layoutChanged = false;
      if (source && source !== next && source.hasAttribute(SOURCE_ATTRIBUTE)) {
        source.removeAttribute(SOURCE_ATTRIBUTE); layoutChanged = source.isConnected;
      }
      source = next;
      button.hidden = !source; button.disabled = !source || source.disabled;
      if (button.nextElementSibling !== editChip) header.insertBefore(button, editChip);
      if (!source) { if (layoutChanged) notifyFooterLayout(footer); return; }
      const state = source.getAttribute('data-agents-dot') || 'idle';
      setAttribute(button, 'data-incipit-agent-map-state', state);
      setAttribute(button, 'aria-label', source.getAttribute('aria-label') || 'Agent map');
      setAttribute(button, 'title', source.getAttribute('title') || 'Agent map');
      if (!source.hasAttribute(SOURCE_ATTRIBUTE)) { source.setAttribute(SOURCE_ATTRIBUTE, ''); layoutChanged = true; }
      if (layoutChanged) notifyFooterLayout(footer);
    };
    button.addEventListener('click', event => {
      event.stopPropagation(); update();
      if (source?.isConnected && !source.disabled) source.click();
    });
    const observer = new MutationObserver(() => {
      if (!disposed && !frame) frame = requestAnimationFrame(update);
    });
    observer.observe(footer, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-agents-dot', 'aria-label', 'title', 'disabled'] });
    binding = { footer, editChip, update, dispose() {
      disposed = true; observer.disconnect(); if (frame) cancelAnimationFrame(frame);
      const visibleAgain = source?.isConnected && source.hasAttribute(SOURCE_ATTRIBUTE);
      source?.removeAttribute(SOURCE_ATTRIBUTE); button.remove();
      if (visibleAgain && footer.isConnected) notifyFooterLayout(footer);
    } };
    bindings.set(header, binding);
  }
  binding.update();
}
