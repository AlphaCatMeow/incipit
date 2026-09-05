import { getDiffModel } from './client.js';

const PAGE_ROWS = 200;
let activeDialog = null;

function element(tag, attribute, text) {
  const node = document.createElement(tag);
  if (attribute) node.setAttribute(attribute, '');
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, action, attribute) {
  const node = element('button', attribute, text);
  node.type = 'button';
  node.addEventListener('click', event => { event.stopPropagation(); action(event); });
  return node;
}

function basename(filePath) {
  return String(filePath || '').split(/[/\\]/).pop() || 'File diff';
}

function updateCounts(node, model) {
  node.replaceChildren();
  if (!model || model.statsScope !== 'complete' || model.quality === 'coarse') { node.hidden = true; return; }
  node.hidden = false;
  node.append(element('span', 'data-incipit-tool-added', '+' + model.stats.added),
    element('span', 'data-incipit-tool-removed', '\u2212' + model.stats.removed));
}

function annotateCharacters(code, row) {
  if (!row.charRanges?.length) return;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let position = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: position, end: position + node.length });
    position += node.length;
  }
  for (let r = row.charRanges.length - 1; r >= 0; r--) {
    const [start, end] = row.charRanges[r];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const part = nodes[i];
      const a = Math.max(start, part.start) - part.start;
      const b = Math.min(end, part.end) - part.start;
      if (b <= a) continue;
      let target = part.node;
      if (b < target.length) target.splitText(b);
      if (a > 0) target = target.splitText(a);
      const mark = element('span', 'data-incipit-diff-island-char');
      mark.setAttribute('data-incipit-diff-island-char', row.kind);
      target.parentNode.insertBefore(mark, target); mark.appendChild(target);
    }
  }
}

function renderRow(row, index, language, highlight) {
  const line = element('div', 'data-incipit-diff-island-row');
  line.setAttribute('data-incipit-diff-island-row', row.kind);
  line.dataset.incipitDiffRowIndex = String(index);
  if (row.kind === 'gap') {
    const count = row.newSkipped ?? row.oldSkipped;
    const label = row.text || (Number.isFinite(count) ? count + ' unchanged lines omitted' : 'Unchanged context omitted');
    line.append(element('span', 'data-incipit-diff-gap', '\u22ef  ' + label));
    return line;
  }
  const number = element('span', 'data-incipit-diff-island-number', String((row.kind === 'del' ? row.oldLine : row.newLine) || ''));
  number.setAttribute('aria-hidden', 'true');
  const sign = element('span', 'data-incipit-diff-sign', row.kind === 'add' ? '+' : row.kind === 'del' ? '\u2212' : '');
  sign.setAttribute('aria-label', row.kind === 'add' ? 'Added' : row.kind === 'del' ? 'Removed' : 'Context');
  const pre = element('pre', 'data-incipit-diff-island-pre');
  const code = element('code', 'data-incipit-diff-island-code');
  code.textContent = row.text;
  const highlighter = globalThis.hljs;
  if (highlight && language && language !== 'plaintext' && row.text.length < 4000 && highlighter?.getLanguage?.(language)) {
    try { code.innerHTML = highlighter.highlight(row.text, { language, ignoreIllegals: true }).value; }
    catch (_) { code.textContent = row.text; }
  }
  annotateCharacters(code, row);
  pre.appendChild(code);
  if (row.noNewline) pre.appendChild(element('span', 'data-incipit-diff-eof', ' No newline at end of file'));
  line.append(number, sign, pre);
  return line;
}

function createRowViewport(parent, model, options = {}) {
  const viewport = element('div', 'data-incipit-diff-viewport');
  viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'File diff'); viewport.tabIndex = 0;
  const body = element('div', 'data-incipit-diff-island-body');
  viewport.appendChild(body);
  const pager = element('div', 'data-incipit-diff-pages');
  const label = element('span', 'data-incipit-diff-page-label');
  let page = 0;
  let renderGeneration = 0;
  let disposed = false;
  const previous = button('Previous', () => setPage(page - 1), 'data-incipit-diff-page-previous');
  const next = button('Next', () => setPage(page + 1), 'data-incipit-diff-page-next');
  pager.append(previous, label, next);
  parent.append(viewport, pager);

  async function setPage(value, targetRow = null) {
    if (disposed) return;
    const last = Math.max(0, Math.ceil(model.rows.length / PAGE_ROWS) - 1);
    page = Math.max(0, Math.min(last, value));
    const token = ++renderGeneration;
    const start = page * PAGE_ROWS, end = Math.min(model.rows.length, start + PAGE_ROWS);
    previous.disabled = page === 0; next.disabled = page === last; pager.hidden = last === 0;
    label.textContent = (start + 1) + '\u2013' + end + ' of ' + model.rows.length + ' rows';
    body.replaceChildren();
    viewport.scrollTop = 0;
    let deadline = performance.now() + 4;
    let fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      fragment.appendChild(renderRow(model.rows[i], i, options.language, performance.now() < deadline));
      if (performance.now() >= deadline) {
        body.appendChild(fragment);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (disposed || token !== renderGeneration) return;
        fragment = document.createDocumentFragment(); deadline = performance.now() + 4;
      }
    }
    body.appendChild(fragment);
    if (targetRow !== null) {
      const target = body.querySelector('[data-incipit-diff-row-index="' + targetRow + '"]');
      if (target) {
        target.setAttribute('data-incipit-diff-match', '');
        viewport.scrollTop = target.offsetTop - body.offsetTop;
      }
    }
  }
  const ready = setPage(options.initialState?.page || 0).then(() => {
    if (options.initialState && !disposed) {
      viewport.scrollTop = options.initialState.top;
      viewport.scrollLeft = options.initialState.left;
    }
  });
  return {
    viewport,
    ready,
    snapshot() { return { page, top: viewport.scrollTop, left: viewport.scrollLeft }; },
    goToRow(index) { return setPage(Math.floor(index / PAGE_ROWS), index); },
    dispose() { disposed = true; renderGeneration++; },
  };
}

