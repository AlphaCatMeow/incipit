import { fetchAgentActivity } from './agent_activity_source.js';
import { buildHeadline, FILE_CHANGES } from './tool_headline.js';
import { getDiffModel } from './diff/client.js';
import { createDiffPreview } from './diff/view.js';
import { resolveFileReference } from './file_reference.js';
import { createAgentRichText } from './agent_rich_text.js';
import { element, action, copyAction, errorView, foldBody, setText, sourceAction } from './agent_activity_dom.js';

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
  const root = element('section', 'data-incipit-agent-history'); root.setAttribute('aria-label', 'Agent activity');
  const toolbar = element('div', 'data-incipit-agent-history-toolbar');
  const pageLabel = element('span', 'data-incipit-agent-page-label');
  const notice = element('div', 'data-incipit-agent-history-notice');
  const list = element('div', 'data-incipit-agent-records'); list.tabIndex = 0;
  const previous = action('Previous', () => load(page - 1));
  const next = action('Next', () => load(page + 1));
  const latest = action('Latest', () => load('last'));
  const refresh = action('Refresh', () => load(page));
  toolbar.append(previous, pageLabel, next, latest, refresh); root.append(toolbar, notice, list);
  let active = true, disposed = false, controller = null, generation = 0, timer = null, page = 0, pages = 1, sourcePath = '';
  const views = new Map(), fullRecords = new Map();
  let wasRunning = options.isRunning?.() === true, settlingReads = 0;

  function fileOptions(cwd) {
    const resolve = (value, literal) => {
      const parsed = resolveFileReference(value, { cwd: cwd || scope.cwd, literal });
      return parsed ? options.fileAction?.(parsed.filePath) : null;
    };
    return { ...options, fileAction: value => resolve(value, true), linkAction: value => resolve(value, false) };
  }

  function clearViews() { for (const view of views.values()) view.dispose(); views.clear(); list.replaceChildren(); }

  async function fullRecord(record) {
    try {
      const response = await fetchAgentActivity({ ...scope, op: 'record', recordId: record.id }, { signal: controller?.signal });
      if (disposed || !active) return;
      if (!response.ok) throw response;
      fullRecords.set(record.id, { preview: JSON.stringify(record), value: response.record });
      views.get(record.id)?.update(response.record);
    } catch (error) {
      if (error.name === 'AbortError' || disposed) return;
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
      const invocation = options.createInvocation(target, asData(block), { ...local, scope: nestedScope });
      return { node: target, update: value => invocation.update(asData(value)), dispose: () => invocation.dispose(), setActive: value => invocation.setVisible?.(value) };
    }
    if (block.type === 'tool_use') return createLeafTool(block, record, local, key);
    const container = element('div', 'data-incipit-agent-block');
    let abort = new AbortController(), signature = '';
    let fold = null;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      const toggle = action('Thinking', () => { fold.setOpen(!fold.open); toggle.setAttribute('aria-expanded', String(fold.open)); options.choices.set(key, fold.open); });
      toggle.setAttribute('data-incipit-agent-thinking', '');
      toggle.setAttribute('aria-expanded', String(options.choices.get(key) === true));
      fold = foldBody(toggle); container.append(toggle, fold.root);
      if (block.type === 'redacted_thinking' || !block.text) { toggle.disabled = true; toggle.title = 'Thinking details were not recorded.'; }
      else if (options.choices.get(key)) fold.setOpen(true, false);
    }
    return { node: container,
      update(nextBlock) {
        const next = JSON.stringify(nextBlock); if (next === signature) return; signature = next;
        abort.abort(); abort = new AbortController();
        const body = fold?.inner || container;
        body.replaceChildren(valueView(nextBlock, local, abort.signal));
      },
      dispose() { abort.abort(); fold?.dispose(); }, setActive() {},
    };
  }

  function createLeafTool(initial, record, local, key) {
    let block = initial, bodySignature = '', diff = null, contentAbort = new AbortController();
    const target = element('div', 'data-incipit-agent-tool'); target.setAttribute('data-incipit-tool-use', '');
    const headline = buildHeadline(target, { getIdentity: () => ({ cwd: record.cwd }), fileAction: local.fileAction, onRetryPaths: () => view.update(block), toggle: () => setOpen(!fold.open) });
    const fold = foldBody(headline.toggle, { onOpen: renderBody, onClose: () => { contentAbort.abort(); diff?.setVisible(false); }, onClosed: () => { fold.inner.replaceChildren(); diff?.dispose(); diff = null; bodySignature = ''; } });
    target.append(fold.root);

    function setOpen(value) { options.choices.set(key, value); headline.setOpen(value); fold.setOpen(value); }
    function renderBody() {
      if (bodySignature === JSON.stringify(block) && fold.inner.childNodes.length) { diff?.setVisible(true); return; }
      bodySignature = JSON.stringify(block); contentAbort.abort(); contentAbort = new AbortController(); diff?.dispose(); diff = null;
      fold.inner.replaceChildren();
      if (FILE_CHANGES.has(block.name) && block.input?.file_path && !block.result?.failed) {
        const host = element('div', 'data-incipit-agent-diff'); fold.inner.append(host);
        diff = createDiffPreview(host, { filePath: block.input.file_path, async loadModel({ signal }) {
          const response = await fetchAgentActivity({ ...scope, op: 'tool-diff', innerToolUseId: block.id, filePath: block.input.file_path }, { signal });
          if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code });
          const payload = response.diff;
          if (!payload?.ok || payload.state !== 'ready') throw new Error(payload?.notice || payload?.error || 'The saved diff is not available yet.');
          return getDiffModel(payload, { key: key + ':diff', signal });
        }, onStats: stats => headline.setCounts(stats) });
        diff.setVisible(true);
      }
      const input = element('details', 'data-incipit-agent-raw-details');
      input.append(element('summary', '', 'Input'), element('pre', 'data-incipit-agent-raw', block.inputPreview || JSON.stringify(block.input || {}, null, 2)));
      fold.inner.append(input);
      if (block.result) {
        const output = element('div', 'data-incipit-agent-tool-output');
        if (block.result.failed) output.setAttribute('data-incipit-agent-error', '');
        for (const value of block.result.content) output.append(valueView(value, local, contentAbort.signal));
        fold.inner.append(output);
      } else fold.inner.append(element('div', 'data-incipit-agent-notice', 'No tool result has been recorded yet.'));
      if (block.truncated || block.result?.content.some(value => value.truncated)) fold.inner.append(action('Show full record', () => fullRecord(record)));
    }
    const view = { node: target,
      update(next) {
        block = next;
        const state = block.result ? block.result.failed ? 'error' : 'complete' : options.isRunning?.() ? 'running' : 'unknown';
        headline.update({ block: { ...block, type: 'tool_use' }, status: state }, true);
        if (fold.open) renderBody();
      },
      dispose() { contentAbort.abort(); diff?.dispose(); fold.dispose(); },
      setActive(value) { if (!value) { contentAbort.abort(); diff?.setVisible(false); } else if (fold.open) renderBody(); },
    };
    view.update(initial);
    if (options.choices.get(key)) { headline.setOpen(true); fold.setOpen(true, false); }
    return view;
  }

  function createRecord(record) {
    const node = element('article', 'data-incipit-agent-record');
    node.dataset.incipitAgentRole = record.role;
    let current = record, signature = '', inputFold = null;
    const content = element('div', 'data-incipit-agent-record-content');
    const controls = element('div', 'data-incipit-agent-record-actions'); controls.append(copyAction(() => plain(current.blocks)));
    const children = new Map();
    if (record.role === 'user') {
      const toggle = action(record.compact ? 'Context summary' : 'Task input', () => { inputFold.setOpen(!inputFold.open); toggle.setAttribute('aria-expanded', String(inputFold.open)); });
      toggle.setAttribute('aria-expanded', 'false');
      inputFold = foldBody(toggle); inputFold.inner.append(content, controls); node.append(toggle, inputFold.root);
    } else node.append(content);
    if (record.role !== 'user') node.append(controls);
    return { node,
      update(nextRecord) {
        current = nextRecord;
        const nextSignature = JSON.stringify(current); if (signature === nextSignature) return; signature = nextSignature;
        const keep = new Set(), local = fileOptions(current.cwd);
        current.blocks.forEach((block, index) => {
          keep.add(block.key);
          let view = children.get(block.key);
          if (!view) { view = createBlock(block, current, local); children.set(block.key, view); }
          view.update(block);
          if (content.children[index] !== view.node) content.insertBefore(view.node, content.children[index] || null);
        });
        for (const [key, view] of children) if (!keep.has(key)) { view.dispose(); view.node.remove(); children.delete(key); }
        const truncated = current.blocks.some(block => block.truncated);
        controls.hidden = !truncated && current.blocks.every(block => ['tool_use', 'thinking', 'redacted_thinking'].includes(block.type));
        let full = controls.querySelector('[data-incipit-agent-full-record]');
        if (truncated && !full) { full = action('Show full record', () => fullRecord(record)); full.setAttribute('data-incipit-agent-full-record', ''); controls.append(full); }
        if (full) full.hidden = !truncated;
      },
      dispose() { for (const child of children.values()) child.dispose(); inputFold?.dispose(); },
      setActive(value) { for (const child of children.values()) child.setActive(value); },
    };
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
    if (!quiet) notice.replaceChildren(element('span', 'data-incipit-agent-notice', 'Loading activity…'));
    try {
      const response = await fetchAgentActivity({ ...scope, op: 'messages', page: value }, { signal: controller.signal });
      if (disposed || !active || token !== generation) return;
      if (!response.ok) throw response;
      const changedPage = page !== response.page;
      if (changedPage) { clearViews(); fullRecords.clear(); list.scrollTop = 0; }
      page = response.page; pages = response.pages; sourcePath = response.transcriptPath;
      previous.disabled = page === 0; next.disabled = page >= pages - 1; latest.disabled = page >= pages - 1;
      previous.hidden = next.hidden = latest.hidden = pages <= 1;
      setText(pageLabel, response.total ? `${pages > 1 ? `Page ${page + 1} of ${pages} · ` : ''}${response.total} messages` : 'No messages yet');
      const keep = new Set();
      response.records.forEach((record, index) => {
        keep.add(record.id);
        let view = views.get(record.id); if (!view) { view = createRecord(record); views.set(record.id, view); }
        const full = fullRecords.get(record.id);
        if (full && full.preview !== JSON.stringify(record)) fullRecords.delete(record.id);
        view.update(fullRecords.get(record.id)?.value || record);
        if (list.children[index] !== view.node) list.insertBefore(view.node, list.children[index] || null);
      });
      for (const [id, view] of views) if (!keep.has(id)) { view.dispose(); view.node.remove(); views.delete(id); }
      notice.replaceChildren();
      if (!response.records.length) notice.append(element('span', 'data-incipit-agent-notice', 'No activity has been recorded yet.'));
      if (response.partial) notice.append(element('span', 'data-incipit-agent-notice', 'The latest record is still being saved.'));
      let open = toolbar.querySelector('[data-incipit-agent-open-source]');
      if (!open) { open = sourceAction(sourcePath, options); if (open) { open.setAttribute('data-incipit-agent-open-source', ''); toolbar.append(open); } }
    } catch (error) {
      if (disposed || token !== generation || error.name === 'AbortError') return;
      notice.replaceChildren(errorView(error, () => load(page)));
      const open = sourceAction(error.transcriptPath || sourcePath, options); if (open) notice.append(open);
    } finally {
      if (token === generation) { root.removeAttribute('aria-busy'); schedule(); }
    }
  }

  load();
  return { root,
    refresh: () => load(page),
    setActive(value) { if (active === value) return; active = value; clearTimeout(timer); if (!value) { generation++; controller?.abort(); root.removeAttribute('aria-busy'); for (const view of views.values()) view.setActive(false); } else { for (const view of views.values()) view.setActive(true); load(page, true); } },
    dispose() { disposed = true; generation++; controller?.abort(); clearTimeout(timer); clearViews(); fullRecords.clear(); },
  };
}
