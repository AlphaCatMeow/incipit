'use strict';

const fs = require('fs');
const path = require('path');
const { createAgentJournal, historyError, blocks } = require('./agent-journal.cjs');
const { createToolDiffSource } = require('./tool-diff-source.cjs');

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const WORKFLOW_TOOLS = new Set(['Workflow', 'RunWorkflow']);
const PAGE_SIZE = 24;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const PREVIEW_CHARS = 16000;

function identifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
function textContent(entry) { return blocks(entry).filter(block => block?.type === 'text').map(block => block.text || '').join('\n'); }
function inside(root, target) { const relative = path.relative(root, target); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }
function toolKind(name) { return AGENT_TOOLS.has(name) ? 'agent' : WORKFLOW_TOOLS.has(name) ? 'workflow' : null; }
function finite(value) { return Number.isFinite(value) && value >= 0 ? value : null; }

async function readJson(file, maximum = MAX_JSON_BYTES) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > maximum) throw historyError('invalid-history', 'The saved activity file is not a supported JSON record.');
  const bytes = await fs.promises.readFile(file, 'utf8');
  try { return JSON.parse(bytes); }
  catch (_) { throw historyError('invalid-history', 'The saved activity record is incomplete or unreadable. Refresh to try again.'); }
}

async function containedFile(root, file) {
  const [canonicalRoot, canonical] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(file)]);
  if (!inside(canonicalRoot, canonical)) throw historyError('permission-denied', 'Saved activity points outside this project’s history.');
  const stat = await fs.promises.stat(canonical);
  if (!stat.isFile()) throw historyError('invalid-history', 'The activity record is not a regular file.');
  return canonical;
}

function previewBlock(block, full) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'thinking') return { type: 'thinking', text: full ? String(block.thinking || '') : String(block.thinking || '').slice(0, PREVIEW_CHARS), truncated: !full && String(block.thinking || '').length > PREVIEW_CHARS };
  if (block.type === 'redacted_thinking') return { type: 'redacted_thinking' };
  if (block.type === 'text') return { type: 'text', text: full ? String(block.text || '') : String(block.text || '').slice(0, PREVIEW_CHARS), truncated: !full && String(block.text || '').length > PREVIEW_CHARS };
  if (block.type === 'image') {
    const source = block.source;
    if (source?.type === 'base64' && typeof source.data === 'string' && source.data.length <= MAX_PAGE_BYTES && /^image\/(png|jpeg|gif|webp)$/.test(source.media_type || '')) return { type: 'image', source };
    return { type: 'attachment', label: 'Image', notice: 'Open the original transcript to inspect this image source.' };
  }
  const serialized = JSON.stringify(block, null, 2);
  return { type: 'attachment', label: block.type || 'Attachment', text: full ? serialized : serialized.slice(0, PREVIEW_CHARS), truncated: !full && serialized.length > PREVIEW_CHARS };
}