async function patchText(model) {
  const chunks = ['--- ' + model.filePath, '+++ ' + model.filePath];
  let activeHunk = -1;
  let deadline = performance.now() + 4;
  for (const row of model.rows) {
    if (row.kind === 'gap') { activeHunk = -1; continue; }
    if (activeHunk !== row.hunk) {
      activeHunk = row.hunk;
      const hunk = model.hunks[row.hunk];
      if (hunk) {
        let oldCount = 0, newCount = 0;
        for (let i = hunk.start; i < hunk.end; i++) {
          if (model.rows[i].kind !== 'add') oldCount++;
          if (model.rows[i].kind !== 'del') newCount++;
        }
        chunks.push(model.lineNumbers === 'relative' ? '@@ Replacement fragment @@' :
          '@@ -' + (hunk.oldStart || 0) + ',' + oldCount + ' +' + (hunk.newStart || 0) + ',' + newCount + ' @@');
      }
    }
    chunks.push((row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ') + row.text);
    if (row.noNewline) chunks.push('\\ No newline at end of file');
    if (performance.now() >= deadline) { await new Promise(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 4; }
  }
  return chunks.join('\n') + '\n';
}

/** Open the same model in a bounded, searchable complete view. */
export function openFullDiff(model, options = {}) {
  activeDialog?.close();
  const previousFocus = document.activeElement;
  const dialog = element('dialog', 'data-incipit-diff-dialog');
  dialog.setAttribute('aria-label', 'File diff: ' + model.filePath);
  dialog.setAttribute('data-incipit-diff-island', '');
  dialog.setAttribute('data-incipit-write-diff-modal-content', '');
  const header = element('div', 'data-incipit-diff-header');
  header.appendChild(element('span', 'data-incipit-diff-title', basename(model.filePath)));
  const counts = element('span', 'data-incipit-diff-counts'); updateCounts(counts, model); header.appendChild(counts);
  const closeButton = button('Close', () => close(), 'data-incipit-diff-close');
  header.appendChild(closeButton);
  const fullPath = element('div', 'data-incipit-diff-full-path', model.filePath);
  const tools = element('div', 'data-incipit-diff-toolbar');
  const find = element('input', 'data-incipit-diff-find'); find.type = 'search'; find.placeholder = 'Find in diff'; find.setAttribute('aria-label', 'Find in the complete diff');
  const searchStatus = element('span', 'data-incipit-diff-search-status'); searchStatus.setAttribute('aria-live', 'polite');
  const notice = element('div', 'data-incipit-diff-notice', model.notice || ''); notice.hidden = !model.notice; notice.setAttribute('aria-live', 'polite');
  const content = element('div', 'data-incipit-diff-full-content');
  dialog.append(header, fullPath, tools, notice, content);
  const rows = createRowViewport(content, model, options);
  let searchGeneration = 0, timer = null, matches = [], match = -1, closed = false;
  async function search() {
    const token = ++searchGeneration;
    const needle = find.value.toLowerCase(); matches = []; match = -1;
    if (!needle) { searchStatus.textContent = ''; return; }
    searchStatus.textContent = 'Searching\u2026';
    let deadline = performance.now() + 4;
    for (let i = 0; i < model.rows.length; i++) {
      if (model.rows[i].kind !== 'gap' && model.rows[i].text.toLowerCase().includes(needle)) matches.push(i);
      if (performance.now() >= deadline) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (closed || token !== searchGeneration) return;
        deadline = performance.now() + 4;
      }
    }
    moveMatch(1);
  }
  function moveMatch(direction) {
    if (!matches.length) { searchStatus.textContent = 'No matches'; return; }
    match = (match + direction + matches.length) % matches.length;
    searchStatus.textContent = (match + 1) + ' / ' + matches.length;
    rows.goToRow(matches[match]);
  }
  tools.append(find, button('Previous match', () => moveMatch(-1)), button('Next match', () => moveMatch(1)), searchStatus,
    button(model.lineNumbers === 'relative' ? 'Copy changes' : 'Copy patch', async () => {
      try { await navigator.clipboard.writeText(await patchText(model)); notice.textContent = 'Changes copied.'; }
      catch (_) { notice.textContent = 'Clipboard access was denied. Select and copy the visible code, or try again.'; }
      notice.hidden = false;
    }));
  find.addEventListener('input', () => { searchGeneration++; clearTimeout(timer); timer = setTimeout(search, 150); });
  find.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } });
  function close() {
    if (closed) return;
    closed = true; searchGeneration++; clearTimeout(timer); rows.dispose();
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    dialog.remove();
    if (activeDialog?.node === dialog) activeDialog = null;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); find.focus(); find.select(); }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
  document.body.appendChild(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
  activeDialog = { node: dialog, close };
  closeButton.focus();
  return { close };
}

