const PROFILES = {
  generic: { keepLines: 7, fullBelowLines: 9, keepChars: 1800 },
  command: { keepLines: 3, fullBelowLines: 4, keepChars: 900 },
};

function scrollAncestor(element) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return window;
}

/** Keep host-owned and nested IN/OUT rows on the same preview and disclosure policy. */
export function applyToolBodyTruncation(grid, toolName) {
  for (const row of grid.querySelectorAll('[class*="toolBodyRow_"], [data-incipit-tool-io-row]')) {
    const content = row.querySelector('[class*="toolBodyRowContent"], [data-incipit-tool-io-content]');
    if (!content) continue;
    const label = (row.querySelector('[class*="toolBodyRowLabel"], [data-incipit-tool-io-label]')?.textContent || '').trim().toLowerCase();
    const command = ['Bash', 'PowerShell'].includes(toolName) && ['in', 'input', 'command'].includes(label);
    applyRow(content, command ? PROFILES.command : PROFILES.generic);
  }
}

function applyRow(content, profile) {
  const target = content.querySelector('[class*="toolResult_"], [data-incipit-tool-output]') || content.querySelector('pre');
  if (!target) return;
  const text = target.textContent || '';
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  let button = content.querySelector(':scope > [data-incipit-tool-out-more]');
  if (lines <= profile.fullBelowLines && text.length <= profile.keepChars) {
    target.removeAttribute('data-incipit-tool-out-clipped'); target.style.removeProperty('--incipit-tool-out-preview-max-height');
    button?.remove(); delete content.dataset.userExpanded; return;
  }
  const expanded = content.dataset.userExpanded === '1';
  if (expanded) target.removeAttribute('data-incipit-tool-out-clipped');
  else {
    target.setAttribute('data-incipit-tool-out-clipped', '1');
    target.style.setProperty('--incipit-tool-out-preview-max-height', (profile.keepLines * 1.5) + 'em');
  }
  if (!button) {
    button = document.createElement('span'); button.setAttribute('data-incipit-tool-out-more', '');
    button.setAttribute('role', 'button'); button.tabIndex = 0;
    const toggle = event => {
      event.stopPropagation();
      const wasExpanded = content.dataset.userExpanded === '1';
      const before = wasExpanded ? button.getBoundingClientRect().top : 0;
      content.dataset.userExpanded = wasExpanded ? '0' : '1'; applyRow(content, profile);
      if (wasExpanded) {
        const delta = button.getBoundingClientRect().top - before;
        if (delta) { const scroller = scrollAncestor(content); if (scroller === window) window.scrollBy(0, delta); else scroller.scrollTop += delta; }
      }
    };
    button.addEventListener('click', toggle);
    button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(event); } });
  }
  const hidden = Math.max(lines - profile.keepLines, 0);
  const label = expanded ? '− show less' : hidden ? '+ ' + hidden + ' more line' + (hidden === 1 ? '' : 's') : '+ more text';
  if (button.textContent !== label) button.textContent = label;
  button.setAttribute('aria-expanded', String(expanded));
  if (content.lastChild !== button) content.append(button);
}