/** Read only officially recorded task relationships inside one bound Claude session. */
function createAgentActivitySource({ resolveTargetFromIdentity } = {}) {
  const journal = createAgentJournal();
  const metadata = new Map();
  const queue = [];
  let active = 0, epoch = 0;

  async function agentMetadata(directory, allowedRoot) {
    const cached = metadata.get(directory);
    let directoryStat, canonicalDirectory;
    try {
      canonicalDirectory = await fs.promises.realpath(directory);
      if (!inside(allowedRoot, canonicalDirectory)) throw historyError('permission-denied', 'Saved agent metadata points outside this project’s history.');
      directoryStat = await fs.promises.stat(canonicalDirectory);
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (cached && cached.canonical === canonicalDirectory && cached.mtime === directoryStat.mtimeMs && Date.now() - cached.at < 30000) return cached.value;
    let names;
    try { names = await fs.promises.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = names.filter(name => /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(name));
    if (files.length > 2000) throw historyError('history-too-large', 'This session has too many agent metadata records for the inline viewer.');
    const value = [];
    for (let start = 0; start < files.length; start += 8) {
      const batch = await Promise.all(files.slice(start, start + 8).map(async name => {
        const file = await containedFile(allowedRoot, path.join(directory, name));
        const meta = await readJson(file, 65536);
        if (!meta || typeof meta !== 'object') throw historyError('invalid-history', 'An agent metadata record is invalid.');
        return { agentId: name.slice(6, -10), agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
          description: typeof meta.description === 'string' ? meta.description : '', toolUseId: meta.toolUseId || null, spawnDepth: finite(meta.spawnDepth) };
      }));
      value.push(...batch);
    }
    metadata.delete(directory); metadata.set(directory, { at: Date.now(), canonical: canonicalDirectory, mtime: directoryStat.mtimeMs, value });
    while (metadata.size > 8) metadata.delete(metadata.keys().next().value);
    return value;
  }

  async function invocation(caller, toolUseId, sessionDirectory, allowedRoot, details = true) {
    if (!identifier(toolUseId)) throw historyError('invalid-identity', 'The agent call identity is invalid.');
    const index = await journal.getIndex(caller);
    const useEntry = await journal.read(caller, index.tools.get(toolUseId));
    const block = blocks(useEntry).find(value => value?.type === 'tool_use' && value.id === toolUseId);
    const kind = toolKind(block?.name);
    if (!kind) throw historyError('not-found', 'This agent or workflow call has not been recorded yet.');
    const resultEntry = await journal.read(caller, index.results.get(toolUseId));
    const result = blocks(resultEntry).find(value => value?.type === 'tool_result' && value.tool_use_id === toolUseId) || null;
    const recorded = blocks(resultEntry).filter(value => value?.type === 'tool_result').length === 1 ? resultEntry?.toolUseResult : null;
    const resultMeta = recorded && typeof recorded === 'object' && !Array.isArray(recorded) ? recorded : {};
    const resultText = typeof result?.content === 'string' ? result.content : '';
    const info = { kind, toolUseId, block, result, resultMeta, cwd: useEntry?.cwd || index.cwd,
      taskId: identifier(resultMeta.taskId) ? resultMeta.taskId : kind === 'agent' && identifier(resultMeta.agentId) ? resultMeta.agentId : null, runId: null, snapshot: null, agents: [], source: caller,
      directory: path.join(sessionDirectory, 'subagents'), allowedRoot };
    if (kind === 'workflow') {
      const runId = resultMeta.runId || /^Run ID:\s*([A-Za-z0-9_-]+)\s*$/m.exec(resultText)?.[1] || block.input?.resumeFromRunId;
      info.taskId ||= /Task ID:\s*([A-Za-z0-9_-]+)/.exec(resultText)?.[1] || null;
      info.notification = index.notifications.get(info.taskId);
      if (!identifier(runId)) return info;
      info.runId = runId;
      info.directory = path.join(sessionDirectory, 'subagents', 'workflows', runId);
      if (!details) return info;
      try {
        const snapshotFile = await containedFile(allowedRoot, path.join(sessionDirectory, 'workflows', runId + '.json'));
        const snapshot = await readJson(snapshotFile);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
            ['phases', 'workflowProgress', 'logs'].some(key => snapshot[key] !== undefined && !Array.isArray(snapshot[key]))) throw historyError('invalid-history', 'The workflow snapshot uses an unsupported format.');
        if (snapshot.runId !== runId) throw historyError('identity-mismatch', 'The workflow snapshot belongs to another run.');
        if (info.taskId && snapshot.taskId && snapshot.taskId !== info.taskId) info.notice = 'This workflow has been resumed. The saved progress belongs to another invocation of the run.';
        else { info.snapshot = snapshot; info.snapshotPath = snapshotFile; }
        info.taskId ||= snapshot.taskId || null;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Array.isArray(info.snapshot?.workflowProgress)) {
        info.agents = [...new Map(info.snapshot.workflowProgress.filter(value => value?.type === 'workflow_agent' && identifier(value.agentId)).map(value => [value.agentId, { agentId: value.agentId, description: value.label || '', agentType: value.agentType || '' }])).values()];
      } else info.agents = await agentMetadata(info.directory, allowedRoot);
      return info;
    }
    info.agents = (await agentMetadata(info.directory, allowedRoot)).filter(agent => agent.toolUseId === toolUseId);
    if (!info.agents.length && identifier(resultMeta.agentId)) info.agents = [{ agentId: resultMeta.agentId, toolUseId, agentType: block.input?.subagent_type || '', description: block.input?.description || '' }];
    info.notification = index.notifications.get(info.taskId);
    return info;
  }

  async function agentFile(info, agentId) {
    if (!identifier(agentId)) throw historyError('invalid-identity', 'The agent identity is invalid.');
    let agent = info.agents.find(value => value.agentId === agentId);
    if (!agent && info.kind === 'workflow') {
      const progress = info.snapshot?.workflowProgress;
      if (Array.isArray(progress) && progress.some(value => value?.type === 'workflow_agent' && value.agentId === agentId)) agent = { agentId };
      // Live workflow agents are scoped by their run directory before a final snapshot exists.
      if (!agent && info.runId) agent = { agentId };
    }
    if (!agent) throw historyError('identity-mismatch', 'This transcript is not associated with the selected agent call.');
    const file = await containedFile(info.allowedRoot, path.join(info.directory, 'agent-' + agentId + '.jsonl'));
    if (path.basename(file) !== 'agent-' + agentId + '.jsonl' || (info.runId && path.basename(path.dirname(file)) !== info.runId)) throw historyError('identity-mismatch', 'The saved activity path does not match this agent or workflow run.');
    const index = await journal.getIndex(file);
    const first = await journal.read(file, index.records[0]);
    if (first?.agentId && first.agentId !== agentId) throw historyError('identity-mismatch', 'The saved transcript identifies a different agent.');
    return { file, index, agent };
  }

  async function resolve(request) {
    if (!identifier(request.sessionId) || typeof request.cwd !== 'string' || !request.cwd) throw historyError('invalid-identity', 'The session identity is not available.');
    const main = resolveTargetFromIdentity(request.sessionId, request.cwd);
    if (!main) throw historyError('not-found', 'The current session has not been saved yet.');
    const sessionDirectory = path.join(path.dirname(main), request.sessionId);
    const allowedRoot = path.dirname(await fs.promises.realpath(main));
    const ancestry = request.ancestors || [];
    if (!Array.isArray(ancestry) || ancestry.length > 12) throw historyError('invalid-identity', 'The nested agent path is invalid or too deep for the inline viewer.');
    let caller = main;
    const seen = new Set();
    for (const ancestor of ancestry) {
      const key = `${ancestor?.toolUseId}:${ancestor?.agentId}`;
      if (seen.has(key)) throw historyError('invalid-identity', 'The agent relationship contains a cycle.');
      seen.add(key);
      const parent = await invocation(caller, ancestor?.toolUseId, sessionDirectory, allowedRoot, false);
      caller = (await agentFile(parent, ancestor?.agentId)).file;
    }
    const info = await invocation(caller, request.toolUseId, sessionDirectory, allowedRoot, !request.agentId);
    return { info, sessionDirectory };
  }

  function overview(info) {
    const snapshot = info.snapshot;
    const resultMeta = info.resultMeta;
    const asyncLaunch = resultMeta.isAsync === true || resultMeta.status === 'async_launched' || info.kind === 'workflow';
    const terminal = value => ['completed', 'failed', 'stopped', 'killed', 'paused'].includes(value) ? value : '';
    const state = snapshot?.status || terminal(info.notification?.status) || terminal(resultMeta.status) || (info.result?.is_error ? 'failed' : info.result && !asyncLaunch ? 'completed' : 'unknown');
    const resultText = snapshot?.result === undefined ? '' : typeof snapshot.result === 'string' ? snapshot.result : JSON.stringify(snapshot.result);
    let logBytes = 0, logsTruncated = false;
    const logs = [];
    for (const value of snapshot?.logs || []) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (logBytes + text.length > 64000) { logsTruncated = true; break; }
      logBytes += text.length; logs.push(text);
    }
    return { kind: info.kind, toolUseId: info.toolUseId, taskId: info.taskId, runId: info.runId,
      title: snapshot?.title || snapshot?.workflowName || resultMeta.workflowName || info.block.input?.description || info.block.input?.name || '',
      status: state, agents: info.agents,
      notice: info.notice || '',
      workflow: snapshot ? { phases: snapshot.phases || [], progress: snapshot.workflowProgress || [], agentCount: finite(snapshot.agentCount),
        tokens: finite(snapshot.totalTokens), toolCalls: finite(snapshot.totalToolCalls), durationMs: finite(snapshot.durationMs),
        error: snapshot.error || null, result: resultText.length > PREVIEW_CHARS ? resultText.slice(0, PREVIEW_CHARS) : snapshot.result,
        resultTruncated: resultText.length > PREVIEW_CHARS, logs, logsTruncated, snapshotPath: info.snapshotPath } : null,
      transcriptPath: info.source };
  }

  async function projectRecord(file, row, index, full = false) {
    const entry = await journal.read(file, row);
    if (!entry || (entry.uuid && entry.uuid !== row.key)) throw historyError('history-changed', 'The agent transcript changed. Refresh this page.');
    const projected = [];
    for (let i = 0; i < blocks(entry).length; i++) {
      const block = blocks(entry)[i];
      if (!block || block.type === 'tool_result') continue;
      if (block.type !== 'tool_use') {
        const value = previewBlock(block, full);
        if (value) projected.push({ ...value, key: row.key + ':' + i });
        continue;
      }
      const resultEntry = await journal.read(file, index.results.get(block.id));
      const result = blocks(resultEntry).find(value => value?.type === 'tool_result' && value.tool_use_id === block.id);
      const inputText = JSON.stringify(block.input || {}, null, 2);
      const inputTruncated = inputText.length > PREVIEW_CHARS && !full;
      const input = inputTruncated ? Object.fromEntries(['file_path', 'description', 'query', 'pattern', 'url', 'subagent_type', 'name'].filter(key => typeof block.input?.[key] === 'string').map(key => [key, block.input[key]])) : block.input;
      const output = result ? (Array.isArray(result.content) ? result.content : [{ type: 'text', text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }]).map(value => previewBlock(value, full)).filter(Boolean) : [];
      projected.push({ type: 'tool_use', key: row.key + ':' + i, id: block.id, name: block.name,
        input, inputPreview: inputTruncated ? inputText.slice(0, PREVIEW_CHARS) : null, truncated: inputTruncated,
        result: result ? { failed: result.is_error === true, content: output, version: String(index.results.get(block.id)?.start) } : null });
    }
    return { id: row.key, version: `${row.start}:${row.length}`, role: entry.type, timestamp: entry.timestamp || '', cwd: entry.cwd || index.cwd,
      line: row.line, compact: entry.isCompactSummary === true, blocks: projected };
  }

  async function execute(message) {
    const identity = { sessionId: message.sessionId, toolUseId: message.toolUseId, agentId: message.agentId || null };
    try {
      const { info } = await resolve(message);
      if (!message.agentId) return { ok: true, state: 'ready', ...identity, activity: overview(info) };
      const { file, index } = await agentFile(info, message.agentId);
      if (message.op === 'tool-diff') {
        if (!identifier(message.innerToolUseId) || typeof message.filePath !== 'string') throw historyError('invalid-identity', 'The nested tool identity is invalid.');
        const source = createToolDiffSource({ resolveTargetFromIdentity: () => file });
        try {
          const diff = await source.request({ sessionId: message.sessionId, cwd: index.cwd || message.cwd, toolUseId: message.innerToolUseId, filePath: message.filePath });
          return { ok: true, state: 'ready', ...identity, diff };
        } finally { source.dispose(); }
      }
      if (message.op === 'record') {
        const row = index.latest.get(message.recordId);
        if (!row) throw historyError('not-found', 'This record is no longer present in the current transcript.');
        const record = await projectRecord(file, row, index, true);
        if (JSON.stringify(record).length > MAX_JSON_BYTES) throw historyError('record-too-large', 'This record is too large for the inline viewer. Open the original transcript to read it.');
        return { ok: true, state: 'ready', ...identity, record, transcriptPath: file };
      }
      const count = index.records.length;
      const page = message.page === 'last' ? Math.max(0, Math.ceil(count / PAGE_SIZE) - 1) : message.page ?? 0;
      if (!Number.isSafeInteger(page) || page < 0) throw historyError('invalid-page', 'The requested history page is invalid.');
      const safePage = Math.min(page, Math.max(0, Math.ceil(count / PAGE_SIZE) - 1));
      const records = []; let bytes = 0;
      for (const row of index.records.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)) {
        const record = await projectRecord(file, row, index);
        const size = JSON.stringify(record).length;
        if (size + bytes > MAX_PAGE_BYTES) {
          record.blocks = [{ type: 'text', text: 'This record is available through Show full record.', truncated: true, key: record.id + ':large' }];
        }
        records.push(record); bytes += JSON.stringify(record).length;
      }
      return { ok: true, state: count ? 'ready' : 'empty', ...identity, records, page: safePage, pages: Math.max(1, Math.ceil(count / PAGE_SIZE)),
        total: count, partial: index.partial, revision: index.revision, transcriptPath: file };
    } catch (error) {
      const code = error.code === 'EACCES' || error.code === 'EPERM' ? 'permission-denied' : error.code === 'ENOENT' ? 'not-found' : error.code || 'source-failure';
      return { ok: false, state: code === 'not-found' ? 'unavailable' : code === 'permission-denied' ? 'permission' : 'error',
        code, error: code === 'not-found' ? 'The host has not recorded this activity yet. Refresh after it starts or finishes.' : error.message || String(error), transcriptPath: error.transcriptPath || null, ...identity };
    }
  }

  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      if (job.signal?.aborted || job.epoch !== epoch) { job.reject(Object.assign(new Error('Activity reading was cancelled.'), { name: 'AbortError' })); continue; }
      active++;
      execute(job.message).then(value => {
        if (job.signal?.aborted || job.epoch !== epoch) job.reject(Object.assign(new Error('Activity reading was cancelled.'), { name: 'AbortError' }));
        else job.resolve(value);
      }, job.reject).finally(() => { active--; pump(); });
    }
  }

  function request(message, { signal } = {}) {
    if (queue.length >= 32) return Promise.reject(historyError('busy', 'Too many agent histories are loading. Retry shortly.'));
    return new Promise((resolve, reject) => { queue.push({ message, signal, resolve, reject, epoch }); pump(); });
  }

  return { request, dispose() { epoch++; journal.clear(); metadata.clear(); pump(); }, get cachedFiles() { return journal.size; } };
}

module.exports = { createAgentActivitySource };