/** Attach a lazy preview to an incipit-owned body without changing host message state. */
export function createDiffPreview(container, options) {
  container.setAttribute('data-incipit-diff-view', '');
  container.setAttribute('data-incipit-diff-island', '');
  container.setAttribute('data-incipit-write-diff', '');
  const header = element('div', 'data-incipit-diff-header');
  const title = button(basename(options.filePath), () => {
    try { options.openFile?.(options.filePath); }
    catch (error) { notice.hidden = false; notice.textContent = error.message || 'The file could not be opened.'; }
  }, 'data-incipit-diff-title');
  title.disabled = !options.openFile;
  title.dataset.incipitToolFullpath = options.filePath;
  const counts = element('span', 'data-incipit-diff-counts'); counts.hidden = true;
  let model = null, rowView = null, controller = null, visible = false, disposed = false, generation = 0, savedPosition = null, positionCaptured = false;
  const complete = button('Full diff', () => { if (model) openFullDiff(model, options); }, 'data-incipit-diff-full'); complete.disabled = true;
  header.append(title, counts, complete);
  const notice = element('div', 'data-incipit-diff-notice'); notice.setAttribute('aria-live', 'polite');
  const retry = button('Retry', () => load(true), 'data-incipit-diff-retry'); retry.hidden = true;
  const content = element('div', 'data-incipit-diff-preview-content');
  container.replaceChildren(header, notice, retry, content);
  function showRows() {
    if (!model || rowView) return;
    content.replaceChildren();
    if (model.rows.length) rowView = createRowViewport(content, model, { ...options, initialState: savedPosition });
    else content.appendChild(element('div', 'data-incipit-diff-empty', 'No text changes.'));
  }
  async function load(refresh = false) {
    if (!visible || disposed || (model && !refresh)) return;
    controller?.abort(); controller = new AbortController();
    const token = ++generation;
    container.dataset.incipitDiffState = 'loading'; notice.hidden = false; notice.textContent = 'Loading historical diff\u2026'; retry.hidden = true;
    try {
      const next = await options.loadModel({ signal: controller.signal, refresh });
      if (disposed || !visible || generation !== token) return;
      model = next; rowView?.dispose(); rowView = null; showRows();
      updateCounts(counts, model); options.onStats?.(model.statsScope === 'complete' && model.quality !== 'coarse' ? model.stats : null);
      notice.textContent = model.notice || ''; notice.hidden = !model.notice;
      container.dataset.incipitDiffState = 'ready'; complete.disabled = false;
    } catch (error) {
      if (error.name === 'AbortError' || disposed || generation !== token) return;
      container.dataset.incipitDiffState = error.code === 'permission-denied' ? 'permission' : 'error';
      notice.textContent = error.message || 'The historical diff could not be loaded.'; notice.hidden = false; retry.hidden = false;
    }
  }
  return {
    rememberPosition() { if (rowView) { savedPosition = rowView.snapshot(); positionCaptured = true; } },
    setVisible(value) {
      visible = value;
      if (visible) { if (model) showRows(); else load(); }
      else {
        controller?.abort(); generation++;
        if (rowView && !positionCaptured) savedPosition = rowView.snapshot();
        positionCaptured = false;
        rowView?.dispose(); rowView = null; content.replaceChildren();
        model = null; complete.disabled = true;
      }
    },
    invalidate() { model = null; savedPosition = null; complete.disabled = true; updateCounts(counts, null); controller?.abort(); generation++; rowView?.dispose(); rowView = null; content.replaceChildren(); if (visible) load(); },
    dispose() { disposed = true; generation++; controller?.abort(); rowView?.dispose(); },
  };
}

export async function showDiffPayload(payload, options = {}) {
  const model = await getDiffModel({ ...payload, source: payload.source || 'review' }, { signal: options.signal });
  if (options.signal?.aborted) throw Object.assign(new Error('The diff view was closed.'), { name: 'AbortError' });
  options.beforeOpen?.();
  return openFullDiff(model, options);
}

export function closeFullDiff() { activeDialog?.close(); }
