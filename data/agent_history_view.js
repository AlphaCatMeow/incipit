import { fetchAgentActivity } from './agent_activity_source.js';
import { buildHeadline, FILE_CHANGES } from './tool_headline.js';
import { loadHistoricalDiff } from './diff/history.js';
import { createDiffPreview } from './diff/view.js';
import { resolveFileReference } from './file_reference.js';
import { createAgentRichText } from './agent_rich_text.js';
import { createOwnedActivityGroups } from './activity_groups.js';
import { applyToolBodyTruncation } from './tool_row_preview.js';
import { element, action, iconAction, setToolSurface, copyAction, disposeActions, errorView, foldBody, setText, sourceAction } from './agent_activity_dom.js';

function plain(blocks) {
  return blocks.map(block => block.text ?? block.inputPreview ?? (block.type === 'tool_use' ? JSON.stringify(block.input, null, 2) : '')).join('\n\n');
}

function valueView(block, options, signal) {
  if (block.type === 'text' || block.type === 'thinking') return createAgentRichText(block.text || '', { fileAction: options.linkAction || options.fileAction, signal });
  if (block.type === 'image' && block.source?.type === 'base64') {
    const image = element('img', 'data-incipit-agent-image'); image.alt = 'Agent attachment';
    image.src = `data:${block.source.media_type};base64,${block.source.data}`; return image;
  }
  return element('pre', 'data-incipit-agent-raw', block.text || block.notice || 'Thinking details were not recorded.');
}

