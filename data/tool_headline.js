import { markActivityDirty } from './activity_groups.js';

export const FILE_CHANGES = new Set(['Edit', 'MultiEdit', 'Write']);
/** Row label per tool as [settled, running, failed]; unknown tools keep their raw name. */
const LABELS = {
  Edit: ['Edited', 'Editing', 'Edit'], MultiEdit: ['Edited', 'Editing', 'Edit'], Write: ['Wrote', 'Writing', 'Write'],
  Read: ['Read', 'Reading', 'Read'], ReadCoalesced: ['Read', 'Reading', 'Read'],
  Bash: ['Ran command', 'Running command', 'Command'],
  Grep: ['Searched', 'Searching', 'Search'], Glob: ['Found files', 'Finding files', 'Find files'],
  WebSearch: ['Searched the web', 'Searching the web', 'Web search'], WebFetch: ['Fetched', 'Fetching', 'Fetch'],
  TodoWrite: ['Updated tasks', 'Updating tasks', 'Update tasks'],
  Task: ['Ran agent', 'Running agent', 'Agent'], Agent: ['Ran agent', 'Running agent', 'Agent'],
  Workflow: ['Workflow', 'Running workflow', 'Workflow'], RunWorkflow: ['Workflow', 'Running workflow', 'Workflow'],
  AskUserQuestion: ['Asked a question', 'Asking a question', 'Question'],
};
/** Category that activity group summaries count; anything else is "other". */
const KINDS = {
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', Read: 'read', ReadCoalesced: 'read',
  Bash: 'command', Grep: 'search', Glob: 'search', WebSearch: 'search',
  Task: 'agent', Agent: 'agent', Workflow: 'workflow', RunWorkflow: 'workflow',
};
const ICONS = {
  file: '<path d="M9 2H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z"/><path d="M9 2v6h6M6 11h6M6 13h4"/>',
  edit: '<path d="M10 3H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5"/><path d="m9 11-3 1 1-3 7-7 2 2z"/>',
  terminal: '<rect x="2" y="3" width="14" height="12" rx="2"/><path d="m5 6 3 3-3 3m5 0h3"/>',
  search: '<circle cx="8" cy="8" r="5"/><path d="m12 12 4 4"/>',
  agent: '<circle cx="9" cy="5" r="2.5"/><path d="M3.5 16v-2.5a5.5 5.5 0 0 1 11 0V16M3 5H1m16 0h-2"/>',
  workflow: '<rect x="2" y="2" width="5" height="4" rx="1"/><rect x="11" y="12" width="5" height="4" rx="1"/><path d="M4.5 6v7a1 1 0 0 0 1 1H11M7 4h5.5a1 1 0 0 1 1 1v7"/>',
  tool: '<path d="m5 3-2 2 4 4-4 4 2 2 4-4 4 4 2-2-4-4 4-4-2-2-4 4z"/>',
};

