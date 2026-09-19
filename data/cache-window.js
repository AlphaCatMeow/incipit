const bindings = new Map();
const SOURCE_ATTRIBUTE = 'data-incipit-cache-window-source';
const CLOCK_SVG = '<svg class="cceBadgeGlyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="5.3"/><path d="M8 4.8V8l2.2 1.4"/></svg>';

/** Mirror the host's cache window into the existing statistics button. */
export function syncCacheWindow(footer, badge) {
  for (const [element, binding] of bindings) {
    if (!element.isConnected || !binding.badge.isConnected || (element === footer && binding.badge !== badge)) {
      binding.dispose(); bindings.delete(element);
    }
  }
  if (!footer || !badge) return;
  let binding = bindings.get(footer);
  if (!binding) {
    const group = document.createElement('span');
    group.className = 'cceBadgeWindow'; group.hidden = true;
    group.innerHTML = CLOCK_SVG + '<span class="cceBadgeVal" data-cce-val="window"></span>';
    badge.appendChild(group);
    const value = group.lastElementChild;
    let source = null, scheduled = false, disposed = false;
    const update = () => {
      scheduled = false;
      if (disposed) return;
      const indicators = [...footer.querySelectorAll('[data-cache-window]')];
      const indicator = indicators.length === 1 ? indicators[0] : null;
      const kind = indicator?.getAttribute('data-cache-window');
      const label = kind === 'warm' ? indicator.querySelector('[data-footer-fixed-width]')?.textContent?.trim() :
        kind === 'cold' ? 'Cold' : '';
      const nextSource = label ? (indicator.parentElement === footer ? indicator : indicator.parentElement) : null;
      if (source && source !== nextSource) source.removeAttribute(SOURCE_ATTRIBUTE);
      source = nextSource;
      group.hidden = !label;
      if (value.textContent !== (label || '')) value.textContent = label || '';
      group.title = indicator?.getAttribute('aria-label') || 'Prompt cache window';
      if (source && !source.hasAttribute(SOURCE_ATTRIBUTE)) source.setAttribute(SOURCE_ATTRIBUTE, '');
      badge.setAttribute('aria-label', 'Context and cache statistics' + (label ? ', cache window ' + label : ''));
    };
    const observer = new MutationObserver(records => {
      if (scheduled || !records.some(record => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        return target && !badge.contains(target);
      })) return;
      scheduled = true; requestAnimationFrame(update);
    });
    observer.observe(footer, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-cache-window', 'aria-label'] });
    binding = { badge, update, dispose() { disposed = true; observer.disconnect(); source?.removeAttribute(SOURCE_ATTRIBUTE); group.remove(); } };
    bindings.set(footer, binding);
  }
  binding.update();
}
