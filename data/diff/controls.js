const PATHS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  previous: '<path d="m4 9.5 4-4 4 4"/>',
  next: '<path d="m4 6.5 4 4 4-4"/>',
  expand: '<path d="M9.5 2.5h4v4m0-4-5 5M6.5 13.5h-4v-4m0 4 5-5"/>',
  pagePrevious: '<path d="m9.5 4-4 4 4 4"/>',
  pageNext: '<path d="m6.5 4 4 4-4 4"/>',
  latest: '<path d="m3 4 4 4-4 4m5-8 4 4-4 4M13.5 3v10"/>',
  refresh: '<path d="M12.8 6A5 5 0 1 0 13 9M13 2.5V6H9.5"/>',
  source: '<path d="M9.5 2.5h4v4m0-4-6 6M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.2v4M8 4.8V5"/>',
  copy: '<g data-copy-glyph="copy"><rect x="5.5" y="5.5" width="7.5" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></g><path data-copy-glyph="check" d="m3.5 8 3 3 6-6"/><g data-copy-glyph="error"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.8v3.7M8 11v.2"/></g>',
};

/** Small SVG controls share a fixed footprint and an accessible English name. */
export function iconButton(label, icon, action, attribute, showLabel = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(attribute, '');
  button.setAttribute('data-incipit-diff-action', '');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PATHS[icon] + '</svg>';
  if (showLabel) {
    const text = document.createElement('span');
    text.setAttribute('data-incipit-diff-action-label', '');
    text.textContent = label;
    button.append(text);
  }
  button.addEventListener('click', event => { event.stopPropagation(); action(event); });
  return button;
}

/** Clipboard feedback stays on the icon and never changes the diff's notice. */
export function copyButton(label, getText, showLabel = true) {
  let disposed = false, timer = null;
  const button = iconButton(label, 'copy', copy, 'data-incipit-diff-copy', showLabel);
  const announcement = document.createElement('span');
  announcement.setAttribute('data-incipit-diff-announcement', '');
  announcement.setAttribute('role', 'status');
  button.append(announcement);
  async function copy() {
    if (disposed || button.disabled) return;
    clearTimeout(timer);
    button.disabled = true;
    button.dataset.copyState = 'copying';
    button.title = label;
    announcement.textContent = '';
    try {
      const text = await getText();
      if (disposed) return;
      await navigator.clipboard.writeText(text);
      if (disposed) return;
      button.dataset.copyState = 'copied';
      button.title = 'Copied';
      announcement.textContent = 'Copied';
    } catch (_) {
      if (disposed) return;
      button.dataset.copyState = 'error';
      button.title = 'Copy failed. Retry or select the text to copy.';
      announcement.textContent = button.title;
    } finally {
      if (!disposed) {
        button.disabled = false;
        timer = setTimeout(() => {
          delete button.dataset.copyState;
          button.title = label;
          announcement.textContent = '';
        }, button.dataset.copyState === 'copied' ? 1400 : 2400);
      }
    }
  }
  return { button, dispose() { disposed = true; clearTimeout(timer); } };
}