function setAttribute(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function node(tag, attr, text) {
  const value = document.createElement(tag);
  if (attr) value.setAttribute(attr, '');
  if (text !== undefined) value.textContent = text;
  return value;
}

function iconFor(name) {
  const icon = FILE_CHANGES.has(name) ? 'edit' : name === 'Bash' ? 'terminal' :
    ['Read', 'ReadCoalesced'].includes(name) ? 'file' : ['Grep', 'Glob', 'WebSearch'].includes(name) ? 'search' :
    ['Agent', 'Task'].includes(name) ? 'agent' : ['Workflow', 'RunWorkflow'].includes(name) ? 'workflow' : 'tool';
  return '<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[icon] + '</svg>';
}

function fileName(value) { return String(value || '').split(/[/\\]/).pop() || ''; }

export function publicState(data) {
  if (data.result?.is_error || ['error', 'failed', 'failure'].includes(data.status)) return 'error';
  if (data.result?.type === 'tool_result' && data.result.tool_use_id === data.block?.id) return 'complete';
  if (['pending', 'running', 'in_progress'].includes(data.status)) return 'running';
  if (data.result || ['success', 'succeeded', 'completed', 'complete', 'ok'].includes(data.status)) return 'complete';
  return 'unknown';
}

/** The host fingerprint is mirrored into the single incipit headline row. */
function hostFingerprint(root) {
  for (const candidate of root.querySelectorAll('[class*="secondaryLine_"]')) {
    if (candidate.closest('[class*="toolBody_"], [data-incipit-tool-heading]')) continue;
    if (candidate.closest('[class*="toolUse_"]') !== root) continue;
    return (candidate.textContent || '').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Build the incipit-owned headline for one tool root. */
export function buildHeadline(root, options) {
  const header = node('div', 'data-incipit-tool-heading');
  const row = node('div', 'data-incipit-tool-row');
  const toggle = node('button', 'data-incipit-tool-toggle'); toggle.type = 'button';
  const glyph = node('span', 'data-incipit-tool-icon');
  const label = node('span', 'data-incipit-tool-label');
  const subject = node('span', 'data-incipit-tool-subject'); subject.hidden = true;
  const stem = node('span', 'data-incipit-tool-filename-stem');
  const extension = node('span', 'data-incipit-tool-filename-extension');
  subject.append(stem, extension);
  const counts = node('span', 'data-incipit-tool-counts'); counts.hidden = true;
  const fingerprint = node('span', 'data-incipit-tool-fingerprint-text'); fingerprint.hidden = true;
  const state = node('span', 'data-incipit-tool-state'); state.hidden = true;
  const chevron = node('span', 'data-incipit-tool-chevron');
  toggle.append(glyph, label);
  row.append(toggle, subject, counts, fingerprint, state, chevron);
  header.append(row);
  root.insertBefore(header, root.firstChild);
  root.dataset.incipitToolHeadline = '1';
  let lastName = '', lastStatus = '', lastSubject = '', lastPaths = '', missingAction = false;
  let isOpen = false, expandable = true;

  function sync() {
    setAttribute(root, 'data-incipit-tool-expandable', String(expandable));
    if (expandable) setAttribute(toggle, 'aria-expanded', String(isOpen));
    else toggle.removeAttribute('aria-expanded');
    toggle.disabled = !expandable;
    setAttribute(row, 'data-incipit-expanded', String(isOpen));
  }

  function update(next, canExpand, presentation = null) {
    const block = next.block, input = block.input || {};
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    const readPaths = block.name === 'ReadCoalesced' && Array.isArray(input.fileReads)
      ? input.fileReads.map(read => read.file_path || read.path).filter(value => typeof value === 'string' && value) : [];
    const paths = filePath ? [filePath] : readPaths;
    const isFile = paths.length > 0;
    const description = typeof presentation?.description === 'string' ? presentation.description : isFile ? paths.map(fileName).join(', ') : String((block.name === 'WebFetch' ? input.url : '') ||
      input.description || input.query || input.pattern ||
      (block.name === 'Bash' ? input.command || '' : '') || '').replace(/\s+/g, ' ').trim();
    const status = presentation?.state || publicState(next);
    const labels = Object.prototype.hasOwnProperty.call(LABELS, block.name) ? LABELS[block.name] : null;
    if (lastName !== block.name) {
      lastName = block.name;
      glyph.innerHTML = iconFor(block.name);
      root.dataset.incipitToolKind = Object.prototype.hasOwnProperty.call(KINDS, block.name) ? KINDS[block.name] : 'other';
      root.dataset.incipitToolName = block.name;
      label.title = labels ? '' : block.name;
    }
    if (root.dataset.incipitToolId !== block.id) root.dataset.incipitToolId = block.id;
    const labelText = presentation?.label || (labels ? labels[status === 'running' ? 1 : status === 'error' ? 2 : 0] : block.name);
    if (label.textContent !== labelText) label.textContent = labelText;
    const pathIdentity = options.getIdentity?.() || {};
    const pathKey = paths.join('\u0000') + '\u0000' + (pathIdentity.cwd || '');
    if (isFile && (missingAction || lastPaths !== pathKey || lastSubject !== description)) {
      missingAction = false;
      const focusedPath = subject.contains(document.activeElement) ? document.activeElement.dataset.incipitToolSourcepath : null;
      subject.replaceChildren();
      paths.forEach((path, index) => {
        if (index) subject.append(node('span', '', ', '));
        const action = options.fileAction?.(path);
        const file = node(action ? 'button' : 'span', 'data-incipit-tool-file-link');
        const name = fileName(path), dot = name.lastIndexOf('.');
        file.append(node('span', 'data-incipit-tool-filename-stem', dot > 0 ? name.slice(0, dot) : name),
          node('span', 'data-incipit-tool-filename-extension', dot > 0 ? name.slice(dot) : ''));
        if (action) {
          file.type = 'button'; file.dataset.incipitToolFullpath = action.filePath;
          file.dataset.incipitToolSourcepath = path;
          file.setAttribute('aria-label', 'Open ' + action.filePath);
          file.addEventListener('click', event => { event.stopPropagation(); action.open(); });
        } else { file.title = path; missingAction = true; }
        subject.append(file);
      });
      lastPaths = pathKey; lastSubject = description; subject.hidden = false;
      if (focusedPath) [...subject.querySelectorAll('button')].find(file => file.dataset.incipitToolSourcepath === focusedPath)?.focus({ preventScroll: true });
    } else if (!isFile && lastSubject !== description) {
      lastSubject = description;
      lastPaths = ''; subject.replaceChildren(stem, extension);
      stem.textContent = description; extension.textContent = '';
      subject.hidden = !description;
    }
    setAttribute(subject, 'data-incipit-tool-subject', isFile ? 'file' : 'text');
    subject.title = isFile ? '' : description;
    setAttribute(toggle, 'aria-label', presentation?.ariaLabel || labelText + (description ? ': ' + description : ''));
    setAttribute(root, 'data-incipit-tool-state', status);
    const statusText = presentation?.stateText ?? (status === 'error' ? 'Failed' : '');
    if (state.textContent !== statusText) state.textContent = statusText;
    state.hidden = !statusText;
    const print = presentation?.detail ?? (FILE_CHANGES.has(block.name) ? '' : hostFingerprint(root));
    if (fingerprint.textContent !== print) fingerprint.textContent = print;
    fingerprint.hidden = !print;
    expandable = canExpand !== false;
    sync();
    if (lastStatus !== status) { lastStatus = status; markActivityDirty(root); }
  }

  toggle.addEventListener('click', event => { event.stopPropagation(); if (expandable) options.toggle(); });
  header.addEventListener('click', event => { event.stopPropagation(); if (expandable) options.toggle(); });
  header.addEventListener('pointerover', () => { if (missingAction) options.onRetryPaths?.(); });
  return {
    header, toggle, row,
    update,
    invalidatePaths() { lastPaths = ''; },
    setOpen(value) { isOpen = value; sync(); },
    setCounts(stats) {
      counts.replaceChildren(); counts.hidden = !stats;
      if (stats) counts.append(node('span', 'data-incipit-tool-added', '+' + stats.added), node('span', 'data-incipit-tool-removed', '−' + stats.removed));
    },
  };
}