/** A paginated, read-only transcript owned entirely by incipit. */
export function createAgentHistoryView(scope, options) {
  const root = setToolSurface(element('section', 'data-incipit-agent-history'), options.surfaceLevel); root.setAttribute('aria-label', 'Agent activity');
  const childSurfaceLevel = (options.surfaceLevel || 0) + 1;
  root.setAttribute('data-incipit-diff-island', '');
  const toolbar = element('div', 'data-incipit-agent-history-toolbar');
  toolbar.setAttribute('data-incipit-diff-header', '');
  const title = element('span', 'data-incipit-diff-title');
  const pageLabel = element('span', 'data-incipit-agent-page-label');
  const notice = element('div', 'data-incipit-agent-history-notice');
  const list = element('div', 'data-incipit-agent-records'); list.tabIndex = 0;
  const previous = iconAction('Previous page', 'pagePrevious', () => load(page - 1));
  const next = iconAction('Next page', 'pageNext', () => load(page + 1));
  const latest = iconAction('Latest activity', 'latest', () => load('last'));
  const refresh = iconAction('Refresh', 'refresh', () => load(page));
  previous.setAttribute('data-incipit-agent-previous', ''); next.setAttribute('data-incipit-agent-next', '');
  toolbar.append(title, previous, pageLabel, next, latest, refresh); root.append(toolbar, notice, list);
  let active = true, disposed = false, controller = null, generation = 0, timer = null, page = 0, pages = 1, sourcePath = '';
  const views = new Map(), fullRecords = new Map();
  const rail = createOwnedActivityGroups(JSON.stringify(scope), () => [...list.children].flatMap(node =>
    views.get(node.dataset.incipitAgentRecordId)?.activityRows() || []));
  let wasRunning = options.isRunning?.() === true, settlingReads = 0;

  function fileOptions(cwd) {
    const resolve = (value, literal) => {
      const parsed = resolveFileReference(value, { cwd: cwd || scope.cwd, literal });
      return parsed ? options.fileAction?.(parsed.filePath) : null;
    };
    return { ...options, fileAction: value => resolve(value, true), linkAction: value => resolve(value, false), onActivityChange: rail.schedule };
  }

  function clearViews() { for (const view of views.values()) view.dispose(); views.clear(); list.replaceChildren(); rail.layout(); }

  async function fullRecord(record) {
    const token = generation;
    try {
      const response = await fetchAgentActivity({ ...scope, op: 'record', recordId: record.id }, { signal: controller?.signal });
      if (disposed || !active || token !== generation) return;
      if (!response.ok) throw response;
      fullRecords.set(record.id, { preview: JSON.stringify(record), value: response.record });
      views.get(record.id)?.update(response.record);
      rail.layout();
    } catch (error) {
      if (error.name === 'AbortError' || disposed || token !== generation) return;
      notice.replaceChildren(errorView(error, () => fullRecord(record)));
      const open = sourceAction(sourcePath, options); if (open) notice.append(open);
    }
  }

  function createBlock(block, record, local) {
    const key = JSON.stringify([scope, record.id, block.key]);
    if (block.type === 'tool_use' && ['Agent', 'Task', 'Workflow', 'RunWorkflow'].includes(block.name) && options.createInvocation) {
      const target = element('div', 'data-incipit-agent-nested-call'); target.setAttribute('data-incipit-tool-use', '');
      const nestedScope = { sessionId: scope.sessionId, cwd: scope.cwd, toolUseId: block.id,
        ancestors: [...scope.ancestors || [], { toolUseId: scope.toolUseId, agentId: scope.agentId }] };
      const asData = value => ({ block: { ...value, type: 'tool_use' }, result: value.result ? { type: 'tool_result', tool_use_id: value.id, is_error: value.result.failed, content: plain(value.result.content) } : null });
      const invocation = options.createInvocation(target, asData(block), { ...local, scope: nestedScope, surfaceLevel: childSurfaceLevel });
      return { node: target, update: value => invocation.update(asData(value)), dispose: () => invocation.dispose(), setActive: value => invocation.setVisible?.(value) };
    }
    if (block.type === 'tool_use') return createLeafTool(block, record, local, key);
    const thinking = block.type === 'thinking' || block.type === 'redacted_thinking';
    const isStatic = thinking && (block.type === 'redacted_thinking' || !block.text);
    const container = element(thinking && !isStatic ? 'details' : 'div', 'data-incipit-agent-block');
    let abort = new AbortController(), signature = '', current = block, visible = true;
    let body = container, animationTimer = null;
    function render() {
      if (!visible || (thinking && (!container.open || isStatic))) return;
      const next = JSON.stringify(current); if (next === signature) return; signature = next;
      abort.abort(); abort = new AbortController();
      body.replaceChildren(valueView(current, local, abort.signal));
    }
    if (thinking) {
      container.setAttribute(isStatic ? 'data-incipit-thinking-static' : 'data-incipit-thinking', '');
      container.setAttribute('data-incipit-owned-thinking', '');
      const summary = element(isStatic ? 'span' : 'summary', 'data-incipit-thinking-summary', 'Thinking');
      const content = element('div', 'data-incipit-thinking-content'); body = element('div'); content.append(body); container.append(summary, content);
      if (isStatic) { content.hidden = true; summary.title = 'No thinking details were recorded'; }
      else {
        container.open = options.choices.get(key) === true;
        summary.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation(); clearTimeout(animationTimer);
          if (container.hasAttribute('data-incipit-thinking-closing')) {
            container.removeAttribute('data-incipit-thinking-closing'); options.choices.set(key, true); render(); return;
          }
          if (container.open) {
            abort.abort(); signature = ''; options.choices.set(key, false);
            container.setAttribute('data-incipit-thinking-closing', '1');
            animationTimer = setTimeout(() => { container.removeAttribute('data-incipit-thinking-closing'); container.open = false; body.replaceChildren(); }, 220);
          } else {
            container.open = true; options.choices.set(key, true); container.setAttribute('data-incipit-thinking-opening', '1');
            render();
            animationTimer = setTimeout(() => container.removeAttribute('data-incipit-thinking-opening'), 280);
          }
        });
      }
    }
    return { node: container,
      update(nextBlock) { current = nextBlock; render(); },
      dispose() { abort.abort(); clearTimeout(animationTimer); },
      setActive(value) { if (visible === value) return; visible = value; if (value) render(); else { abort.abort(); signature = ''; } },
    };
  }

  function createLeafTool(initial, record, local, key) {
    let block = initial, bodySignature = '', diff = null, contentAbort = new AbortController(), visible = true;
    const target = element('div', 'data-incipit-agent-tool'); target.setAttribute('data-incipit-tool-use', '');
    const headline = buildHeadline(target, { getIdentity: () => ({ cwd: record.cwd }), fileAction: local.fileAction, onStateChange: rail.schedule, onRetryPaths: () => view.update(block), toggle: () => setOpen(!fold.open) });
    const fold = foldBody(headline.toggle, { onOpen: renderBody, onClose: () => { contentAbort.abort(); diff?.setVisible(false); }, onClosed: () => { fold.inner.replaceChildren(); diff?.dispose(); diff = null; bodySignature = ''; } });
    target.append(fold.root);

    function setOpen(value) { options.choices.set(key, value); headline.setOpen(value); target.dataset.incipitToolCollapsed = String(!value); fold.setOpen(value); }
    function renderBody() {
      if (!visible) return;
      if (bodySignature === JSON.stringify(block) && fold.inner.childNodes.length) { diff?.setVisible(true); return; }
      bodySignature = JSON.stringify(block); contentAbort.abort(); contentAbort = new AbortController(); diff?.dispose(); diff = null;
      fold.inner.replaceChildren();
      if (FILE_CHANGES.has(block.name) && block.input?.file_path && !block.result?.failed) {
        const host = setToolSurface(element('div', 'data-incipit-agent-diff'), childSurfaceLevel); fold.inner.append(host);
        diff = createDiffPreview(host, { filePath: block.input.file_path, retryInputPreview: true, loadModel({ signal, onPreview }) {
          return loadHistoricalDiff({ block, key: key + ':diff', signal, onPreview, request: async () => {
            const response = await fetchAgentActivity({ ...scope, op: 'tool-diff', innerToolUseId: block.id, filePath: block.input.file_path }, { signal });
            if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code, retryable: true });
            return response.diff;
          } });
        }, onStats: stats => headline.setCounts(stats) });
        diff.setVisible(true);
        return;
      }
      const grid = setToolSurface(element('div', 'data-incipit-tool-io'), childSurfaceLevel);
      const ioRow = label => {
        const row = element('div', 'data-incipit-tool-io-row');
        const content = element('div', 'data-incipit-tool-io-content');
        row.append(element('span', 'data-incipit-tool-io-label', label), content); grid.append(row); return content;
      };
      const inputText = block.inputPreview || (typeof block.input?.command === 'string' ? block.input.command : JSON.stringify(block.input || {}, null, 2));
      ioRow('IN').append(element('pre', '', inputText));
      if (block.result) {
        const output = ioRow('OUT');
        if (block.result.failed) output.setAttribute('data-incipit-agent-error', '');
        const result = element('div', 'data-incipit-tool-output'); output.append(result);
        for (const value of block.result.content) result.append(value.type === 'text' ? element('pre', '', value.text || '') : valueView(value, local, contentAbort.signal));
      } else ioRow('OUT').append(element('span', '', 'Result not recorded yet'));
      fold.inner.append(grid);
      applyToolBodyTruncation(grid, block.name);
      if (block.truncated || block.result?.content.some(value => value.truncated)) fold.inner.append(iconAction('Show full record', 'expand', () => fullRecord(record)));
    }
    const view = { node: target,
      update(next) {
        block = next;
        const state = block.result ? block.result.failed ? 'error' : 'complete' : options.isRunning?.() ? 'running' : 'unknown';
        headline.update({ block: { ...block, type: 'tool_use' }, status: state }, true);
        if (fold.open) renderBody();
      },
      dispose() { contentAbort.abort(); diff?.dispose(); fold.dispose(); },
      setActive(value) { if (visible === value) return; visible = value; if (!value) { contentAbort.abort(); diff?.setVisible(false); } else if (fold.open) renderBody(); },
    };
    view.update(initial);
    if (options.choices.get(key)) { headline.setOpen(true); fold.setOpen(true, false); }
    return view;
  }

  function createRecord(record) {
    const node = element('article', 'data-incipit-agent-record');
    node.dataset.incipitAgentRole = record.role;
    node.dataset.incipitAgentRecordId = record.id;
    let current = record, signature = '', inputFold = null, visible = true;
    const content = element('div', 'data-incipit-agent-record-content');
    const controls = element('div', 'data-incipit-agent-record-actions'); controls.append(copyAction(() => plain(current.blocks)));
    const children = new Map();
    if (record.role === 'user') {
      const toggle = action(record.compact ? 'Context summary' : 'Task input', () => { inputFold.setOpen(!inputFold.open); toggle.setAttribute('aria-expanded', String(inputFold.open)); });
      toggle.setAttribute('aria-expanded', 'false');
      inputFold = foldBody(toggle, { onOpen: () => { signature = ''; view.update(current); },
        onClose: () => { for (const child of children.values()) child.setActive(false); },
        onClosed: () => { for (const child of children.values()) child.dispose(); children.clear(); content.replaceChildren(); signature = ''; } });
      inputFold.inner.append(content, controls); node.append(toggle, inputFold.root);
    } else node.append(content);
    if (record.role !== 'user') node.append(controls);
    const view = { node,
      update(nextRecord) {
        current = nextRecord;
        if (inputFold && !inputFold.open) return;
        const nextSignature = JSON.stringify(current); if (signature === nextSignature) return; signature = nextSignature;
        const keep = new Set(), local = fileOptions(current.cwd);
        current.blocks.forEach((block, index) => {
          keep.add(block.key);
          let view = children.get(block.key);
          if (!view) {
            view = createBlock(block, current, local); view.row = element('div', 'data-incipit-activity-row'); view.row.append(view.node); children.set(block.key, view);
          }
          view.kind = block.type === 'tool_use' ? 'tool' : ['thinking', 'redacted_thinking'].includes(block.type) ? 'thinking' : 'text';
          view.update(block);
          if (content.children[index] !== view.row) content.insertBefore(view.row, content.children[index] || null);
        });
        for (const [key, view] of children) if (!keep.has(key)) { view.dispose(); view.row.remove(); children.delete(key); }
        const truncated = current.blocks.some(block => block.truncated);
        controls.hidden = !truncated && current.blocks.every(block => ['tool_use', 'thinking', 'redacted_thinking'].includes(block.type));
        let full = controls.querySelector('[data-incipit-agent-full-record]');
        if (truncated && !full) { full = iconAction('Show full record', 'expand', () => fullRecord(record)); full.setAttribute('data-incipit-agent-full-record', ''); controls.append(full); }
        if (full) full.hidden = !truncated;
      },
      activityRows() { return current.role === 'user' ? [{ row: node, kind: 'user' }] :
        current.blocks.map(block => children.get(block.key)).filter(Boolean).map(child => ({ row: child.row, kind: child.kind,
          tools: child.kind === 'tool' ? [child.node] : [], setActive: value => child.setActive(active && visible && value) })); },
      dispose() { for (const child of children.values()) child.dispose(); inputFold?.dispose(); disposeActions(controls); },
      setActive(value) { visible = value; for (const child of children.values()) child.setActive(value && (!inputFold || inputFold.open) && !child.row.hasAttribute('data-incipit-activity-collapsed')); },
    };
    return view;
  }

  function schedule() {
    clearTimeout(timer);
    const running = options.isRunning?.() === true;
    if (wasRunning && !running) settlingReads = 3;
    wasRunning = running;
    if (active && !disposed && (running || settlingReads > 0)) timer = setTimeout(() => {
      const selection = window.getSelection();
      if (document.visibilityState === 'hidden' || (selection && !selection.isCollapsed && root.contains(selection.anchorNode))) { schedule(); return; }
      if (!running) settlingReads--;
      load(page, true);
    }, 1800);
  }

  async function load(value = page, quiet = false) {
    if (disposed || !active) return;
    const token = ++generation; controller?.abort(); controller = new AbortController();
    root.setAttribute('aria-busy', 'true');
    refresh.disabled = true;
    if (!quiet) notice.replaceChildren(element('span', 'data-incipit-agent-notice', 'Loading…'));
    try {
      const response = await fetchAgentActivity({ ...scope, op: 'messages', page: value }, { signal: controller.signal });
      if (disposed || !active || token !== generation) return;
      if (!response.ok) throw response;
      const changedPage = page !== response.page;
      if (changedPage) { clearViews(); fullRecords.clear(); list.scrollTop = 0; }
      page = response.page; pages = response.pages; sourcePath = response.transcriptPath;
      previous.disabled = page === 0; next.disabled = page >= pages - 1; latest.disabled = page >= pages - 1;
      previous.hidden = next.hidden = latest.hidden = pages <= 1;
      setText(title, typeof options.title === 'function' ? options.title() : options.title || 'Agent'); title.title = title.textContent;
      setText(pageLabel, `${page + 1} / ${pages}`); pageLabel.hidden = pages <= 1;
      pageLabel.title = `Page ${page + 1} of ${pages}, ${response.total} records`;
      const keep = new Set();
      let deadline = performance.now() + 4;
      for (const [index, record] of response.records.entries()) {
        keep.add(record.id);
        let view = views.get(record.id); if (!view) { view = createRecord(record); views.set(record.id, view); }
        const full = fullRecords.get(record.id);
        if (full && full.preview !== JSON.stringify(record)) fullRecords.delete(record.id);
        view.update(fullRecords.get(record.id)?.value || record);
        if (list.children[index] !== view.node) list.insertBefore(view.node, list.children[index] || null);
        if (performance.now() >= deadline) {
          rail.layout(); await new Promise(resolve => setTimeout(resolve, 0));
          if (disposed || !active || token !== generation) return;
          deadline = performance.now() + 4;
        }
      }
      for (const [id, view] of views) if (!keep.has(id)) { view.dispose(); view.node.remove(); views.delete(id); }
      rail.layout();
      notice.replaceChildren();
      if (!response.records.length) notice.append(element('span', 'data-incipit-agent-notice', 'No activity recorded yet'));
      if (response.partial) notice.append(element('span', 'data-incipit-agent-notice', 'The latest record is still being saved'));
      let open = toolbar.querySelector('[data-incipit-agent-open-source]');
      if (!open) { open = sourceAction(sourcePath, options); if (open) { open.setAttribute('data-incipit-agent-open-source', ''); toolbar.append(open); } }
    } catch (error) {
      if (disposed || token !== generation || error.name === 'AbortError') return;
      notice.replaceChildren(errorView(error, () => load(page)));
      const open = sourceAction(error.transcriptPath || sourcePath, options); if (open) notice.append(open);
    } finally {
      if (token === generation) { refresh.disabled = false; root.removeAttribute('aria-busy'); schedule(); }
    }
  }

  load();
  return { root,
    refresh: () => load(page),
    setActive(value) { if (active === value) return; active = value; clearTimeout(timer); if (!value) { generation++; controller?.abort(); root.removeAttribute('aria-busy'); for (const view of views.values()) view.setActive(false); } else { for (const view of views.values()) view.setActive(true); load(page, true); } },
    dispose() { disposed = true; generation++; controller?.abort(); clearTimeout(timer); rail.dispose(); clearViews(); fullRecords.clear(); disposeActions(root); },
  };
}
