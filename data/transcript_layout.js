/** Keep external composer placement aligned with the actual transcript scrollport. */
const roots = new Map();
const dirty = new Set();
let frame = 0;

function schedule(scroller) {
  dirty.add(scroller);
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  for (const scroller of dirty) {
    const state = roots.get(scroller);
    if (!state) continue;
    if (!scroller.isConnected) { state.observer?.disconnect(); roots.delete(scroller); continue; }
    if (state.applied === state.width) continue;
    state.applied = state.width;
    state.container.style.setProperty('--incipit-layout-scrollbar', state.width + 'px');
  }
  dirty.clear();
}

export function observeTranscriptLayout(scroller) {
  if (roots.has(scroller)) return;
  const container = scroller.closest('[class*="chatContainer_"]');
  if (!container) return;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    const state = roots.get(scroller);
    if (!state) return;
    if (!scroller.isConnected) { observer.disconnect(); roots.delete(scroller); return; }
    const entry = entries[entries.length - 1];
    const borderBox = entry.borderBoxSize?.[0];
    const contentBox = entry.contentBoxSize?.[0];
    if (!borderBox || !contentBox) return;
    // ResizeObserver supplies post-layout sizes; do not force a transcript
    // reflow just to place an external composer (2026-09-05).
    const style = getComputedStyle(scroller);
    const padding = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
      .reduce((total, key) => total + (parseFloat(style[key]) || 0), 0);
    state.width = Math.max(0, Math.round(borderBox.inlineSize - contentBox.inlineSize - padding));
    schedule(scroller);
  }) : null;
  roots.set(scroller, { container, observer, width: 0, applied: null });
  observer?.observe(scroller);
  schedule(scroller);
}

window.addEventListener('pagehide', () => {
  for (const state of roots.values()) state.observer?.disconnect();
  roots.clear(); dirty.clear();
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
});
