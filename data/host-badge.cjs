'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { StringDecoder } = require('string_decoder');

const GLOBAL_KEY = '__cceBadge';
let vscodeApi = null;
// `POLL_INTERVAL_MS` matches the 0.1.10 cadence. We layer event-driven
// `schedulePoll(WRITE_POLL_DEBOUNCE_MS)` on top via wrappers around
// `fs.appendFile`/`writeFile` callbacks and `createWriteStream`'s
// `finish`/`close`/`end` events, so most writes get a faster refresh
// than the interval — but the interval itself stays at 1.5s because the
// JSONL stream Claude Code opens generally never `finish`/`close` for
// the life of a session, leaving us with only the interval as a backstop.
const POLL_INTERVAL_MS = 1500;
const WRITE_POLL_DEBOUNCE_MS = 120;
const JSONL_SUFFIX = '.jsonl';
const USAGE_CACHE_SCHEMA_VERSION = 2;
const USAGE_CACHE_INDEX_DIR = path.join(os.homedir(), '.incipit', 'claude-usage-cache-v2');
const USAGE_CACHE_HASH_BYTES = 4096;
const EDIT_ACTIVITY_SCHEMA_VERSION = 1;
const EDIT_ACTIVITY_INDEX_DIR = path.join(os.homedir(), '.incipit', 'claude-edit-activity-v1');
const CHANGE_REVIEW_SCHEMA_VERSION = 1;
const CHANGE_REVIEW_INDEX_DIR = path.join(os.homedir(), '.incipit', 'change-review-v1');
const NOTES_SCHEMA_VERSION = 1;
const NOTES_INDEX_DIR = path.join(os.homedir(), '.incipit', 'notes-v1');
const NOTES_MAX_COUNT = 200;
const NOTES_MAX_TEXT_BYTES = 8000;
const CHANGE_REVIEW_DIFF_MAX_BYTES = 768 * 1024;
const CHANGE_REVIEW_DIFF_CONTEXT_LINES = 3;
const CHANGE_REVIEW_DIFF_MAX_RENDER_ROWS = 360;
const CHANGE_REVIEW_DIFF_EXACT_CELL_LIMIT = 600 * 1000;
const CHANGE_REVIEW_LINE_STATS_VERSION = 2;
// Change review is a per-turn runtime surface: after the first successful
// Write/Edit/MultiEdit it stays visible until that assistant turn finalizes.
const CHANGE_REVIEW_RUNTIME_ENABLED = true;
const LINE_DIFF_EXACT_CELL_LIMIT = 12 * 1000 * 1000;
const PROJECT_INDEX_BATCH_FILES = 2;
const PROJECT_INDEX_BATCH_BYTES = 8 * 1024 * 1024;
const PROJECT_INDEX_BATCH_DELAY_MS = 45;
const PROJECT_INDEX_SCAN_MIN_INTERVAL_MS = 12000;
const GLOBAL_INDEX_SCAN_MIN_INTERVAL_MS = 60000;
const FILE_REVEAL_CWD_SCAN_BYTES = 512 * 1024;
// Keep rollback tokens long enough to cover Claude Code's 5-minute
// launch/byte watchdog path, but cap entries because each one keeps
// the original transcript text in memory until send succeeds or fails.
const TRUNCATE_ROLLBACK_TTL_MS = 6 * 60 * 1000;
const TRUNCATE_ROLLBACK_MAX = 3;
// Cache-hit history is transported as a BOUNDED array of aggregate
// buckets, never one entry per request. `parser.order.map(...)` is
// O(requests) bytes re-serialized over postMessage every turn the cache
// popup is open; on a long-lived npm-published session that grows
// without limit (50k requests ≈ 6MB per refresh). Buckets keep the wire
// + retained cost constant regardless of session length. Each bucket
// carries EXACT partial sums of the real requests it spans, so summing
// any contiguous run of buckets reproduces the exact totals/mean/min the
// full array would have — only the brush *selection granularity*
// coarsens (a bucket can't be split); the numbers never become
// estimates. When requests <= HISTORY_MAX_BUCKETS every bucket is
// exactly one request, i.e. byte-for-byte the old per-request behaviour.
const HISTORY_MAX_BUCKETS = 1500;

function attachComm(comm) {
  const state = getOrCreateState();
  state.comms.add(comm);
  wrapShutdown(comm, state);
  attachMessageHandler(comm, state);
  startPolling(state);
}

function getOrCreateState() {
  const globalRef = globalThis;
  if (globalRef[GLOBAL_KEY]) return globalRef[GLOBAL_KEY];
  const state = createState();
  globalRef[GLOBAL_KEY] = state;
  return state;
}

function createState() {
  return {
    comms: new Set(),
    started: false,
    patchedFs: false,
    ourFile: null,
    commIdentities: new Map(),
    targetCache: new Map(),
    parsers: new Map(),
    timer: null,
    pollTimer: null,
    tick: null,
    editProjectIndexes: new Map(),
    editProjectJobs: new Map(),
    editProjectScanAt: new Map(),
    editGlobalJob: null,
    editGlobalScanAt: 0,
    changeReviewStates: new Map(),
    truncateRollbacks: new Map(),
    log(message) {
      try { console.log(`[cceBadge] ${message}`); } catch (_) {}
    },
  };
}

function wrapShutdown(comm, state) {
  if (!comm || comm.__cceBadgeWrapped) return;
  if (typeof comm.shutdown !== 'function') {
    throw new Error('[cceBadge] attachComm expected a comm with shutdown()');
  }
  const original = comm.shutdown;
  comm.__cceBadgeWrapped = true;
  comm.shutdown = async function wrappedShutdown() {
    state.comms.delete(comm);
    state.commIdentities.delete(comm);
    if (comm.__incipitMessageDisposable && typeof comm.__incipitMessageDisposable.dispose === 'function') {
      try { comm.__incipitMessageDisposable.dispose(); } catch (_) {}
      comm.__incipitMessageDisposable = null;
    }
    if (state.comms.size === 0) stopPolling(state);
    return original.apply(this, arguments);
  };
}

function attachMessageHandler(comm, state) {
  if (!comm || comm.__incipitMessageHandlerAttached) return;
  const webview = comm.webview;
  if (!webview || typeof webview.onDidReceiveMessage !== 'function') return;
  comm.__incipitMessageHandlerAttached = true;
  comm.__incipitMessageDisposable = webview.onDidReceiveMessage(message => {
    handleWebviewMessage(comm, state, message);
  });
}

function handleWebviewMessage(comm, state, message) {
  if (!message || message.__incipit !== true) return;
  if (isChangeReviewRuntimeMessage(message.type) && !CHANGE_REVIEW_RUNTIME_ENABLED) return;
  if (message.type === 'badge_identity_update') {
    handleBadgeIdentityUpdate(comm, state, message);
    return;
  }
  if (message.type === 'edit_activity_identity_update') {
    handleEditActivityIdentityUpdate(comm, state, message);
    return;
  }
  if (message.type === 'change_review_identity_update') {
    handleChangeReviewIdentityUpdate(comm, state, message);
    return;
  }
  if (message.type === 'diff_line_info_request') {
    handleDiffLineInfoRequest(comm, state, message);
    return;
  }
  if (message.type === 'change_review_diff_request') {
    handleChangeReviewDiffRequest(comm, state, message);
    return;
  }
  if (message.type === 'change_review_turn_finalized') {
    handleChangeReviewTurnFinalized(comm, state, message);
    return;
  }
  if (message.type === 'change_review_turn_started') {
    handleChangeReviewTurnStarted(comm, state, message);
    return;
  }
  if (message.type === 'change_review_reject_request') {
    handleChangeReviewRejectRequest(comm, state, message);
    return;
  }
  if (message.type === 'conversation_mutation_request') {
    handleConversationMutationRequest(comm, state, message);
    return;
  }
  if (message.type === 'file_reveal_request') {
    handleFileRevealRequest(comm, state, message);
    return;
  }
  if (message.type === 'file_path_copy_request') {
    handleFilePathCopyRequest(comm, state, message);
    return;
  }
  if (message.type === 'notes_load_request') {
    handleNotesLoadRequest(comm, state, message);
    return;
  }
  if (message.type === 'notes_save_request') {
    handleNotesSaveRequest(comm, state, message);
  }
  // Note insertion is no longer a host round-trip: the webview inserts snippets
  // directly via a native composer text edit (execCommand insertText), since the
  // host @mention command mangled multi-line prose. host-badge only owns notes
  // storage (load/save) now.
}

function isChangeReviewRuntimeMessage(type) {
  return type === 'change_review_identity_update' ||
    type === 'change_review_diff_request' ||
    type === 'change_review_turn_finalized' ||
    type === 'change_review_turn_started' ||
    type === 'change_review_reject_request';
}

function handleBadgeIdentityUpdate(comm, state, message) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  const includeHistory = message.includeHistory === true;
  if (!sessionId) {
    state.commIdentities.delete(comm);
    sendPayload(comm, emptyBadgePayload(null, null));
    return;
  }
  const previous = state.commIdentities.get(comm);
  const incomingCwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : null;
  const cwd = incomingCwd || (previous && previous.sessionId === sessionId ? previous.cwd : null);
  if (previous && previous.sessionId === sessionId && previous.cwd === cwd && previous.target) {
    sendCurrentBadgePayload(state, comm, previous.target, sessionId, includeHistory);
    return;
  }
  const target = resolveTargetFromIdentity(sessionId, cwd);
  const identity = { sessionId, cwd, target };
  state.commIdentities.set(comm, identity);
  if (!target) {
    sendPayload(comm, emptyBadgePayload(sessionId, null));
    return;
  }
  sendCurrentBadgePayload(state, comm, target, sessionId, includeHistory);
}

function handleEditActivityIdentityUpdate(comm, state, message) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  const includeProject = message.includeProject === true;
  if (!sessionId) {
    state.commIdentities.delete(comm);
    if (includeProject) {
      sendEditActivityPayload(
        comm,
        editActivityEnvelope(
          emptyEditActivityPayload(null, null),
          buildProjectEditActivityResponse(state, null, comm, null)
        )
      );
      return;
    }
    sendEditActivityPayload(comm, emptyEditActivityPayload(null, null));
    return;
  }
  const previous = state.commIdentities.get(comm);
  const incomingCwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : null;
  const cwd = incomingCwd || (previous && previous.sessionId === sessionId ? previous.cwd : null);
  if (previous && previous.sessionId === sessionId && previous.cwd === cwd && previous.target) {
    sendCurrentEditActivityPayload(state, comm, previous.target, sessionId, includeProject);
    return;
  }
  const target = resolveTargetFromIdentity(sessionId, cwd);
  const identity = { sessionId, cwd, target };
  state.commIdentities.set(comm, identity);
  if (!target) {
    if (includeProject) {
      sendEditActivityPayload(
        comm,
        editActivityEnvelope(
          emptyEditActivityPayload(sessionId, null),
          buildProjectEditActivityResponse(state, null, comm, sessionId)
        )
      );
      return;
    }
    sendEditActivityPayload(comm, emptyEditActivityPayload(sessionId, null));
    return;
  }
  sendCurrentEditActivityPayload(state, comm, target, sessionId, includeProject);
}

function handleChangeReviewIdentityUpdate(comm, state, message) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  if (!sessionId) {
    state.commIdentities.delete(comm);
    sendChangeReviewPayload(comm, emptyChangeReviewPayload(null, null));
    return;
  }
  const previous = state.commIdentities.get(comm);
  const incomingCwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : null;
  const cwd = incomingCwd || (previous && previous.sessionId === sessionId ? previous.cwd : null);
  if (previous && previous.sessionId === sessionId && previous.cwd === cwd && previous.target) {
    sendCurrentChangeReviewPayload(state, comm, previous.target, sessionId);
    return;
  }
  const target = resolveTargetFromIdentity(sessionId, cwd);
  const identity = { sessionId, cwd, target };
  state.commIdentities.set(comm, identity);
  if (!target) {
    sendChangeReviewPayload(comm, emptyChangeReviewPayload(sessionId, null));
    return;
  }
  sendCurrentChangeReviewPayload(state, comm, target, sessionId);
}

function handleDiffLineInfoRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'diff_line_info_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    reply(resolveDiffLineInfo(message));
  } catch (error) {
    state.log(`diff line info error: ${error && error.message ? error.message : error}`);
    reply({ error: String(error && error.message ? error.message : error) });
  }
}

function handleConversationMutationRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'conversation_mutation_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    reply(resolveConversationMutation(state, message));
  } catch (error) {
    state.log(`conversation mutation error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

async function handleFileRevealRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'file_reveal_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    reply(await revealContainingFolder(state, comm, message));
  } catch (error) {
    state.log(`file reveal error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function handleFilePathCopyRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'file_path_copy_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    let vscode = null;
    try { vscode = getVSCodeApi(); } catch (_) {}
    reply({ ok: true, ...resolveFileCopyPaths(state, comm, message, vscode) });
  } catch (error) {
    state.log(`file path copy error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function handleChangeReviewDiffRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'change_review_diff_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    reply(resolveChangeReviewDiff(state, comm, message || {}));
  } catch (error) {
    state.log(`change review diff error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function handleChangeReviewTurnFinalized(comm, state, message) {
  try {
    const payload = resolveChangeReviewTurnFinalized(state, comm, message || {});
    if (payload && payload.src) {
      sendChangeReviewTarget(state, payload.src, payload.sessionId);
    }
  } catch (error) {
    state.log(`change review finalize error: ${error && error.message ? error.message : error}`);
  }
}

function handleChangeReviewTurnStarted(comm, state, message) {
  try {
    const payload = resolveChangeReviewTurnStarted(state, comm, message || {});
    if (payload && payload.src) {
      sendChangeReviewTarget(state, payload.src, payload.sessionId);
    }
  } catch (error) {
    state.log(`change review start error: ${error && error.message ? error.message : error}`);
  }
}

function handleChangeReviewRejectRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'change_review_reject_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    const payload = resolveChangeReviewReject(state, comm, message || {});
    reply(payload);
    const identity = revealIdentityForMessage(state, comm, message || {});
    const target = identity && identity.target
      ? identity.target
      : resolveTargetFromIdentity(message.sessionId, identity && identity.cwd);
    if (target) {
      const sessionId = typeof message.sessionId === 'string' && message.sessionId
        ? message.sessionId
        : (identity && identity.sessionId);
      sendChangeReviewTarget(state, target, sessionId);
    }
  } catch (error) {
    state.log(`change review reject error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function getVSCodeApi() {
  if (vscodeApi) return vscodeApi;
  // Loaded lazily so unit tests can parse this helper outside VS Code.
  vscodeApi = require('vscode');
  return vscodeApi;
}

function decodePathSegment(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

function expandHomePath(value) {
  const raw = typeof value === 'string' ? value : '';
  if (raw === '~') return os.homedir();
  if (/^~[\\/]/.test(raw)) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function normalizeFileRevealPath(value) {
  let raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('No file path supplied.');
  if (/^file:/i.test(raw)) {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    raw = fileURLToPath(url);
  } else {
    const hashIndex = raw.search(/#L?\d+(?:-L?\d+)?$/i);
    if (hashIndex !== -1) raw = raw.slice(0, hashIndex);
    const queryIndex = raw.indexOf('?');
    if (queryIndex !== -1) raw = raw.slice(0, queryIndex);
    raw = decodePathSegment(raw).trim();
  }
  raw = expandHomePath(raw).trim();
  if (!raw) throw new Error('No file path supplied.');
  return raw;
}

function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveFileRevealPathForCwd(raw, cwd, workspaceRoots) {
  const rawIsAbsolute = path.isAbsolute(raw);
  const baseCwd = rawIsAbsolute ? '' : preferredWorkspaceRoot(workspaceRoots || [], cwd);
  if (!rawIsAbsolute && !baseCwd) {
    throw new Error('Relative file path has no Claude project cwd.');
  }
  return {
    rawIsAbsolute,
    resolved: rawIsAbsolute ? path.resolve(raw) : path.resolve(baseCwd, raw),
    baseCwd,
  };
}

function resolveFileCopyPathsForCwd(rawInput, cwd, workspaceRoots) {
  const raw = normalizeFileRevealPath(rawInput);
  const roots = normalizeWorkspaceRoots(workspaceRoots || []);
  const cwdRoot = normalizeWorkspaceCwd(cwd);
  const rawIsAbsolute = path.isAbsolute(raw);
  const baseRoot = rawIsAbsolute ? '' : preferredWorkspaceRoot(roots, cwdRoot);
  if (!rawIsAbsolute && !baseRoot) {
    throw new Error('Relative file path has no VS Code workspace folder or Claude project cwd.');
  }

  const absolutePath = rawIsAbsolute ? path.resolve(raw) : path.resolve(baseRoot, raw);
  const relativeRoot = containingWorkspaceRoot(roots, absolutePath) ||
    (!rawIsAbsolute ? baseRoot : preferredWorkspaceRoot(roots, cwdRoot));
  const relativePath = relativePathFromWorkspaceRoot(relativeRoot, absolutePath);

  return {
    raw,
    rawIsAbsolute,
    absolutePath,
    relativePath,
    workspaceRoot: relativeRoot || '',
    cwd: cwdRoot || '',
  };
}

function assertFileRevealWorkspace(cwd, resolved, rawIsAbsolute) {
  if (!cwd) return;
  const realRoot = fs.realpathSync(cwd);
  const realTarget = fs.realpathSync(resolved);
  if (isPathInside(realTarget, realRoot)) return;
  // Absolute paths in assistant output are already explicit user-facing
  // file targets. The cwd hint can be stale when viewing/switching sessions,
  // so it must not veto an existing absolute path from another workspace.
  if (rawIsAbsolute) return;
  throw new Error('File path is outside the active workspace.');
}

function normalizeWorkspaceCwd(value) {
  const cwd = typeof value === 'string' && value ? value : '';
  if (!cwd || !path.isAbsolute(cwd)) return '';
  try {
    const stat = fs.statSync(cwd);
    return stat.isDirectory() ? cwd : '';
  } catch (_) {
    return '';
  }
}

function workspaceFolderPath(folder) {
  if (typeof folder === 'string') return folder;
  const uri = folder && folder.uri;
  return uri && typeof uri.fsPath === 'string' ? uri.fsPath : '';
}

function uniquePathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeWorkspaceRoots(values) {
  const roots = [];
  const seen = new Set();
  const input = Array.isArray(values) ? values : [];
  for (const value of input) {
    const root = normalizeWorkspaceCwd(workspaceFolderPath(value));
    if (!root) continue;
    const key = uniquePathKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

function vscodeWorkspaceRoots(vscode) {
  const folders = vscode && vscode.workspace && vscode.workspace.workspaceFolders;
  return normalizeWorkspaceRoots(Array.isArray(folders) ? folders : []);
}

function containingWorkspaceRoot(roots, filePath) {
  const resolved = path.resolve(filePath);
  let best = '';
  for (const root of normalizeWorkspaceRoots(roots)) {
    if (!isPathInside(resolved, path.resolve(root))) continue;
    if (!best || path.resolve(root).length > path.resolve(best).length) best = root;
  }
  return best;
}

function preferredWorkspaceRoot(roots, cwd) {
  const normalizedRoots = normalizeWorkspaceRoots(roots);
  const normalizedCwd = normalizeWorkspaceCwd(cwd);
  if (normalizedCwd) {
    const containing = containingWorkspaceRoot(normalizedRoots, normalizedCwd);
    if (containing) return containing;
  }
  if (normalizedRoots.length) return normalizedRoots[0];
  return normalizedCwd;
}

function samePathRoot(a, b) {
  if (!a || !b) return false;
  const ar = path.parse(path.resolve(a)).root;
  const br = path.parse(path.resolve(b)).root;
  if (!ar || !br) return false;
  return process.platform === 'win32' ? ar.toLowerCase() === br.toLowerCase() : ar === br;
}

function relativePathFromWorkspaceRoot(root, filePath) {
  const normalizedRoot = normalizeWorkspaceCwd(root);
  if (!normalizedRoot || !filePath || !path.isAbsolute(filePath)) return '';
  if (!samePathRoot(normalizedRoot, filePath)) return '';
  const rel = path.relative(normalizedRoot, path.resolve(filePath)) || '.';
  return path.isAbsolute(rel) ? '' : rel;
}

function normalizeRevealSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value) ? value : '';
}

function revealIdentityForMessage(state, comm, message) {
  let identity = state && state.commIdentities ? state.commIdentities.get(comm) : null;
  const sessionId = normalizeRevealSessionId(message && message.sessionId);
  if (!identity && sessionId) {
    identity = {
      sessionId,
      cwd: typeof message.cwd === 'string' && message.cwd ? message.cwd : null,
      target: null,
    };
    if (state && state.commIdentities && state.comms && state.comms.has(comm)) {
      state.commIdentities.set(comm, identity);
    }
  }
  return identity || null;
}

function readTranscriptCwd(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return ''; }
  if (!stat.isFile() || stat.size <= 0) return '';

  const head = readFileTextSlice(filePath, 0, Math.min(FILE_REVEAL_CWD_SCAN_BYTES, stat.size));
  const headCwd = findCwdInJsonLines(head);
  if (headCwd || stat.size <= FILE_REVEAL_CWD_SCAN_BYTES) return headCwd;

  const tailStart = Math.max(0, stat.size - FILE_REVEAL_CWD_SCAN_BYTES);
  const tail = readFileTextSlice(filePath, tailStart, stat.size - tailStart);
  return findCwdInJsonLines(tail);
}

function readFileTextSlice(filePath, start, length) {
  if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return '';
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function findCwdInJsonLines(text) {
  if (!text || text.indexOf('"cwd"') === -1) return '';
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const entry = parseJsonLine(line);
    const cwd = normalizeWorkspaceCwd(entry && entry.cwd);
    if (cwd) return cwd;
  }
  return '';
}

function resolveFileRevealCwd(state, comm, message) {
  const messageCwd = normalizeWorkspaceCwd(message && message.cwd);
  if (messageCwd) return messageCwd;

  const identity = revealIdentityForMessage(state, comm, message || {});
  const identityCwd = normalizeWorkspaceCwd(identity && identity.cwd);
  if (identityCwd) return identityCwd;

  if (!identity || !identity.sessionId) return '';
  let target = identity.target;
  if (!target || !fs.existsSync(target)) {
    target = resolveTargetFromIdentity(identity.sessionId, identity.cwd || null);
    identity.target = target;
  }
  if (!target) return '';

  const parser = state && state.parsers ? state.parsers.get(target) : null;
  const parserCwd = normalizeWorkspaceCwd(parser && parser.projectCwd);
  if (parserCwd) return parserCwd;

  const transcriptCwd = readTranscriptCwd(target);
  if (transcriptCwd) {
    if (parser) parser.projectCwd = transcriptCwd;
    identity.cwd = transcriptCwd;
  }
  return transcriptCwd;
}

async function revealContainingFolder(state, comm, message) {
  const vscode = getVSCodeApi();
  const cwd = resolveFileRevealCwd(state, comm, message || {});
  const raw = normalizeFileRevealPath(message && message.filePath);
  const workspaceRoots = vscodeWorkspaceRoots(vscode);
  const { rawIsAbsolute, resolved, baseCwd } = resolveFileRevealPathForCwd(raw, cwd, workspaceRoots);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    throw new Error('File path does not exist.');
  }

  assertFileRevealWorkspace(baseCwd || cwd, resolved, rawIsAbsolute);

  const directoryPath = stat.isDirectory() ? resolved : path.dirname(resolved);
  if (!stat.isDirectory()) {
    try {
      // VS Code's built-in OS reveal command asks the platform file manager
      // to open the containing folder with this file selected. Keep it in the
      // extension host: webviews cannot reliably issue command: URIs here.
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolved));
      return { ok: true, filePath: resolved, directoryPath, selected: true };
    } catch (error) {
      stateLogFileRevealFallback(error);
    }
  }

  // Fallback / directory path: open the directory URI with the operating
  // system's external handler. This preserves the old behavior when the target
  // itself is a directory, and when the OS reveal command is unavailable.
  const ok = await vscode.env.openExternal(vscode.Uri.file(directoryPath));
  if (ok === false) throw new Error('VS Code could not open the containing folder.');
  return { ok: true, filePath: stat.isDirectory() ? null : resolved, directoryPath, selected: false };
}

function resolveFileCopyPaths(state, comm, message, vscode) {
  const cwd = resolveFileRevealCwd(state, comm, message || {});
  return resolveFileCopyPathsForCwd(
    message && message.filePath,
    cwd,
    vscodeWorkspaceRoots(vscode),
  );
}

function stateLogFileRevealFallback(error) {
  try {
    console.warn('[cceBadge] revealFileInOS failed; falling back to openExternal:', error && error.message ? error.message : error);
  } catch (_) {}
}

function resolveDiffLineInfo(message) {
  const filePath = typeof message.filePath === 'string' ? message.filePath : '';
  if (!filePath || !path.isAbsolute(filePath)) {
    return { startLine: null, oldStartLine: null, newStartLine: null };
  }
  if (!fs.existsSync(filePath)) {
    return { startLine: null, oldStartLine: null, newStartLine: null, missing: true };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const oldText = typeof message.oldText === 'string' ? message.oldText : '';
  const newText = typeof message.newText === 'string' ? message.newText : '';
  const newStartLine = findSnippetStartLine(text, newText) || findSnippetStartLine(text, oldText);
  const oldStartLine = findSnippetStartLine(text, oldText) || newStartLine;
  return {
    startLine: newStartLine || oldStartLine || null,
    oldStartLine: oldStartLine || null,
    newStartLine: newStartLine || oldStartLine || null,
  };
}

function normalizeTextForSearch(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function findSnippetStartLine(fileText, snippet) {
  const haystack = normalizeTextForSearch(fileText);
  const needle = normalizeTextForSearch(snippet);
  if (!needle) return null;
  let index = haystack.indexOf(needle);
  if (index < 0) {
    const trimmed = needle.trim();
    if (trimmed && trimmed !== needle) index = haystack.indexOf(trimmed);
  }
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (haystack.charCodeAt(i) === 10) line++;
  }
  return line;
}

function resolveConversationMutation(state, message) {
  // The webview pulls `sessionId` straight off the connection's
  // `activeSessionId` signal (decompiled `Jn.activeSessionId.value`).
  // That's the canonical identity for the current panel — pinpointing
  // the exact JSONL file even with multi-window / multi-panel /
  // sidebar-vs-editor topologies. We never want to silently fall back
  // to "newest mtime" when an explicit sessionId was provided but
  // doesn't resolve, because that is exactly how we'd write into the
  // wrong session.
  // Fail closed when no sessionId is supplied. The webview is the only
  // caller and 0.1.5+ always passes one (`transcriptRecordIdentity()`
  // reads `Jn.activeSessionId.value`). If the fiber pierce fails, the
  // webview fails up-front and never reaches the host, so the only way
  // we'd land here is a stale shape on a future Claude Code release —
  // and the legacy newest-mtime fallback is exactly the heuristic that
  // could silently mutate a different transcript file in multi-window /
  // multi-panel / sidebar-vs-editor setups (memo red line: "不要退回
  // newest-mtime"). Refuse instead; the user gets a toast and reloads.
  if (typeof message.sessionId !== 'string' || !message.sessionId) {
    throw new Error(
      'Missing sessionId on transcript mutation request. ' +
      'Reload the window and try again.'
    );
  }
  const target = resolveTargetFromIdentity(message.sessionId, message.cwd);
  if (!target || !fs.existsSync(target)) {
    throw new Error(
      `Could not locate transcript JSONL for session ${message.sessionId}. ` +
      `Reload the window and try again.`
    );
  }

  const op = typeof message.op === 'string' ? message.op : '';
  if (!op) throw new Error('Missing transcript mutation operation');

  if (op === 'resolve_assistant_uuid') {
    const transcript = readTranscript(target);
    return resolveAssistantUuid(transcript, message);
  }

  const uuid = typeof message.uuid === 'string' ? message.uuid : '';
  if (!uuid) throw new Error('Missing message uuid');

  if (op === 'rollback_truncate_from_user') {
    return rollbackTruncateFromUser(state, target, uuid, message);
  }

  if (op === 'peek_truncate_state') {
    return peekTruncateState(state, target, uuid, message);
  }

  if (op === 'get_message') {
    const transcript = readTranscript(target);
    const rows = transcript.rowsByUuid.get(uuid);
    if (!rows || !rows.length) throw new Error(`Message ${uuid} was not found`);
    const row = rows[rows.length - 1];
    return {
      ok: true,
      op,
      uuid,
      filePath: target,
      type: row.entry.type || null,
      text: editableTextFromEntry(row.entry),
      canEditUser: canEditUserEntry(row.entry),
      canEditAssistantText: canEditAssistantTextEntry(row.entry),
      canRerun: row.entry.type === 'user' && canEditUserEntry(row.entry),
    };
  }

  const before = fs.statSync(target);
  const transcript = readTranscript(target);
  let result;
  if (op === 'edit_user') {
    // Rich path: caller sent an explicit `blocks` spec listing kept
    // (by index) refs/images plus new text/image blocks. Lets the
    // user remove individual ide_* attachments and images instead of
    // forcing the legacy first-text-block overwrite.
    if (Array.isArray(message.blocks)) {
      result = applyUserBlockEdit(transcript, uuid, message.blocks);
    } else {
      result = applyUserEdit(transcript, uuid, textPayload(message));
    }
  } else if (op === 'edit_assistant_text') {
    result = applyAssistantTextEdit(transcript, uuid, textPayload(message));
  } else if (op === 'truncate_from_user') {
    result = applyTruncateFromUser(transcript, uuid);
  } else {
    throw new Error(`Unsupported transcript mutation operation: ${op}`);
  }

  if (!result || !result.changed) {
    return { ok: true, op, uuid, changed: false, filePath: target };
  }

  const current = fs.statSync(target);
  if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
    throw new Error('Transcript changed while editing; please try again after the current response finishes');
  }

  // Note: we deliberately do NOT write persistent transcript backups.
  // Earlier versions wrote a full JSONL copy under
  // `~/.incipit-backup/jsonl-history/` per mutation, which accumulated
  // hundreds of MB on real users without ever being read back (no UI
  // surfaced an "undo edit" affordance against the copy). The host's
  // own JSONL append-log + git history of the project itself remain
  // the recovery mechanisms. Rerun truncation is the one exception in
  // shape: it gets a short-lived in-memory rollback token below, only
  // to cover `session.send()` failing before a replacement append.
  const nextText = serializeTranscript(transcript);
  atomicWriteTranscript(target, nextText);
  let rollbackToken = null;
  let rollbackExpiresAt = null;
  if (op === 'truncate_from_user') {
    const rollback = registerTruncateRollback(state, {
      target,
      sessionId: message.sessionId,
      uuid,
      beforeText: transcript.rawText || '',
      afterText: nextText,
    });
    rollbackToken = rollback.token;
    rollbackExpiresAt = rollback.expiresAt;
  }
  resetTranscriptParserState(state, target);
  try { poll(state); } catch (_) {}

  return {
    ok: true,
    op,
    uuid,
    changed: true,
    droppedUuids: result.droppedUuids || [],
    droppedFromIndex: result.droppedFromIndex == null ? null : result.droppedFromIndex,
    rollbackToken,
    rollbackExpiresAt,
    filePath: target,
    reloadRecommended: true,
  };
}

function registerTruncateRollback(state, entry) {
  pruneTruncateRollbacks(state, Date.now());
  const token = createRollbackToken();
  const now = Date.now();
  const expiresAt = now + TRUNCATE_ROLLBACK_TTL_MS;
  state.truncateRollbacks.set(token, {
    target: entry.target,
    sessionId: entry.sessionId,
    uuid: entry.uuid,
    beforeText: entry.beforeText,
    afterLength: String(entry.afterText || '').length,
    afterHash: hashText(entry.afterText || ''),
    createdAt: now,
    expiresAt,
  });
  while (state.truncateRollbacks.size > TRUNCATE_ROLLBACK_MAX) {
    const first = state.truncateRollbacks.keys().next().value;
    if (!first) break;
    state.truncateRollbacks.delete(first);
  }
  return { token, expiresAt };
}

function pruneTruncateRollbacks(state, now) {
  if (!state.truncateRollbacks || typeof state.truncateRollbacks.entries !== 'function') {
    state.truncateRollbacks = new Map();
    return;
  }
  for (const [token, entry] of state.truncateRollbacks.entries()) {
    if (!entry || entry.expiresAt <= now) state.truncateRollbacks.delete(token);
  }
}

function createRollbackToken() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function matchesRollbackAfterText(text, entry) {
  return (
    String(text || '').length === entry.afterLength &&
    hashText(text) === entry.afterHash
  );
}

function rollbackTruncateFromUser(state, target, uuid, message) {
  pruneTruncateRollbacks(state, Date.now());
  const token = typeof message.rollbackToken === 'string' ? message.rollbackToken : '';
  if (!token) throw new Error('Missing rerun rollback token');
  const entry = state.truncateRollbacks && state.truncateRollbacks.get(token);
  if (!entry) {
    return {
      ok: true,
      op: 'rollback_truncate_from_user',
      uuid,
      changed: false,
      rolledBack: false,
      reason: 'expired_or_missing',
      filePath: target,
    };
  }
  if (entry.target !== target || entry.uuid !== uuid || entry.sessionId !== message.sessionId) {
    throw new Error('Rerun rollback token does not match this transcript');
  }
  const currentText = fs.readFileSync(target, 'utf8');
  if (!matchesRollbackAfterText(currentText, entry)) {
    state.truncateRollbacks.delete(token);
    return {
      ok: true,
      op: 'rollback_truncate_from_user',
      uuid,
      changed: false,
      rolledBack: false,
      reason: 'transcript_advanced',
      filePath: target,
    };
  }
  atomicWriteTranscript(target, entry.beforeText);
  state.truncateRollbacks.delete(token);
  resetTranscriptParserState(state, target);
  try { poll(state); } catch (_) {}
  return {
    ok: true,
    op: 'rollback_truncate_from_user',
    uuid,
    changed: true,
    rolledBack: true,
    filePath: target,
    reloadRecommended: true,
  };
}

// Read-only quiescence probe used by the rerun teardown serializer.
//
// After `truncate_from_user` writes the cut JSONL, incipit must NOT spawn
// the resume CLI until the *previous* (just-interrupted) CLI has fully
// stopped writing — otherwise two live streams append to the same file
// and the host's root stream-assembler throws
// `Mismatched content block type content_block_delta thinking`.
//
// The truncate registered a rollback entry holding the exact post-cut
// text length + sha256. Here we compare the current on-disk file to that
// fingerprint WITHOUT consuming the token or writing anything:
//   - `advanced:false`  → file is byte-identical to the cut text: no
//                          other writer (old CLI / task-notification
//                          background append) has touched it. Safe to
//                          resend once this has held stable for a window.
//   - `advanced:true`   → something appended after the cut (stale CLI
//                          still flushing, or a host-injected
//                          task-notification continuation). The caller
//                          must fail safe (roll back / abort) instead of
//                          starting a second concurrent stream.
// `hasToken:false` means the rollback token expired; the caller then
// falls back to busy + stat-stability only.
function peekTruncateState(state, target, uuid, message) {
  pruneTruncateRollbacks(state, Date.now());
  const token = typeof message.rollbackToken === 'string' ? message.rollbackToken : '';
  const entry = token && state.truncateRollbacks && state.truncateRollbacks.get(token);
  let sizeBytes = null;
  let mtimeMs = null;
  try {
    const st = fs.statSync(target);
    sizeBytes = st.size;
    mtimeMs = st.mtimeMs;
  } catch (_) {}
  if (!entry) {
    return {
      ok: true,
      op: 'peek_truncate_state',
      uuid,
      hasToken: false,
      advanced: null,
      sizeBytes,
      mtimeMs,
      filePath: target,
    };
  }
  if (entry.target !== target || entry.uuid !== uuid || entry.sessionId !== message.sessionId) {
    throw new Error('Peek rollback token does not match this transcript');
  }
  let advanced = true;
  try {
    advanced = !matchesRollbackAfterText(fs.readFileSync(target, 'utf8'), entry);
  } catch (_) {
    advanced = true;
  }
  return {
    ok: true,
    op: 'peek_truncate_state',
    uuid,
    hasToken: true,
    advanced,
    sizeBytes,
    mtimeMs,
    filePath: target,
  };
}

function textPayload(message) {
  if (typeof message.text !== 'string') throw new Error('Missing replacement text');
  return message.text;
}

function resolveAssistantUuid(transcript, message) {
  const betaMessageId = typeof message.betaMessageId === 'string' ? message.betaMessageId : '';
  if (!betaMessageId) throw new Error('Missing assistant message id');
  const requestedTail = normalizeLookupText(message.textTail || '');

  for (let i = transcript.rows.length - 1; i >= 0; i--) {
    const entry = transcript.rows[i].entry;
    if (!entry || entry.type !== 'assistant') continue;
    if (!entry.message || entry.message.id !== betaMessageId) continue;
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : '';
    if (!uuid) continue;
    const text = editableTextFromEntry(entry);
    const normalized = normalizeLookupText(text);
    const tailMatched = requestedTail.length < 24 ||
      normalized.includes(requestedTail) ||
      requestedTail.includes(normalized.slice(-Math.min(normalized.length, requestedTail.length)));
    return {
      ok: true,
      op: 'resolve_assistant_uuid',
      uuid,
      matched: true,
      tailMatched,
      canEditAssistantText: canEditAssistantTextEntry(entry),
    };
  }

  return {
    ok: true,
    op: 'resolve_assistant_uuid',
    uuid: null,
    matched: false,
  };
}

function normalizeLookupText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function readTranscript(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const hasFinalNewline = /\r?\n$/.test(raw);
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  if (hasFinalNewline && lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((line, index) => {
    const row = { raw: line, index, entry: null, changed: false, drop: false };
    if (line.trim()) {
      try { row.entry = JSON.parse(line); } catch (_) {}
    }
    return row;
  });
  // `rowsByUuid` is Map<string, Row[]> rather than a single-row map:
  // compacted JSONLs preserve segments and re-emit the same uuid in
  // both places (audited at 905 duplicate rows / 451 groups across 72
  // local sessions, with 251 of those groups containing tool_use or
  // tool_result blocks). A naive `.set(uuid, row)` overwrites earlier
  // copies and edit/truncate operations would only see the latest one,
  // letting stale duplicates survive. Edits walk every row sharing a
  // uuid; truncate cuts at the latest row's index but keeps earlier
  // duplicates as legitimate history.
  const transcript = {
    filePath,
    rawText: raw,
    rows,
    hasFinalNewline,
    rowsByUuid: new Map(),
    sessionId: path.basename(filePath, JSONL_SUFFIX),
  };
  for (const row of rows) {
    const entry = row.entry;
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.sessionId === 'string' && entry.sessionId) transcript.sessionId = entry.sessionId;
    if (typeof entry.uuid === 'string') {
      const list = transcript.rowsByUuid.get(entry.uuid);
      if (list) list.push(row);
      else transcript.rowsByUuid.set(entry.uuid, [row]);
    }
  }
  return transcript;
}

function serializeTranscript(transcript) {
  const lines = [];
  for (const row of transcript.rows) {
    if (row.drop) continue;
    if (row.entry && row.changed) lines.push(JSON.stringify(row.entry));
    else lines.push(row.raw);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// (Transcript JSONL backups removed; see comment above the
//  `atomicWriteTranscript` call. `sanitizeFilePart` was only used by
//  the backup helper and is removed alongside it.)

function atomicWriteTranscript(filePath, text) {
  const tmp = `${filePath}.incipit-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function resetTranscriptParserState(state, filePath) {
  if (!filePath) return;
  state.targetCache.delete(filePath);
  state.parsers.delete(filePath);
  deleteUsageCacheIndex(filePath);
}

// Apply a text replacement to *every* row sharing this uuid. Compact
// preservation can produce duplicate-uuid rows (verified at 905 dup
// rows / 451 groups across 72 local sessions); editing only the
// latest copy would let stale text hiding in earlier copies resurface
// after another compact. Sample-check the latest row's type for
// validation; if any row reports a change, the operation succeeded.
function applyUserEdit(transcript, uuid, text) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'user') throw new Error('Only user messages can be edited with this operation');
  if (!canEditUserEntry(sample)) {
    throw new Error('Tool result records cannot be edited; rerun the prior user message instead');
  }
  if (userEditHasDownstreamSignedThinking(transcript, uuid)) {
    throw new Error(SIGNED_THINKING_USER_EDIT_ERROR);
  }
  let any = false;
  for (const row of rows) {
    if (replaceTextContent(row.entry, text, { requireExistingText: false })) {
      row.changed = true;
      any = true;
    }
  }
  return { changed: any };
}

// Block-aware user edit. The webview chip strip lets the user drop
// individual ide_opened_file/ide_selection refs and images, and add
// new images via paste/drop/file-pick. On save the webview sends a
// `blocks` spec describing the new content array as a sequence of:
//   { kind:'keep', index } — preserve the original block at that index
//   { kind:'text', text }  — new text block (the user's prose)
//   { kind:'image', source:{type:'base64', media_type, data} } — new image
//
// Validation contract (every spec must clear these gates before any
// row is mutated; one bad spec fails the whole op so partial rebuilds
// can't sneak through):
//   - keep.index is a non-negative integer; per-row range check is
//     applied below (dup-uuid rows MAY have different lengths, though
//     compact-preserved dups normally don't)
//   - text.text is a string; must NOT begin with `<ide_*>` so the user
//     cannot synthesize a fake auto-attached ref via the prose box
//   - image.source.type === 'base64' with valid media_type + data
//
// Per-row application gate: only keep blocks of type 'text' or 'image'
// (never tool_result, even though canEditUserEntry already screens at
// the row level — defensive). After rebuild, content must be non-empty.
// We compare JSON-stringified old vs new to skip rows whose content
// happens to already match the spec (no-op write).

// Mirrors webview's MAX_INLINE_IMAGE_BYTES; raw decoded bytes, not
// base64 length. Anthropic's API will reject anything well above this,
// and persisting an unbounded blob into JSONL would bloat the
// transcript and break later resume/compact passes.
const HOST_MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function validateImageBase64(data) {
  // Raw size cap is computed from the base64 string length up front so
  // we can reject before paying the Buffer.from cost. Each 4-char base64
  // group encodes 3 raw bytes; padding subtracts one byte per `=`.
  const len = data.length;
  if (len === 0) {
    throw new Error('image source data is empty');
  }
  if (len % 4 !== 0) {
    throw new Error('image source data is not valid base64 (length not multiple of 4)');
  }
  if (!BASE64_RE.test(data)) {
    throw new Error('image source data contains non-base64 characters');
  }
  let pad = 0;
  if (data.charCodeAt(len - 1) === 61) pad++;
  if (data.charCodeAt(len - 2) === 61) pad++;
  const rawBytes = (len / 4) * 3 - pad;
  if (rawBytes > HOST_MAX_INLINE_IMAGE_BYTES) {
    throw new Error(
      `image source exceeds ${HOST_MAX_INLINE_IMAGE_BYTES} raw bytes ` +
      `(got ~${rawBytes})`
    );
  }
  // Final decode check. Buffer.from('base64') is lenient with garbage
  // inputs (silently drops invalid chars), so we compare the round-trip
  // length to confirm the input is actually decodable.
  const buf = Buffer.from(data, 'base64');
  if (buf.length !== rawBytes) {
    throw new Error('image source data failed base64 decode round-trip');
  }
}

function applyUserBlockEdit(transcript, uuid, blocks) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'user') {
    throw new Error('Only user messages can be edited with this operation');
  }
  if (!canEditUserEntry(sample)) {
    throw new Error('Tool result records cannot be edited; rerun the prior user message instead');
  }
  if (userEditHasDownstreamSignedThinking(transcript, uuid)) {
    throw new Error(SIGNED_THINKING_USER_EDIT_ERROR);
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('Empty blocks list');
  }
  for (const spec of blocks) {
    if (!spec || typeof spec !== 'object') {
      throw new Error('Invalid block spec');
    }
    if (spec.kind === 'keep') {
      if (!Number.isInteger(spec.index) || spec.index < 0) {
        throw new Error('keep spec requires a non-negative integer index');
      }
    } else if (spec.kind === 'text') {
      if (typeof spec.text !== 'string') {
        throw new Error('text spec requires a string text');
      }
      if (/^\s*<ide_[a-z_]+\b/.test(spec.text)) {
        throw new Error('User-typed text may not start with an <ide_*> tag (refs round-trip via keep, not text)');
      }
    } else if (spec.kind === 'image') {
      const src = spec.source;
      if (!src || typeof src !== 'object') {
        throw new Error('image spec requires a source object');
      }
      if (src.type !== 'base64' || typeof src.data !== 'string' || typeof src.media_type !== 'string') {
        throw new Error('image source must be {type:"base64", media_type, data}');
      }
      if (!/^image\/(png|jpeg|gif|webp)$/.test(src.media_type)) {
        throw new Error(`Unsupported image media_type: ${src.media_type}`);
      }
      // Host is the disk-write authority; even though the webview
      // already enforces these limits, validate at the trust boundary
      // so a stale webview or future caller can't persist a non-base64
      // string or an unbounded blob into message.content.
      validateImageBase64(src.data);
    } else {
      throw new Error(`Unsupported block spec kind: ${spec.kind}`);
    }
  }

  let any = false;
  for (const row of rows) {
    if (applyBlockSpecToEntry(row.entry, blocks)) {
      row.changed = true;
      any = true;
    }
  }
  return { changed: any };
}

function applyBlockSpecToEntry(entry, blocks) {
  if (!entry.message || typeof entry.message !== 'object') entry.message = {};
  let content = entry.message.content;
  // Normalise string content to a single-text-block array so the
  // blocks path is uniform. The on-disk shape becomes array form;
  // Anthropic API treats both shapes equivalently.
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return false;
  }
  const newContent = [];
  for (const spec of blocks) {
    if (spec.kind === 'keep') {
      if (spec.index >= content.length) {
        // Out-of-range for THIS row's content (dup-uuid shape drift,
        // exceedingly rare). Skip silently rather than fail; user's
        // other intent (other kept blocks present in this row + new
        // text/image) still applies.
        continue;
      }
      const block = content[spec.index];
      if (!block || typeof block !== 'object') continue;
      // Defensive: only carry text/image. tool_result blocks must
      // never be preserved through this op — canEditUserEntry already
      // rejected the row, but double-gate here too.
      if (block.type === 'text' || block.type === 'image') {
        newContent.push(block);
      }
    } else if (spec.kind === 'text') {
      newContent.push({ type: 'text', text: spec.text });
    } else if (spec.kind === 'image') {
      newContent.push({ type: 'image', source: spec.source });
    }
  }
  if (newContent.length === 0) return false;
  const oldStr = JSON.stringify(content);
  const newStr = JSON.stringify(newContent);
  if (oldStr === newStr) return false;
  entry.message.content = newContent;
  return true;
}

function applyAssistantTextEdit(transcript, uuid, text) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'assistant') throw new Error('Only assistant messages can be edited with this operation');
  if (!canEditAssistantTextEntry(sample)) {
    throw new Error('This assistant record has no editable text block');
  }
  let any = false;
  for (const row of rows) {
    if (replaceTextContent(row.entry, text, { requireExistingText: true })) {
      row.changed = true;
      any = true;
    }
  }
  return { changed: any };
}

function requireTranscriptRows(transcript, uuid) {
  const rows = transcript.rowsByUuid.get(uuid);
  if (!rows || !rows.length) throw new Error(`Message ${uuid} was not found`);
  return rows;
}

// Truncate-from-user: drop the user record at `uuid` and every row
// that follows it in the JSONL, then drop any file-history-snapshot
// rows whose `messageId` referenced something that just died.
//
// This replaces the old delete_message + cascade dance entirely. The
// reasons it's safer:
//   - Cuts by row index, so duplicate uuids inside the cut region
//     vanish together (no "delete uuid X but the compact-preserved
//     copy at row 200 stays"). Earlier dup-uuid copies *before* the
//     cut survive — they're legitimate history.
//   - No parentUuid rewriting. The kept prefix ends at a user-or-
//     earlier boundary, so nothing left has a dangling parent.
//   - No orphan tool_use blocks. tool_use must be triggered by a
//     preceding user input; truncating from the user wipes the entire
//     dependent subtree (assistant replies, tool calls, tool results).
//   - Anthropic API contract holds: messages always start on a user
//     role with strict alternation after re-launch.
//
// `summary` rows whose `leafUuid` belongs only to the cut region get
// dropped with the rest — summaries describe a chain, and a chain
// that's been chopped is no longer summarised by that row. We don't
// try to retarget summaries to an earlier leaf; if the same uuid still
// has a kept row, however, the pre-cut summary still belongs to the
// surviving prefix and stays.
function applyTruncateFromUser(transcript, uuid) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'user') {
    throw new Error('truncate_from_user requires a user message uuid');
  }
  // Same gate as edit: compact-summary / transcript-only records are
  // CLI-managed bookkeeping. Truncating *at* one of these would leave
  // the surviving JSONL with a dangling compact_boundary system record
  // pointing at a removed user line, which the CLI's resume path
  // can't reconcile cleanly. (Truncating *past* one is fine — the
  // boundary itself stays put.)
  if (sample.isCompactSummary === true || sample.isVisibleInTranscriptOnly === true) {
    throw new Error('Compact-summary records cannot be the rerun anchor');
  }
  const cutIdx = rows[rows.length - 1].index;
  const droppedUuids = new Set();
  for (let i = cutIdx; i < transcript.rows.length; i++) {
    const r = transcript.rows[i];
    r.drop = true;
    const e = r.entry;
    if (e && typeof e.uuid === 'string') droppedUuids.add(e.uuid);
  }
  const keptUuids = new Set();
  for (const r of transcript.rows) {
    if (r.drop) continue;
    const e = r.entry;
    if (e && typeof e.uuid === 'string') keptUuids.add(e.uuid);
  }
  // Drop file-history-snapshot rows pointing only into the cut region,
  // even if they appear before the cut (snapshots are typically just
  // before their messageId; defensive sweep covers either layout).
  // Compact transcripts can preserve the same uuid before and after
  // the cut, so uuid membership in `droppedUuids` is not enough by
  // itself. If a kept row still owns that uuid, its pre-cut snapshot is
  // part of the surviving prefix and must stay.
  for (const r of transcript.rows) {
    if (r.drop) continue;
    const e = r.entry;
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'file-history-snapshot' &&
        typeof e.messageId === 'string' &&
        droppedUuids.has(e.messageId) &&
        !keptUuids.has(e.messageId)) {
      r.drop = true;
    }
    // Drop summaries whose leafUuid lands in the cut region.
    if (e.type === 'summary' &&
        typeof e.leafUuid === 'string' &&
        droppedUuids.has(e.leafUuid) &&
        !keptUuids.has(e.leafUuid)) {
      r.drop = true;
    }
  }
  return {
    changed: droppedUuids.size > 0,
    droppedUuids: Array.from(droppedUuids),
    droppedFromIndex: cutIdx,
  };
}

function editableTextFromEntry(entry) {
  return textFromContent(entry && entry.message && entry.message.content);
}

function canEditUserEntry(entry) {
  if (!entry || entry.type !== 'user') return false;
  if (toolResultIdsFromEntry(entry).length !== 0) return false;
  // Compact-summary records: persisted with `isCompactSummary:true` and
  // `isVisibleInTranscriptOnly:true` by the CLI. The webview's UT()
  // wrapper drops both flags when building Iz instances, but here we
  // read the raw JSONL entry — so this is the authoritative gate.
  // These records are CLI-managed bookkeeping; mutating them through
  // the user-edit path leaves the model with a bogus turn the CLI's
  // own compact accounting can't reconcile.
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return false;
  // Slash-command / local-command records: the CLI persists `/<cmd> …`
  // invocations and their local stdout/stderr as a user text block of
  // its internal `<command-*>` / `<local-command-*>` protocol, not as
  // editable prose. Editing/rerunning them would push that XML back
  // through the model as plain text and the headless slash parser then
  // rejects it. Authoritative gate so even a malformed webview request
  // can't mutate one (matches the webview's isSlashCommandRecord).
  if (entryLooksLikeCommandRecord(entry)) return false;
  return true;
}

const COMMAND_RECORD_PREFIX_RE = /^\s*<\/?(?:local-)?command-[a-z]+\b/i;

function entryLooksLikeCommandRecord(entry) {
  const firstText = editableTextFromEntry(entry);
  return typeof firstText === 'string' && COMMAND_RECORD_PREFIX_RE.test(firstText);
}

function canEditAssistantTextEntry(entry) {
  if (!entry || entry.type !== 'assistant') return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some(block =>
    block && block.type === 'text' && typeof block.text === 'string'
  );
}

const SIGNED_THINKING_USER_EDIT_ERROR =
  'This message is followed by signed thinking blocks. Use Save and Rerun instead; ' +
  'a local-only edit would make Claude reject the next request.';

// Anthropic verifies prior `thinking` / `redacted_thinking` blocks against
// their original turn. Editing an upstream user while keeping those blocks
// poisons the next resume; rerun must cut the downstream turn first.
function entryHasSignedThinkingBlock(entry) {
  if (!entry || entry.type !== 'assistant') return false;
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return false;
  return content.some(block => block && (
    block.type === 'thinking' || block.type === 'redacted_thinking'
  ));
}

function userEditHasDownstreamSignedThinking(transcript, uuid) {
  const rows = requireTranscriptRows(transcript, uuid);
  const cutIdx = rows[rows.length - 1].index;
  for (let i = cutIdx + 1; i < transcript.rows.length; i++) {
    if (entryHasSignedThinkingBlock(transcript.rows[i].entry)) return true;
  }
  return false;
}

function replaceTextContent(entry, text, options) {
  if (!entry.message || typeof entry.message !== 'object') entry.message = {};
  const content = entry.message.content;
  const requireExistingText = !!(options && options.requireExistingText);
  if (typeof content === 'string') {
    if (content === text) return false;
    entry.message.content = text;
    return true;
  }
  if (!Array.isArray(content)) {
    if (requireExistingText) return false;
    entry.message.content = text;
    return true;
  }

  let changed = false;
  let wroteText = false;
  const next = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      if (!wroteText) {
        if (block.text !== text) changed = true;
        next.push({ ...block, text });
        wroteText = true;
      } else {
        changed = true;
      }
    } else {
      next.push(block);
    }
  }
  if (!wroteText) {
    if (requireExistingText) return false;
    next.unshift({ type: 'text', text });
    changed = true;
  }
  if (changed) entry.message.content = next;
  return changed;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function toolResultIdsFromEntry(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block && block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map(block => block.tool_use_id);
}

function stopPolling(state) {
  if (!state.started) return;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  state.started = false;
}

function startPolling(state) {
  if (state.started) return;
  state.started = true;
  patchFs(state);
  state.tick = () => schedulePoll(state, 0);
  state.tick();
  state.timer = setInterval(state.tick, POLL_INTERVAL_MS);
}

function patchFs(state) {
  if (state.patchedFs) return;
  state.patchedFs = true;
  const root = projectsRoot();
  wrapFsMethod('appendFile', state, root);
  wrapFsMethod('appendFileSync', state, root);
  wrapFsMethod('writeFile', state, root);
  wrapFsMethod('writeFileSync', state, root);
  wrapFsMethod('createWriteStream', state, root);
}

function wrapFsMethod(name, state, root) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  if (name === 'createWriteStream') {
    fs[name] = function wrappedCreateWriteStream(filePath) {
      const tracked = trackSessionFile(state, root, filePath);
      const stream = original.apply(fs, arguments);
      if (tracked) attachWriteStreamPoll(state, stream);
      return stream;
    };
    return;
  }
  fs[name] = function wrapped(filePath) {
    const tracked = trackSessionFile(state, root, filePath);
    if (!tracked) return original.apply(fs, arguments);

    const args = Array.prototype.slice.call(arguments);
    let scheduled = false;
    const scheduleOnce = () => {
      if (scheduled) return;
      scheduled = true;
      schedulePoll(state, WRITE_POLL_DEBOUNCE_MS);
    };
    const lastIndex = args.length - 1;
    const isSync = name.endsWith('Sync');
    let callbackWrapped = false;
    if (!isSync && typeof args[lastIndex] === 'function') {
      const callback = args[lastIndex];
      callbackWrapped = true;
      args[lastIndex] = function wrappedCallback() {
        try {
          return callback.apply(this, arguments);
        } finally {
          scheduleOnce();
        }
      };
    }

    const result = original.apply(fs, args);
    if (isSync || !callbackWrapped) {
      if (result && typeof result.then === 'function') result.finally(scheduleOnce);
      else scheduleOnce();
    }
    return result;
  };
}

function trackSessionFile(state, root, filePath) {
  if (!isSessionFilePath(root, filePath)) return false;
  if (state.ourFile !== filePath) {
    state.ourFile = filePath;
    state.log(`ourFile=${filePath}`);
  }
  return true;
}

function isSessionFilePath(root, filePath) {
  return (
    typeof filePath === 'string' &&
    filePath.startsWith(root) &&
    filePath.toLowerCase().endsWith(JSONL_SUFFIX)
  );
}

function attachWriteStreamPoll(state, stream) {
  if (!stream || stream.__incipitPollWrapped) return;
  stream.__incipitPollWrapped = true;
  // Event subscriptions only — we deliberately do NOT override
  // `stream.write` / `stream.end`. Overwriting those methods changes the
  // object identity of host APIs and risked surprises in downstream code
  // that holds references to the original prototypes. `finish` fires
  // after the writable side has drained, `close` after the underlying fd
  // is released, and `end` is the user-side finalize entry; together
  // they cover the only moments at which a new poll is actually useful.
  const schedule = () => schedulePoll(state, WRITE_POLL_DEBOUNCE_MS);
  if (typeof stream.once === 'function') {
    try { stream.once('finish', schedule); } catch (_) {}
    try { stream.once('close', schedule); } catch (_) {}
    try { stream.once('end', schedule); } catch (_) {}
  }
}

function schedulePoll(state, delay) {
  if (!state || !state.started) return;
  const wait = Math.max(0, Number(delay) || 0);
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  if (wait === 0) {
    poll(state);
    return;
  }
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    poll(state);
  }, wait);
}

function poll(state) {
  try {
    const targets = resolveTargetFiles(state);
    for (const target of targets) {
      if (!target || !fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (isCacheHit(state, target, stat)) continue;
      const before = state.targetCache.get(target);
      const beforeSnapshot = before ? {
        payload: before.payload,
        usageVersion: before.usageVersion,
        editPayload: before.editPayload,
        editVersion: before.editVersion,
        changeReviewPayload: before.changeReviewPayload,
        changeReviewVersion: before.changeReviewVersion,
      } : null;
      const payload = buildCachedPayload(state, target, stat, false);
      const after = state.targetCache.get(target);
      if (badgeCacheChanged(beforeSnapshot, after)) broadcastTarget(state, target, payload);
      const parser = state.parsers.get(target);
      if (parser) {
        const editPayload = buildCachedEditActivityPayload(state, target, parser);
        persistProjectEditActivitySession(state, target, parser, stat);
        const afterEdit = state.targetCache.get(target);
        if (editCacheChanged(beforeSnapshot, afterEdit)) broadcastEditActivityTarget(state, target, editPayload);
        if (CHANGE_REVIEW_RUNTIME_ENABLED) {
          const changeReviewPayload = buildCachedChangeReviewPayload(state, target, parser);
          const afterReview = state.targetCache.get(target);
          if (changeReviewCacheChanged(beforeSnapshot, afterReview)) broadcastChangeReviewTarget(state, target, changeReviewPayload);
        }
      }
    }
  } catch (error) {
    state.log(`tick error: ${error}`);
  }
}

function resolveTargetFiles(state) {
  const targets = new Set();
  let hasIdentity = false;
  for (const [comm, identity] of state.commIdentities) {
    if (!state.comms.has(comm) || !identity || !identity.sessionId) continue;
    hasIdentity = true;
    let target = identity.target;
    if (!target || !fs.existsSync(target)) {
      target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      identity.target = target;
    }
    if (target) targets.add(target);
  }
  if (!hasIdentity) return [];
  if (state.ourFile) {
    const ourBase = path.basename(state.ourFile);
    for (const identity of state.commIdentities.values()) {
      if (!identity || !identity.sessionId) continue;
      if (identity.target === state.ourFile || ourBase === identity.sessionId + JSONL_SUFFIX) {
        if (!identity.target) identity.target = state.ourFile;
        targets.add(state.ourFile);
        break;
      }
    }
  }
  return Array.from(targets);
}

// Direct (sessionId, cwd) → JSONL path. Mirrors Claude Code's own encoding
// (`cwd.replace(/[^a-zA-Z0-9]/g, '-')`) and fixes target by `<sessionId>.jsonl`.
// When a cwd hint exists, it is part of the identity: a miss fails closed
// instead of searching another project and silently binding the badge to
// a different visible conversation.
function resolveTargetFromIdentity(sessionId, cwd) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  if (typeof cwd === 'string' && cwd) {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const candidate = path.join(projectsRoot(), encoded, sessionId + JSONL_SUFFIX);
    return fs.existsSync(candidate) ? candidate : null;
  }
  // No cwd hint — search every project dir for a matching `<sessionId>.jsonl`.
  // Cheap because we only stat one filename per dir. Kept as a compatibility
  // path for older webviews and degraded bridges; current webviews send cwd.
  const root = projectsRoot();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, sessionId + JSONL_SUFFIX);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isCacheHit(state, filePath, stat) {
  const cached = state.targetCache.get(filePath);
  return (
    cached &&
    stat &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.payload
  );
}

function cachedBadgePayload(state, target, includeHistory) {
  const cached = target ? state.targetCache.get(target) : null;
  if (!cached) return null;
  return includeHistory ? (cached.historyPayload || null) : (cached.payload || null);
}

function badgeCacheChanged(before, after) {
  if (!after || !after.payload) return false;
  if (!before || !before.payload) return true;
  return before.usageVersion !== after.usageVersion;
}

function editCacheChanged(before, after) {
  if (!after || !after.editPayload) return false;
  if (!before || !before.editPayload) return true;
  return before.editVersion !== after.editVersion;
}

function changeReviewCacheChanged(before, after) {
  if (!after || !after.changeReviewPayload) return false;
  if (!before || !before.changeReviewPayload) return true;
  return before.changeReviewVersion !== after.changeReviewVersion;
}

function buildCachedPayload(state, target, stat, includeHistory) {
  const cached = state.targetCache.get(target);
  const sameFileStat = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs;
  if (sameFileStat) {
    const hit = includeHistory ? cached.historyPayload : cached.payload;
    if (hit) return hit;
  }

  const parser = updateParser(state, target, stat);
  const sameUsageVersion = cached && cached.usageVersion === parser.usageVersion;
  const next = sameFileStat ? cached : {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    usageVersion: parser.usageVersion,
    editVersion: cached ? cached.editVersion : undefined,
    changeReviewVersion: cached ? cached.changeReviewVersion : undefined,
    payload: sameUsageVersion ? cached.payload : null,
    historyPayload: sameUsageVersion ? cached.historyPayload : null,
    editPayload: cached ? cached.editPayload : null,
    changeReviewPayload: cached ? cached.changeReviewPayload : null,
  };
  next.size = stat.size;
  next.mtimeMs = stat.mtimeMs;
  next.usageVersion = parser.usageVersion;
  if (!next.payload) next.payload = buildPayload(parser, false) || emptyBadgePayload(null, target);
  if (includeHistory && !next.historyPayload) {
    next.historyPayload = buildPayload(parser, true) || emptyBadgePayload(null, target);
  }
  state.targetCache.set(target, next);
  return includeHistory ? next.historyPayload : next.payload;
}

function buildCachedEditActivityPayload(state, target, parser) {
  const cached = state.targetCache.get(target) || {
    size: parser.size || 0,
    mtimeMs: parser.mtimeMs || 0,
    usageVersion: parser.usageVersion || 0,
    payload: null,
    historyPayload: null,
  };
  if (cached.editPayload && cached.editVersion === parser.editVersion) {
    return cached.editPayload;
  }
  cached.editVersion = parser.editVersion;
  cached.editPayload = buildEditActivityPayload(parser);
  state.targetCache.set(target, cached);
  return cached.editPayload;
}

function buildCachedChangeReviewPayload(state, target, parser) {
  const cached = state.targetCache.get(target) || {
    size: parser.size || 0,
    mtimeMs: parser.mtimeMs || 0,
    usageVersion: parser.usageVersion || 0,
    payload: null,
    historyPayload: null,
    editPayload: null,
  };
  const reviewState = loadChangeReviewState(state, path.basename(parser.path, JSONL_SUFFIX));
  const parserChanged = captureChangeReviewGuards(parser, reviewState, { onlyFinalized: true });
  if (reviewState.dirty) saveChangeReviewState(state, reviewState);
  if (parserChanged) saveUsageCacheParser(state, parser, {
    size: parser.size || 0,
    mtimeMs: parser.mtimeMs || 0,
  });
  const version = parser.changeReviewVersion + ':' + (reviewState.version || 0);
  if (cached.changeReviewPayload && cached.changeReviewVersion === version) {
    return cached.changeReviewPayload;
  }
  cached.changeReviewVersion = version;
  cached.changeReviewPayload = buildChangeReviewPayload(parser, reviewState);
  state.targetCache.set(target, cached);
  return cached.changeReviewPayload;
}

function sendCurrentBadgePayload(state, comm, target, sessionId, includeHistory) {
  if (!target || !fs.existsSync(target)) {
    sendPayload(comm, emptyBadgePayload(sessionId, target || null));
    return;
  }
  try {
    const stat = fs.statSync(target);
    let payload = cachedBadgePayload(state, target, includeHistory);
    if (!payload || !isCacheHit(state, target, stat)) {
      payload = buildCachedPayload(state, target, stat, includeHistory);
    }
    sendPayload(comm, annotateBadgePayload(payload, sessionId, target));
  } catch (_) {
    sendPayload(comm, emptyBadgePayload(sessionId, target));
  }
}

function sendCurrentEditActivityPayload(state, comm, target, sessionId, includeProject) {
  if (!target || !fs.existsSync(target)) {
    sendEditActivityPayload(comm, emptyEditActivityPayload(sessionId, target || null));
    return;
  }
  try {
    const stat = fs.statSync(target);
    const parser = updateParser(state, target, stat);
    const conversation = annotateEditActivityPayload(
      buildCachedEditActivityPayload(state, target, parser),
      sessionId,
      target
    );
    persistProjectEditActivitySession(state, target, parser, stat);
    const project = includeProject
      ? buildProjectEditActivityResponse(state, target, comm, sessionId)
      : null;
    sendEditActivityPayload(comm, editActivityEnvelope(conversation, project));
  } catch (_) {
    sendEditActivityPayload(comm, emptyEditActivityPayload(sessionId, target));
  }
}

function sendCurrentChangeReviewPayload(state, comm, target, sessionId) {
  if (!target || !fs.existsSync(target)) {
    sendChangeReviewPayload(comm, emptyChangeReviewPayload(sessionId, target || null));
    return;
  }
  try {
    const stat = fs.statSync(target);
    const parser = updateParser(state, target, stat);
    const payload = annotateChangeReviewPayload(
      buildCachedChangeReviewPayload(state, target, parser),
      sessionId,
      target
    );
    sendChangeReviewPayload(comm, payload);
  } catch (_) {
    sendChangeReviewPayload(comm, emptyChangeReviewPayload(sessionId, target));
  }
}

function emptyBadgePayload(sessionId, target) {
  return {
    empty: true,
    sessionId: sessionId || null,
    src: target || null,
    ts: Date.now(),
    recent: [],
    totals: null,
  };
}

function emptyEditActivityPayload(sessionId, target) {
  return {
    empty: true,
    sessionId: sessionId || null,
    src: target || null,
    ts: Date.now(),
    totals: { added: 0, removed: 0, edits: 0, activeDays: 0 },
    days: [],
  };
}

function emptyChangeReviewPayload(sessionId, target) {
  return {
    empty: true,
    sessionId: sessionId || null,
    src: target || null,
    cwd: null,
    ts: Date.now(),
    latestTurn: null,
    turns: [],
    totals: { files: 0, added: 0, removed: 0 },
  };
}

function annotateBadgePayload(payload, sessionId, target) {
  if (!payload || typeof payload !== 'object') return emptyBadgePayload(sessionId, target);
  if (!sessionId || payload.sessionId === sessionId) return payload;
  return { ...payload, sessionId };
}

function annotateEditActivityPayload(payload, sessionId, target) {
  if (!payload || typeof payload !== 'object') return emptyEditActivityPayload(sessionId, target);
  return {
    ...payload,
    sessionId: sessionId || payload.sessionId || null,
    src: target || payload.src || null,
  };
}

function annotateChangeReviewPayload(payload, sessionId, target) {
  if (!payload || typeof payload !== 'object') return emptyChangeReviewPayload(sessionId, target);
  return {
    ...payload,
    sessionId: sessionId || payload.sessionId || null,
    src: target || payload.src || null,
  };
}

function editActivityEnvelope(conversation, project) {
  const base = conversation || emptyEditActivityPayload(null, null);
  return {
    ...base,
    conversation: base,
    project: project || null,
  };
}

// JSONL session files are append-only in steady state. Reading the whole file
// every 1.5s on a long, streaming session was a measurable extension-host
// stall (22-29MB files parsed in ~100-150ms per tick).
//
// Strategy:
//   - Keep parser state across ticks: file size + partial trailing line +
//     `byRequest` map + order list + running token sums.
//   - On growth: read only `[oldSize, newSize)`, decode through StringDecoder
//     so a multi-byte UTF-8 char split across the boundary survives, split on
//     newline, accumulate.
//   - On shrink / path swap / first run: rebuild from scratch (rare).
//
// The host writer can in principle update the same `requestId` later, so
// `processLine` subtracts old contributions before adding new ones — keeps
// `sums` correct without a full re-scan.
function updateParser(state, target, stat) {
  let parser = state.parsers.get(target);
  const needReset =
    !parser ||
    parser.path !== target ||
    stat.size < parser.size ||
    (stat.size === parser.size && parser.mtimeMs && stat.mtimeMs !== parser.mtimeMs);
  if (needReset) {
    parser = loadUsageCacheParser(state, target, stat) || createParser(target);
    state.parsers.set(target, parser);
  }
  if (stat.size > parser.size) appendNewBytes(parser, target, stat.size);
  parser.mtimeMs = stat.mtimeMs;
  saveUsageCacheParser(state, parser, stat);
  return parser;
}

function createParser(filePath, options = {}) {
  return {
    path: filePath,
    editOnly: options.editOnly === true,
    size: 0,
    committedSize: 0,
    mtimeMs: 0,
    partialLine: '',
    partialChunks: [],
    partialLength: 0,
    decoder: new StringDecoder('utf8'),
    byRequest: new Map(),
    order: [],
    sums: { fresh: 0, cw: 0, cr: 0, out: 0 },
    latestUsageId: null,
    projectCwd: null,
    editPending: new Map(),
    editCounted: new Map(),
    editDays: new Map(),
    editSums: { added: 0, removed: 0, edits: 0 },
    changeReviewTurns: new Map(),
    changeReviewAssistantTurns: new Map(),
    changeReviewSnapshotUpdates: new Map(),
    changeReviewTurnBaselines: new Map(),
    changeReviewPendingSummaries: new Map(),
    changeReviewCurrentTurnKey: null,
    changeReviewVersion: 0,
    usageVersion: 0,
    editVersion: 0,
    persistDirty: false,
  };
}

function usageCacheKeyForFile(filePath) {
  const resolved = path.resolve(filePath || '');
  const stable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

function usageCacheIndexPath(filePath) {
  return path.join(USAGE_CACHE_INDEX_DIR, usageCacheKeyForFile(filePath) + '.json');
}

function deleteUsageCacheIndex(filePath) {
  try {
    const indexPath = usageCacheIndexPath(filePath);
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
  } catch (_) {}
}

function readFileHashSlice(filePath, start, length) {
  if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return null;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function usageCacheGuards(filePath, indexedSize) {
  const size = Math.max(0, Math.floor(indexedSize || 0));
  const headLength = Math.min(USAGE_CACHE_HASH_BYTES, size);
  const tailLength = Math.min(USAGE_CACHE_HASH_BYTES, size);
  const tailStart = Math.max(0, size - tailLength);
  return {
    headLength,
    headHash: headLength ? readFileHashSlice(filePath, 0, headLength) : null,
    tailStart,
    tailLength,
    tailHash: tailLength ? readFileHashSlice(filePath, tailStart, tailLength) : null,
  };
}

function usageCacheGuardsMatch(filePath, index) {
  if (!index || !index.guards) return false;
  const guards = index.guards;
  if (guards.headLength) {
    const headHash = readFileHashSlice(filePath, 0, guards.headLength);
    if (!headHash || headHash !== guards.headHash) return false;
  }
  if (guards.tailLength) {
    const tailHash = readFileHashSlice(filePath, guards.tailStart || 0, guards.tailLength);
    if (!tailHash || tailHash !== guards.tailHash) return false;
  }
  return true;
}

function safeTokenNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function compactUsage(usage) {
  usage = usage && typeof usage === 'object' ? usage : {};
  return {
    input_tokens: safeTokenNumber(usage.input_tokens),
    cache_creation_input_tokens: safeTokenNumber(usage.cache_creation_input_tokens),
    cache_read_input_tokens: safeTokenNumber(usage.cache_read_input_tokens),
    output_tokens: safeTokenNumber(usage.output_tokens),
  };
}

function compactEditItem(item) {
  if (!item || typeof item.id !== 'string' || !item.id) return null;
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    ts: typeof item.ts === 'string' ? item.ts : '',
    day: typeof item.day === 'string' && item.day ? item.day : localDayKey(item.ts),
    filePath: typeof item.filePath === 'string' ? item.filePath : '',
    turnKey: typeof item.turnKey === 'string' ? item.turnKey : null,
    assistantUuid: typeof item.assistantUuid === 'string' && item.assistantUuid ? item.assistantUuid : null,
    added: safeTokenNumber(item.added),
    removed: safeTokenNumber(item.removed),
  };
}

function compactChangeReviewFile(file) {
  if (!file || typeof file.filePath !== 'string' || !file.filePath) return null;
  const out = {
    rawPath: typeof file.rawPath === 'string' ? file.rawPath : '',
    filePath: file.filePath,
    displayPath: typeof file.displayPath === 'string' ? file.displayPath : '',
    version: Number.isFinite(file.version) ? file.version : null,
    backupTime: typeof file.backupTime === 'string' ? file.backupTime : '',
    added: safeTokenNumber(file.added),
    removed: safeTokenNumber(file.removed),
    hasLineStats: file.hasLineStats === true,
    tool: typeof file.tool === 'string' ? file.tool : '',
    toolIds: Array.from(file.toolIds instanceof Set ? file.toolIds : []).filter(id => typeof id === 'string' && id),
    firstSeenAt: Number.isFinite(file.firstSeenAt) ? file.firstSeenAt : 0,
    lastSeenAt: Number.isFinite(file.lastSeenAt) ? file.lastSeenAt : 0,
  };
  if (Object.prototype.hasOwnProperty.call(file, 'backupFileName')) {
    out.backupFileName = file.backupFileName === null ? null
      : (typeof file.backupFileName === 'string' ? file.backupFileName : undefined);
  }
  return out;
}

function compactChangeReviewTurnSummary(summary) {
  if (!summary || safeTokenNumber(summary.files) <= 0) return null;
  return {
    source: typeof summary.source === 'string' && summary.source ? summary.source : 'subagent',
    sourceLabel: typeof summary.sourceLabel === 'string' && summary.sourceLabel ? summary.sourceLabel : 'Sub-agent',
    agentTypes: Array.from(summary.agentTypes instanceof Set ? summary.agentTypes : [])
      .filter(type => typeof type === 'string' && type),
    files: safeTokenNumber(summary.files),
    added: safeTokenNumber(summary.added),
    removed: safeTokenNumber(summary.removed),
    hasLineStats: summary.hasLineStats === true,
    toolIds: Array.from(summary.toolIds instanceof Set ? summary.toolIds : [])
      .filter(id => typeof id === 'string' && id),
    firstSeenAt: Number.isFinite(summary.firstSeenAt) ? summary.firstSeenAt : 0,
    lastSeenAt: Number.isFinite(summary.lastSeenAt) ? summary.lastSeenAt : 0,
  };
}

function compactChangeReviewPendingSummary(item) {
  if (!item || typeof item.id !== 'string' || !item.id) return null;
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    source: typeof item.source === 'string' && item.source ? item.source : 'subagent',
    sourceLabel: typeof item.sourceLabel === 'string' && item.sourceLabel ? item.sourceLabel : 'Sub-agent',
    agentTypes: Array.isArray(item.agentTypes)
      ? item.agentTypes.filter(type => typeof type === 'string' && type)
      : [],
    ts: typeof item.ts === 'string' ? item.ts : '',
    turnKey: typeof item.turnKey === 'string' ? item.turnKey : null,
    assistantUuid: typeof item.assistantUuid === 'string' && item.assistantUuid ? item.assistantUuid : null,
  };
}

function hydrateChangeReviewTurnSummary(raw) {
  if (!raw || typeof raw !== 'object' || safeTokenNumber(raw.files) <= 0) return null;
  return {
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'subagent',
    sourceLabel: typeof raw.sourceLabel === 'string' && raw.sourceLabel ? raw.sourceLabel : 'Sub-agent',
    agentTypes: new Set(Array.isArray(raw.agentTypes)
      ? raw.agentTypes.filter(type => typeof type === 'string' && type)
      : []),
    files: safeTokenNumber(raw.files),
    added: safeTokenNumber(raw.added),
    removed: safeTokenNumber(raw.removed),
    hasLineStats: raw.hasLineStats === true,
    toolIds: new Set(Array.isArray(raw.toolIds)
      ? raw.toolIds.filter(id => typeof id === 'string' && id)
      : []),
    firstSeenAt: Number.isFinite(raw.firstSeenAt) ? raw.firstSeenAt : 0,
    lastSeenAt: Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : 0,
  };
}

function compactChangeReviewTurn(turn) {
  if (!turn || typeof turn.turnKey !== 'string' || !turn.turnKey || !(turn.files instanceof Map)) return null;
  const files = Array.from(turn.files.values()).map(compactChangeReviewFile).filter(Boolean);
  const summary = compactChangeReviewTurnSummary(turn.summary);
  if (!files.length && !summary) return null;
  return {
    turnKey: turn.turnKey,
    cwd: typeof turn.cwd === 'string' ? turn.cwd : '',
    timestamp: typeof turn.timestamp === 'string' ? turn.timestamp : '',
    lifecycleStartedAt: Number.isFinite(turn.lifecycleStartedAt) ? turn.lifecycleStartedAt : 0,
    order: Number.isFinite(turn.order) ? turn.order : 0,
    summary,
    files,
  };
}

function compactChangeReviewSnapshotUpdate(update) {
  if (!update || typeof update.rawPath !== 'string' || !update.rawPath) return null;
  const out = {
    rawPath: update.rawPath,
    filePath: typeof update.filePath === 'string' ? update.filePath : '',
    cwd: typeof update.cwd === 'string' ? update.cwd : '',
    timestamp: typeof update.timestamp === 'string' ? update.timestamp : '',
    version: Number.isFinite(update.version) ? update.version : null,
    backupTime: typeof update.backupTime === 'string' ? update.backupTime : '',
  };
  if (Object.prototype.hasOwnProperty.call(update, 'backupFileName')) {
    out.backupFileName = update.backupFileName === null ? null
      : (typeof update.backupFileName === 'string' ? update.backupFileName : undefined);
  }
  return out;
}

function serializeUsageCacheParser(parser, stat) {
  if (!parser || parser.editOnly || !parser.path) return null;
  const indexedSize = Math.max(0, Math.min(parser.committedSize || 0, parser.size || 0));
  if (indexedSize <= 0) return null;
  const guards = usageCacheGuards(parser.path, indexedSize);
  const records = [];
  for (const id of parser.order) {
    const row = parser.byRequest.get(id);
    if (!row) continue;
    records.push({
      id,
      ts: typeof row.ts === 'string' ? row.ts : '',
      usage: compactUsage(row.usage),
    });
  }
  return {
    schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
    pathKey: usageCacheKeyForFile(parser.path),
    sourceBasename: path.basename(parser.path),
    indexedSize,
    fileSizeAtSave: stat && Number.isFinite(stat.size) ? stat.size : parser.size,
    completeAtSave: !!(stat && indexedSize === stat.size),
    mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : parser.mtimeMs,
    updatedAt: Date.now(),
    guards,
    projectCwd: parser.projectCwd || null,
    usage: {
      usageVersion: parser.usageVersion || 0,
      latestUsageId: parser.latestUsageId || null,
      records,
    },
    edit: {
      editVersion: parser.editVersion || 0,
      pending: Array.from(parser.editPending.values()).map(compactEditItem).filter(Boolean),
      counted: Array.from(parser.editCounted.values()).map(compactEditItem).filter(Boolean),
    },
    changeReview: {
      changeReviewVersion: parser.changeReviewVersion || 0,
      currentTurnKey: parser.changeReviewCurrentTurnKey || null,
      assistantTurns: Array.from(parser.changeReviewAssistantTurns instanceof Map
        ? parser.changeReviewAssistantTurns.entries()
        : [])
        .filter(([assistantUuid, turnKey]) => typeof assistantUuid === 'string' && assistantUuid && typeof turnKey === 'string' && turnKey),
      snapshotUpdates: Array.from(parser.changeReviewSnapshotUpdates instanceof Map
        ? parser.changeReviewSnapshotUpdates.entries()
        : [])
        .map(([assistantUuid, updates]) => [
          assistantUuid,
          (Array.isArray(updates) ? updates : [])
            .map(compactChangeReviewSnapshotUpdate)
            .filter(Boolean),
        ])
        .filter(([assistantUuid, updates]) => typeof assistantUuid === 'string' && assistantUuid && updates.length),
      turnBaselines: Array.from(parser.changeReviewTurnBaselines instanceof Map
        ? parser.changeReviewTurnBaselines.entries()
        : [])
        .map(([turnKey, updates]) => [
          turnKey,
          Array.from(updates instanceof Map ? updates.values() : [])
            .map(compactChangeReviewSnapshotUpdate)
            .filter(Boolean),
        ])
        .filter(([turnKey, updates]) => typeof turnKey === 'string' && turnKey && updates.length),
      pendingSummaries: Array.from(parser.changeReviewPendingSummaries instanceof Map
        ? parser.changeReviewPendingSummaries.values()
        : [])
        .map(compactChangeReviewPendingSummary)
        .filter(Boolean),
      turns: Array.from(parser.changeReviewTurns.values()).map(compactChangeReviewTurn).filter(Boolean),
    },
  };
}

function saveUsageCacheParser(state, parser, stat) {
  if (!parser || parser.editOnly || !parser.persistDirty) return;
  try {
    const index = serializeUsageCacheParser(parser, stat);
    if (!index) return;
    fs.mkdirSync(USAGE_CACHE_INDEX_DIR, { recursive: true });
    const finalPath = usageCacheIndexPath(parser.path);
    const tmpPath = finalPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(index));
    fs.renameSync(tmpPath, finalPath);
    parser.persistDirty = false;
  } catch (error) {
    if (state && typeof state.log === 'function') {
      state.log(`usage cache index save skipped: ${error && error.message ? error.message : error}`);
    }
  }
}

function loadUsageCacheParser(state, target, stat) {
  try {
    const indexPath = usageCacheIndexPath(target);
    if (!fs.existsSync(indexPath)) return null;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!index || index.schemaVersion !== USAGE_CACHE_SCHEMA_VERSION) return null;
    if (index.pathKey !== usageCacheKeyForFile(target)) return null;
    if (index.sourceBasename !== path.basename(target)) return null;
    const indexedSize = Number(index.indexedSize);
    if (!Number.isFinite(indexedSize) || indexedSize < 0 || indexedSize > stat.size) return null;
    if (indexedSize <= 0) return null;
    if (index.completeAtSave && indexedSize === stat.size && index.mtimeMs !== stat.mtimeMs) return null;
    if (!usageCacheGuardsMatch(target, index)) return null;
    const parser = createParser(target);
    parser.size = indexedSize;
    parser.committedSize = indexedSize;
    parser.mtimeMs = Number.isFinite(index.mtimeMs) ? index.mtimeMs : 0;
    if (!hydrateUsageCacheParser(parser, index)) return null;
    parser.persistDirty = false;
    return parser;
  } catch (error) {
    if (state && typeof state.log === 'function') {
      state.log(`usage cache index ignored: ${error && error.message ? error.message : error}`);
    }
    return null;
  }
}

function hydrateUsageCacheParser(parser, index) {
  parser.projectCwd = typeof index.projectCwd === 'string' && index.projectCwd ? index.projectCwd : null;
  const usage = index.usage && typeof index.usage === 'object' ? index.usage : {};
  const records = Array.isArray(usage.records) ? usage.records : [];
  const seen = new Set();
  parser.byRequest = new Map();
  parser.order = [];
  parser.sums = { fresh: 0, cw: 0, cr: 0, out: 0 };
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id || seen.has(record.id)) return false;
    const compact = compactUsage(record.usage);
    seen.add(record.id);
    parser.order.push(record.id);
    parser.byRequest.set(record.id, {
      ts: typeof record.ts === 'string' ? record.ts : '',
      usage: compact,
    });
    parser.sums.fresh += compact.input_tokens || 0;
    parser.sums.cw += compact.cache_creation_input_tokens || 0;
    parser.sums.cr += compact.cache_read_input_tokens || 0;
    parser.sums.out += compact.output_tokens || 0;
  }
  parser.latestUsageId = typeof usage.latestUsageId === 'string' && parser.byRequest.has(usage.latestUsageId)
    ? usage.latestUsageId
    : (parser.order.length ? parser.order[parser.order.length - 1] : null);
  parser.usageVersion = Number.isFinite(usage.usageVersion)
    ? usage.usageVersion
    : parser.order.length;

  const edit = index.edit && typeof index.edit === 'object' ? index.edit : {};
  parser.editPending = new Map();
  parser.editCounted = new Map();
  parser.editDays = new Map();
  parser.editSums = { added: 0, removed: 0, edits: 0 };
  const counted = Array.isArray(edit.counted) ? edit.counted : [];
  for (const raw of counted) {
    const item = compactEditItem(raw);
    if (!item || parser.editCounted.has(item.id)) continue;
    parser.editCounted.set(item.id, item);
    parser.editSums.added += item.added || 0;
    parser.editSums.removed += item.removed || 0;
    parser.editSums.edits += 1;
    const key = item.day || localDayKey(item.ts);
    let day = parser.editDays.get(key);
    if (!day) {
      day = { day: key, added: 0, removed: 0, edits: 0 };
      parser.editDays.set(key, day);
    }
    day.added += item.added || 0;
    day.removed += item.removed || 0;
    day.edits += 1;
  }
  const pending = Array.isArray(edit.pending) ? edit.pending : [];
  for (const raw of pending) {
    const item = compactEditItem(raw);
    if (!item || parser.editCounted.has(item.id)) continue;
    parser.editPending.set(item.id, item);
  }
  parser.editVersion = Number.isFinite(edit.editVersion)
    ? edit.editVersion
    : parser.editCounted.size;

  const review = index.changeReview && typeof index.changeReview === 'object' ? index.changeReview : {};
  parser.changeReviewTurns = new Map();
  parser.changeReviewAssistantTurns = new Map();
  parser.changeReviewSnapshotUpdates = new Map();
  parser.changeReviewTurnBaselines = new Map();
  parser.changeReviewPendingSummaries = new Map();
  parser.changeReviewCurrentTurnKey = typeof review.currentTurnKey === 'string' && review.currentTurnKey
    ? review.currentTurnKey
    : null;
  const assistantTurns = Array.isArray(review.assistantTurns) ? review.assistantTurns : [];
  for (const pair of assistantTurns) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const assistantUuid = typeof pair[0] === 'string' ? pair[0] : '';
    const turnKey = typeof pair[1] === 'string' ? pair[1] : '';
    if (assistantUuid && turnKey) parser.changeReviewAssistantTurns.set(assistantUuid, turnKey);
  }
  const snapshotUpdates = Array.isArray(review.snapshotUpdates) ? review.snapshotUpdates : [];
  for (const pair of snapshotUpdates) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const assistantUuid = typeof pair[0] === 'string' && pair[0] ? pair[0] : '';
    const updates = Array.isArray(pair[1]) ? pair[1] : [];
    if (!assistantUuid || !updates.length) continue;
    const compacted = updates.map(compactChangeReviewSnapshotUpdate).filter(Boolean);
    if (compacted.length) parser.changeReviewSnapshotUpdates.set(assistantUuid, compacted);
  }
  const turnBaselines = Array.isArray(review.turnBaselines) ? review.turnBaselines : [];
  for (const pair of turnBaselines) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const turnKey = typeof pair[0] === 'string' && pair[0] ? pair[0] : '';
    const updates = Array.isArray(pair[1]) ? pair[1] : [];
    if (!turnKey || !updates.length) continue;
    const map = new Map();
    for (const rawUpdate of updates) {
      const update = compactChangeReviewSnapshotUpdate(rawUpdate);
      const key = changeReviewTurnBaselineKey(update);
      if (key && update) map.set(key, update);
    }
    if (map.size) parser.changeReviewTurnBaselines.set(turnKey, map);
  }
  const pendingSummaries = Array.isArray(review.pendingSummaries) ? review.pendingSummaries : [];
  for (const raw of pendingSummaries) {
    const item = compactChangeReviewPendingSummary(raw);
    if (!item || parser.changeReviewPendingSummaries.has(item.id)) continue;
    parser.changeReviewPendingSummaries.set(item.id, item);
  }
  const expectedSessionId = path.basename(parser.path, JSONL_SUFFIX);
  const rawTurns = Array.isArray(review.turns) ? review.turns : [];
  const seenTurns = new Set();
  for (const rawTurn of rawTurns) {
    if (!rawTurn || typeof rawTurn.turnKey !== 'string' || !rawTurn.turnKey || seenTurns.has(rawTurn.turnKey)) continue;
    seenTurns.add(rawTurn.turnKey);
    const turn = {
      id: rawTurn.turnKey,
      turnKey: rawTurn.turnKey,
      sessionId: expectedSessionId,
      cwd: typeof rawTurn.cwd === 'string' ? rawTurn.cwd : '',
      timestamp: typeof rawTurn.timestamp === 'string' ? rawTurn.timestamp : '',
      files: new Map(),
      summary: hydrateChangeReviewTurnSummary(rawTurn.summary),
      lifecycleStartedAt: Number.isFinite(rawTurn.lifecycleStartedAt) ? rawTurn.lifecycleStartedAt : 0,
      order: Number.isFinite(rawTurn.order) ? rawTurn.order : parser.changeReviewTurns.size,
    };
    const rawFiles = Array.isArray(rawTurn.files) ? rawTurn.files : [];
    for (const rawFile of rawFiles) {
      if (!rawFile || typeof rawFile !== 'object') continue;
      const filePath = typeof rawFile.filePath === 'string' && rawFile.filePath
        ? path.resolve(rawFile.filePath)
        : resolveChangeReviewPath(rawFile.rawPath || '', turn.cwd || parser.projectCwd);
      if (!filePath) continue;
      const key = changeReviewFileKey(filePath);
      if (!key || turn.files.has(key)) continue;
      const file = {
        id: changeReviewEntryId(expectedSessionId, turn.turnKey, filePath),
        sessionId: expectedSessionId,
        turnKey: turn.turnKey,
        rawPath: typeof rawFile.rawPath === 'string' && rawFile.rawPath ? rawFile.rawPath : filePath,
        filePath,
        displayPath: typeof rawFile.displayPath === 'string' && rawFile.displayPath
          ? rawFile.displayPath
          : displayChangeReviewPath(filePath, turn.cwd || parser.projectCwd, rawFile.rawPath),
        backupFileName: undefined,
        version: Number.isFinite(rawFile.version) ? rawFile.version : null,
        backupTime: typeof rawFile.backupTime === 'string' ? rawFile.backupTime : '',
        added: safeTokenNumber(rawFile.added),
        removed: safeTokenNumber(rawFile.removed),
        hasLineStats: rawFile.hasLineStats === true,
        tool: typeof rawFile.tool === 'string' ? rawFile.tool : '',
        toolIds: new Set(Array.isArray(rawFile.toolIds) ? rawFile.toolIds.filter(id => typeof id === 'string' && id) : []),
        firstSeenAt: Number.isFinite(rawFile.firstSeenAt) ? rawFile.firstSeenAt : 0,
        lastSeenAt: Number.isFinite(rawFile.lastSeenAt) ? rawFile.lastSeenAt : 0,
      };
      if (Object.prototype.hasOwnProperty.call(rawFile, 'backupFileName')) {
        file.backupFileName = rawFile.backupFileName === null ? null
          : (typeof rawFile.backupFileName === 'string' ? rawFile.backupFileName : undefined);
      }
      turn.files.set(key, file);
    }
    if (turn.files.size || turn.summary) parser.changeReviewTurns.set(turn.turnKey, turn);
  }
  parser.changeReviewVersion = Number.isFinite(review.changeReviewVersion)
    ? review.changeReviewVersion
    : parser.changeReviewTurns.size;
  return true;
}

function appendNewBytes(parser, filePath, newSize) {
  const length = newSize - parser.size;
  if (length <= 0) return;
  const oldSize = parser.size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, oldSize);
    parser.size = newSize;
    const decoded = parser.decoder.write(buffer);
    appendDecodedText(parser, decoded);
    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline !== -1) parser.committedSize = oldSize + lastNewline + 1;
  } finally {
    fs.closeSync(fd);
  }
}

function appendDecodedText(parser, decoded) {
  if (!decoded) return;
  // Streaming writes may extend one unfinished JSONL row for many ticks.
  // Keep those chunks as an array so each poll does not repeatedly flatten
  // the whole growing assistant message before a newline arrives.
  if (decoded.indexOf('\n') === -1) {
    appendPartialLine(parser, decoded);
    return;
  }
  const text = takePartialLine(parser) + decoded;
  const lines = text.split('\n');
  setPartialLine(parser, lines.pop() || '');
  for (let i = 0; i < lines.length; i++) processLine(parser, lines[i]);
}

function appendPartialLine(parser, text) {
  if (!text) return;
  parser.partialChunks.push(text);
  parser.partialLength += text.length;
  parser.partialLine = parser.partialLength <= 4096
    ? parser.partialLine + text
    : '';
}

function setPartialLine(parser, text) {
  parser.partialChunks = text ? [text] : [];
  parser.partialLength = text ? text.length : 0;
  parser.partialLine = text && text.length <= 4096 ? text : '';
}

function takePartialLine(parser) {
  if (!parser.partialChunks.length) return parser.partialLine || '';
  const text = parser.partialChunks.join('');
  setPartialLine(parser, '');
  return text;
}

function processLine(parser, line) {
  if (!line) return;
  const entry = parseJsonLine(line);
  if (!entry) return;
  if (typeof entry.cwd === 'string' && entry.cwd && parser.projectCwd !== entry.cwd) {
    parser.projectCwd = entry.cwd;
    parser.persistDirty = true;
  }
  processChangeReviewEntry(parser, entry);
  processUsageEntry(parser, entry);
  processEditActivityEntry(parser, entry);
}

function processUsageEntry(parser, entry) {
  if (parser.editOnly) return;
  if (!entry || entry.type !== 'assistant') return;
  if (!entry.message?.usage) return;
  const requestId = entry.requestId || `idx${parser.order.length}`;
  const usage = entry.message.usage;
  const ts = entry.timestamp || '';
  const old = parser.byRequest.get(requestId);
  if (old) {
    parser.sums.fresh -= old.usage.input_tokens || 0;
    parser.sums.cw    -= old.usage.cache_creation_input_tokens || 0;
    parser.sums.cr    -= old.usage.cache_read_input_tokens || 0;
    parser.sums.out   -= old.usage.output_tokens || 0;
    if (parser.order[parser.order.length - 1] !== requestId) {
      const idx = parser.order.indexOf(requestId);
      if (idx !== -1) parser.order.splice(idx, 1);
      parser.order.push(requestId);
    }
  } else {
    parser.order.push(requestId);
  }
  parser.sums.fresh += usage.input_tokens || 0;
  parser.sums.cw    += usage.cache_creation_input_tokens || 0;
  parser.sums.cr    += usage.cache_read_input_tokens || 0;
  parser.sums.out   += usage.output_tokens || 0;
  parser.byRequest.set(requestId, { usage, ts });
  parser.latestUsageId = requestId;
  parser.usageVersion += 1;
  parser.persistDirty = true;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function processEditActivityEntry(parser, entry) {
  if (!entry || typeof entry !== 'object') return;
  const expectedSessionId = path.basename(parser.path, JSONL_SUFFIX);
  if (entry.sessionId && entry.sessionId !== expectedSessionId) return;
  const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
  if (!blocks.length) return;

  if (entry.type === 'assistant') {
    const assistantUuid = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : '';
    for (const block of blocks) {
      if (!block || block.type !== 'tool_use') continue;
      const summaryItem = changeReviewSummaryFromToolUse(block, entry.timestamp || '');
      if (summaryItem && summaryItem.id) {
        if (!parser.changeReviewPendingSummaries) parser.changeReviewPendingSummaries = new Map();
        summaryItem.turnKey = parser.changeReviewCurrentTurnKey || null;
        summaryItem.assistantUuid = assistantUuid || null;
        if (assistantUuid && summaryItem.turnKey) parser.changeReviewAssistantTurns.set(assistantUuid, summaryItem.turnKey);
        parser.changeReviewPendingSummaries.set(summaryItem.id, summaryItem);
        parser.persistDirty = true;
        continue;
      }
      const item = editActivityFromToolUse(block, entry.timestamp || '');
      if (!item || !item.id) continue;
      item.turnKey = parser.changeReviewCurrentTurnKey || null;
      item.assistantUuid = assistantUuid || null;
      if (assistantUuid && item.turnKey) parser.changeReviewAssistantTurns.set(assistantUuid, item.turnKey);
      if (parser.editCounted.has(item.id)) continue;
      parser.editPending.set(item.id, item);
      parser.persistDirty = true;
    }
    return;
  }

  if (entry.type !== 'user') return;
  for (const block of blocks) {
    if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const item = parser.editPending.get(block.tool_use_id);
    if (item) {
      parser.editPending.delete(block.tool_use_id);
      parser.persistDirty = true;
      if (toolResultIsError(block)) continue;
      countEditActivity(parser, item);
      countChangeReviewTool(parser, item);
      continue;
    }
    const summaryItem = parser.changeReviewPendingSummaries &&
      parser.changeReviewPendingSummaries.get(block.tool_use_id);
    if (!summaryItem) continue;
    parser.changeReviewPendingSummaries.delete(block.tool_use_id);
    parser.persistDirty = true;
    if (toolResultIsError(block) || !toolUseResultSucceeded(entry.toolUseResult)) continue;
    countChangeReviewSummaryTool(parser, summaryItem, entry.toolUseResult);
  }
}

function toolResultIsError(block) {
  return block && block.is_error === true;
}

function toolUseResultSucceeded(result) {
  if (!result || typeof result !== 'object') return true;
  const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
  return !status || status === 'completed' || status === 'success' || status === 'succeeded';
}

function processChangeReviewEntry(parser, entry) {
  if (!entry || typeof entry !== 'object') return;
  const expectedSessionId = path.basename(parser.path, JSONL_SUFFIX);
  if (entry.sessionId && entry.sessionId !== expectedSessionId) return;

  if (isRealUserPromptEntry(entry)) {
    parser.changeReviewCurrentTurnKey = entry.uuid;
    ensureChangeReviewTurn(parser, entry.uuid, {
      timestamp: entry.timestamp || '',
      cwd: parser.projectCwd || entry.cwd || '',
    });
    return;
  }

  if (entry.type !== 'file-history-snapshot') return;
  const snapshot = entry.snapshot && typeof entry.snapshot === 'object' ? entry.snapshot : null;
  if (!snapshot || !snapshot.trackedFileBackups || typeof snapshot.trackedFileBackups !== 'object') return;
  // Plain snapshots are the host's baseline file-history state for a user
  // prompt. They include files changed by earlier turns, so they must never
  // create a "this turn changed files" review row. Only successful
  // Write/Edit/MultiEdit tool results create rows. The baseline snapshot can
  // still provide the pre-turn backup for a later Edit of an already-tracked
  // file, so cache it by turn and apply it only after a real tool row appears.
  if (entry.isSnapshotUpdate !== true) {
    const turnKey = typeof entry.messageId === 'string' && entry.messageId
      ? entry.messageId
      : '';
    if (turnKey) {
      const meta = {
        timestamp: snapshot.timestamp || entry.timestamp || '',
        cwd: parser.projectCwd || entry.cwd || '',
      };
      for (const [rawPath, backup] of Object.entries(snapshot.trackedFileBackups || {})) {
        if (!rawPath || !backup || typeof backup !== 'object') continue;
        rememberChangeReviewTurnBaseline(parser, turnKey, rawPath, {
          backupFileName: Object.prototype.hasOwnProperty.call(backup, 'backupFileName')
            ? backup.backupFileName
            : undefined,
          version: Number.isFinite(backup.version) ? backup.version : null,
          backupTime: typeof backup.backupTime === 'string' ? backup.backupTime : '',
        }, meta);
      }
    }
    return;
  }
  const assistantUuid = typeof entry.messageId === 'string' && entry.messageId
    ? entry.messageId
    : '';
  if (!assistantUuid) return;
  const meta = {
    timestamp: snapshot.timestamp || entry.timestamp || '',
    cwd: parser.projectCwd || entry.cwd || '',
  };
  for (const [rawPath, backup] of Object.entries(snapshot.trackedFileBackups || {})) {
    if (!rawPath || !backup || typeof backup !== 'object') continue;
    rememberChangeReviewSnapshotUpdate(parser, assistantUuid, rawPath, {
      backupFileName: Object.prototype.hasOwnProperty.call(backup, 'backupFileName')
        ? backup.backupFileName
        : undefined,
      version: Number.isFinite(backup.version) ? backup.version : null,
      backupTime: typeof backup.backupTime === 'string' ? backup.backupTime : '',
    }, meta);
  }
}

function changeReviewToolItemForSnapshotFile(parser, assistantUuid, rawPath, cwd) {
  if (!assistantUuid || !parser) return null;
  const visit = item => {
    if (!item || item.assistantUuid !== assistantUuid || !item.turnKey || !item.filePath) return null;
    const turn = parser.changeReviewTurns && parser.changeReviewTurns.get(item.turnKey);
    const base = (turn && turn.cwd) || cwd || parser.projectCwd;
    const snapshotPath = resolveChangeReviewPath(rawPath, base);
    const itemPath = resolveChangeReviewPath(item.filePath, base);
    if (!snapshotPath || !itemPath || changeReviewFileKey(itemPath) !== changeReviewFileKey(snapshotPath)) return null;
    return item;
  };
  for (const item of parser.editPending.values()) {
    const match = visit(item);
    if (match) return match;
  }
  for (const item of parser.editCounted.values()) {
    const match = visit(item);
    if (match) return match;
  }
  return null;
}

function changeReviewAssistantHasFileTools(parser, assistantUuid) {
  if (!assistantUuid || !parser) return false;
  for (const item of parser.editPending.values()) {
    if (item && item.assistantUuid === assistantUuid && item.filePath) return true;
  }
  for (const item of parser.editCounted.values()) {
    if (item && item.assistantUuid === assistantUuid && item.filePath) return true;
  }
  return false;
}

function changeReviewSnapshotUpdateKey(update) {
  return changeReviewFileKey(update && update.filePath ? update.filePath : '');
}

function changeReviewTurnBaselineKey(update) {
  return changeReviewSnapshotUpdateKey(update) || String(update && update.rawPath || '');
}

function makeChangeReviewSnapshotUpdate(parser, rawPath, patch, meta) {
  const cwd = (meta && meta.cwd) || parser.projectCwd || '';
  const filePath = resolveChangeReviewPath(rawPath, cwd) || '';
  const out = {
    rawPath,
    filePath,
    cwd,
    timestamp: (meta && meta.timestamp) || '',
    version: Number.isFinite(patch && patch.version) ? patch.version : null,
    backupTime: typeof (patch && patch.backupTime) === 'string' ? patch.backupTime : '',
  };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'backupFileName')) {
    out.backupFileName = patch.backupFileName === null ? null
      : (typeof patch.backupFileName === 'string' ? patch.backupFileName : undefined);
  }
  return out;
}

function patchChangeReviewFileBackup(file, update) {
  if (!file || !update) return false;
  let changed = false;
  // Keep the first official backup for a turn. Later snapshots may describe an
  // intermediate version; Reject must return to the state before the turn's
  // first successful file edit.
  if (Object.prototype.hasOwnProperty.call(update, 'backupFileName') &&
      file.backupFileName === undefined) {
    file.backupFileName = update.backupFileName === null ? null
      : (typeof update.backupFileName === 'string' ? update.backupFileName : file.backupFileName);
    changed = true;
  }
  if ((file.version === null || file.version === undefined) && Number.isFinite(update.version)) {
    file.version = update.version;
    changed = true;
  }
  if (!file.backupTime && typeof update.backupTime === 'string' && update.backupTime) {
    file.backupTime = update.backupTime;
    changed = true;
  }
  return changed;
}

function applyChangeReviewSnapshotUpdateForToolItem(parser, item, update) {
  if (!parser || !item || !item.turnKey || !update) return false;
  const turn = parser.changeReviewTurns && parser.changeReviewTurns.get(item.turnKey);
  if (!turn) return false;
  const base = turn.cwd || update.cwd || parser.projectCwd;
  const snapshotPath = resolveChangeReviewPath(update.rawPath, base);
  const itemPath = resolveChangeReviewPath(item.filePath, base);
  if (!snapshotPath || !itemPath || changeReviewFileKey(snapshotPath) !== changeReviewFileKey(itemPath)) return false;
  const file = turn.files.get(changeReviewFileKey(itemPath));
  if (!file) return false;
  if (patchChangeReviewFileBackup(file, update)) {
    parser.changeReviewVersion += 1;
    parser.persistDirty = true;
  }
  return true;
}

function rememberChangeReviewSnapshotUpdate(parser, assistantUuid, rawPath, patch, meta = {}) {
  if (!parser || !assistantUuid || !rawPath) return false;
  const toolItem = changeReviewToolItemForSnapshotFile(parser, assistantUuid, rawPath, meta.cwd);
  if (toolItem && applyChangeReviewSnapshotUpdateForToolItem(
    parser,
    toolItem,
    makeChangeReviewSnapshotUpdate(parser, rawPath, patch, meta)
  )) {
    return true;
  }
  // Once this assistant's file tools are known, unmatched snapshot paths are
  // just carried-over file-history state. Do not cache them for a future turn.
  if (!toolItem && changeReviewAssistantHasFileTools(parser, assistantUuid)) return false;

  const update = makeChangeReviewSnapshotUpdate(parser, rawPath, patch, meta);
  const key = changeReviewSnapshotUpdateKey(update) || String(rawPath);
  const list = parser.changeReviewSnapshotUpdates.get(assistantUuid) || [];
  const idx = list.findIndex(item => (changeReviewSnapshotUpdateKey(item) || item.rawPath) === key);
  if (idx === -1) list.push(update);
  else if (!Object.prototype.hasOwnProperty.call(list[idx], 'backupFileName') &&
      Object.prototype.hasOwnProperty.call(update, 'backupFileName')) {
    list[idx] = update;
  }
  parser.changeReviewSnapshotUpdates.set(assistantUuid, list);
  parser.persistDirty = true;
  return true;
}

function rememberChangeReviewTurnBaseline(parser, turnKey, rawPath, patch, meta = {}) {
  if (!parser || !turnKey || !rawPath) return false;
  const update = makeChangeReviewSnapshotUpdate(parser, rawPath, patch, meta);
  const key = changeReviewTurnBaselineKey(update);
  if (!key) return false;
  let baselines = parser.changeReviewTurnBaselines.get(turnKey);
  if (!(baselines instanceof Map)) {
    baselines = new Map();
    parser.changeReviewTurnBaselines.set(turnKey, baselines);
  }
  const existing = baselines.get(key);
  if (!existing ||
      (!Object.prototype.hasOwnProperty.call(existing, 'backupFileName') &&
        Object.prototype.hasOwnProperty.call(update, 'backupFileName'))) {
    baselines.set(key, update);
    parser.persistDirty = true;
  }

  const turn = parser.changeReviewTurns && parser.changeReviewTurns.get(turnKey);
  if (turn && turn.files) {
    for (const file of turn.files.values()) {
      if (!file || changeReviewFileKey(file.filePath) !== key) continue;
      if (applyChangeReviewTurnBaselineToFile(parser, turn, file)) return true;
    }
  }
  return true;
}

function applyChangeReviewTurnBaselineToFile(parser, turn, file) {
  if (!parser || !turn || !file || file.backupFileName !== undefined) return false;
  const baselines = parser.changeReviewTurnBaselines && parser.changeReviewTurnBaselines.get(turn.turnKey);
  if (!(baselines instanceof Map)) return false;
  const key = changeReviewFileKey(file.filePath);
  const update = key ? baselines.get(key) : null;
  if (!update || !Object.prototype.hasOwnProperty.call(update, 'backupFileName')) return false;
  if (!patchChangeReviewFileBackup(file, update)) return false;
  parser.changeReviewVersion += 1;
  parser.persistDirty = true;
  return true;
}

function repairChangeReviewFileBackupFromBaseline(parser, file) {
  if (!parser || !file || file.backupFileName !== undefined || !file.turnKey) return false;
  const turn = parser.changeReviewTurns && parser.changeReviewTurns.get(file.turnKey);
  if (turn && applyChangeReviewTurnBaselineToFile(parser, turn, file)) return true;

  // Back-compat for usage-cache parsers created before turn baselines were
  // serialized: rescan only this transcript's plain baseline snapshot for the
  // requested turn. It still does not create review rows.
  if (!parser.path || !fs.existsSync(parser.path)) return false;
  let changed = false;
  try {
    const lines = fs.readFileSync(parser.path, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const entry = parseJsonLine(line);
      if (!entry || entry.type !== 'file-history-snapshot' ||
          entry.isSnapshotUpdate === true ||
          entry.messageId !== file.turnKey) continue;
      const snapshot = entry.snapshot && typeof entry.snapshot === 'object' ? entry.snapshot : null;
      const backups = snapshot && snapshot.trackedFileBackups && typeof snapshot.trackedFileBackups === 'object'
        ? snapshot.trackedFileBackups
        : null;
      if (!backups) continue;
      const meta = {
        timestamp: snapshot.timestamp || entry.timestamp || '',
        cwd: parser.projectCwd || entry.cwd || '',
      };
      for (const [rawPath, backup] of Object.entries(backups)) {
        if (!rawPath || !backup || typeof backup !== 'object') continue;
        rememberChangeReviewTurnBaseline(parser, file.turnKey, rawPath, {
          backupFileName: Object.prototype.hasOwnProperty.call(backup, 'backupFileName')
            ? backup.backupFileName
            : undefined,
          version: Number.isFinite(backup.version) ? backup.version : null,
          backupTime: typeof backup.backupTime === 'string' ? backup.backupTime : '',
        }, meta);
      }
      changed = file.backupFileName !== undefined;
      if (changed) break;
    }
  } catch (_) {
    return false;
  }
  return changed;
}

function consumeChangeReviewSnapshotUpdatesForItem(parser, item) {
  if (!parser || !item || !item.assistantUuid) return;
  const list = parser.changeReviewSnapshotUpdates.get(item.assistantUuid);
  if (!Array.isArray(list) || !list.length) return;
  const keep = [];
  for (const update of list) {
    if (!applyChangeReviewSnapshotUpdateForToolItem(parser, item, update)) keep.push(update);
  }
  const stillRelevant = keep.filter(update =>
    changeReviewToolItemForSnapshotFile(
      parser,
      item.assistantUuid,
      update.rawPath,
      update.cwd || parser.projectCwd
    )
  );
  if (stillRelevant.length) parser.changeReviewSnapshotUpdates.set(item.assistantUuid, stillRelevant);
  else parser.changeReviewSnapshotUpdates.delete(item.assistantUuid);
  parser.persistDirty = true;
}

function isRealUserPromptEntry(entry) {
  if (!entry || entry.type !== 'user' || typeof entry.uuid !== 'string' || !entry.uuid) return false;
  const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
  if (!blocks.length) return true;
  return !blocks.some(block => block && block.type === 'tool_result');
}

function ensureChangeReviewTurn(parser, turnKey, meta = {}) {
  let turn = parser.changeReviewTurns.get(turnKey);
  if (!turn) {
    turn = {
      id: turnKey,
      turnKey,
      sessionId: path.basename(parser.path, JSONL_SUFFIX),
      cwd: meta.cwd || parser.projectCwd || '',
      timestamp: meta.timestamp || '',
      files: new Map(),
      summary: null,
      order: parser.changeReviewTurns.size,
    };
    parser.changeReviewTurns.set(turnKey, turn);
    parser.changeReviewVersion += 1;
  } else {
    if (!turn.cwd && (meta.cwd || parser.projectCwd)) turn.cwd = meta.cwd || parser.projectCwd || '';
    if (!turn.timestamp && meta.timestamp) turn.timestamp = meta.timestamp;
  }
  return turn;
}

function changeReviewFileKey(filePath) {
  if (!filePath) return '';
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function changeReviewEntryId(sessionId, turnKey, filePath) {
  const key = changeReviewFileKey(filePath);
  return crypto.createHash('sha256')
    .update(String(sessionId || ''))
    .update('\0')
    .update(String(turnKey || ''))
    .update('\0')
    .update(key)
    .digest('hex')
    .slice(0, 32);
}

function isAbsoluteAnyPlatform(value) {
  const raw = String(value || '');
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
}

function resolveChangeReviewPath(rawPath, cwd) {
  const raw = expandHomePath(String(rawPath || '').trim());
  if (!raw) return null;
  if (isAbsoluteAnyPlatform(raw)) return path.resolve(raw);
  const base = normalizeWorkspaceCwd(cwd);
  if (!base) return null;
  return path.resolve(base, raw);
}

function displayChangeReviewPath(filePath, cwd, rawPath) {
  const rel = relativePathFromWorkspaceRoot(cwd, filePath);
  if (rel) return rel;
  return rawPath || filePath || '';
}

function upsertChangeReviewFile(parser, turn, rawPath, patch = {}) {
  const resolved = resolveChangeReviewPath(rawPath, turn.cwd || parser.projectCwd);
  if (!resolved) return null;
  const key = changeReviewFileKey(resolved);
  let file = turn.files.get(key);
  if (!file) {
    file = {
      id: changeReviewEntryId(turn.sessionId, turn.turnKey, resolved),
      sessionId: turn.sessionId,
      turnKey: turn.turnKey,
      rawPath,
      filePath: resolved,
      displayPath: displayChangeReviewPath(resolved, turn.cwd || parser.projectCwd, rawPath),
      backupFileName: undefined,
      version: null,
      backupTime: '',
      added: 0,
      removed: 0,
      hasLineStats: false,
      tool: '',
      toolIds: new Set(),
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    turn.files.set(key, file);
  } else if (Number.isFinite(turn.lifecycleStartedAt) &&
      turn.lifecycleStartedAt > 0 &&
      Number.isFinite(file.lastSeenAt) &&
      file.lastSeenAt < turn.lifecycleStartedAt) {
    file.rawPath = rawPath;
    file.filePath = resolved;
    file.displayPath = displayChangeReviewPath(resolved, turn.cwd || parser.projectCwd, rawPath);
    file.backupFileName = undefined;
    file.version = null;
    file.backupTime = '';
    file.added = 0;
    file.removed = 0;
    file.hasLineStats = false;
    file.tool = '';
    file.toolIds = new Set();
    file.firstSeenAt = Date.now();
  }
  file.rawPath = file.rawPath || rawPath;
  file.filePath = resolved;
  file.displayPath = displayChangeReviewPath(resolved, turn.cwd || parser.projectCwd, rawPath);
  if (Object.prototype.hasOwnProperty.call(patch, 'backupFileName') &&
      file.backupFileName === undefined) {
    file.backupFileName = patch.backupFileName === null ? null
      : (typeof patch.backupFileName === 'string' ? patch.backupFileName : file.backupFileName);
  }
  if ((file.version === null || file.version === undefined) && Number.isFinite(patch.version)) file.version = patch.version;
  if (!file.backupTime && typeof patch.backupTime === 'string' && patch.backupTime) file.backupTime = patch.backupTime;
  if (Number.isFinite(patch.added)) file.added += Math.max(0, patch.added);
  if (Number.isFinite(patch.removed)) file.removed += Math.max(0, patch.removed);
  // Record the editing tool name (Write/Edit/MultiEdit) so the reject reminder
  // can describe each file by tool. A file touched by several tools in one turn
  // keeps the last one — the reminder only needs a representative verb.
  if (typeof patch.tool === 'string' && patch.tool) file.tool = patch.tool;
  if (patch.toolId) {
    file.toolIds.add(patch.toolId);
    file.hasLineStats = true;
  }
  file.lastSeenAt = Date.now();
  return file;
}

function countChangeReviewTool(parser, item) {
  if (!item || !item.turnKey || !item.filePath) return;
  if (item.assistantUuid) parser.changeReviewAssistantTurns.set(item.assistantUuid, item.turnKey);
  const turn = ensureChangeReviewTurn(parser, item.turnKey, { timestamp: item.ts || '' });
  const resolved = resolveChangeReviewPath(item.filePath, turn.cwd || parser.projectCwd);
  const key = resolved ? changeReviewFileKey(resolved) : '';
  const existing = key ? turn.files.get(key) : null;
  if (changeReviewItemBeforeLifecycle(turn, item, existing)) return;
  const file = upsertChangeReviewFile(parser, turn, item.filePath, {
    added: item.added || 0,
    removed: item.removed || 0,
    tool: typeof item.name === 'string' ? item.name : '',
    toolId: item.id,
  });
  if (file) {
    applyChangeReviewTurnBaselineToFile(parser, turn, file);
    parser.changeReviewVersion += 1;
    parser.persistDirty = true;
    consumeChangeReviewSnapshotUpdatesForItem(parser, item);
  }
}

function changeReviewSummaryFromToolUse(block, ts) {
  if (!block || typeof block.id !== 'string' || block.name !== 'Agent') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const agentType = typeof input.subagent_type === 'string' && input.subagent_type
    ? input.subagent_type
    : '';
  return {
    id: block.id,
    name: block.name,
    source: 'subagent',
    sourceLabel: 'Sub-agent',
    agentTypes: agentType ? [agentType] : [],
    ts: ts || '',
    turnKey: null,
    assistantUuid: null,
  };
}

function safeToolStatCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function hasFiniteToolStat(stats, key) {
  return !!(stats && Object.prototype.hasOwnProperty.call(stats, key) &&
    Number.isFinite(Number(stats[key])));
}

function changeReviewSummaryStatsFromToolUseResult(result) {
  const stats = result && typeof result === 'object' &&
    result.toolStats && typeof result.toolStats === 'object'
    ? result.toolStats
    : null;
  const files = safeToolStatCount(stats && stats.editFileCount);
  if (!files) return null;
  const hasLineStats = hasFiniteToolStat(stats, 'linesAdded') || hasFiniteToolStat(stats, 'linesRemoved');
  return {
    files,
    added: hasLineStats ? safeTokenNumber(Number(stats.linesAdded)) : 0,
    removed: hasLineStats ? safeTokenNumber(Number(stats.linesRemoved)) : 0,
    hasLineStats,
  };
}

function changeReviewSummaryBeforeLifecycle(turn, item) {
  const startedAt = turn && Number.isFinite(turn.lifecycleStartedAt) ? turn.lifecycleStartedAt : 0;
  if (!startedAt || !item) return false;
  const summary = turn.summary;
  if (summary &&
      summary.toolIds instanceof Set &&
      typeof item.id === 'string' &&
      summary.toolIds.has(item.id)) {
    return true;
  }
  const itemMs = timestampMs(item.ts);
  return !!(itemMs && itemMs + 1000 < startedAt);
}

function countChangeReviewSummaryTool(parser, item, result) {
  if (!item || !item.turnKey) return;
  const stats = changeReviewSummaryStatsFromToolUseResult(result);
  if (!stats) return;
  if (item.assistantUuid) parser.changeReviewAssistantTurns.set(item.assistantUuid, item.turnKey);
  const turn = ensureChangeReviewTurn(parser, item.turnKey, { timestamp: item.ts || '' });
  if (changeReviewSummaryBeforeLifecycle(turn, item)) return;
  const startedAt = Number.isFinite(turn.lifecycleStartedAt) ? turn.lifecycleStartedAt : 0;
  if (!turn.summary || (startedAt > 0 &&
      Number.isFinite(turn.summary.lastSeenAt) &&
      turn.summary.lastSeenAt < startedAt)) {
    turn.summary = {
      source: item.source || 'subagent',
      sourceLabel: item.sourceLabel || 'Sub-agent',
      agentTypes: new Set(),
      files: 0,
      added: 0,
      removed: 0,
      hasLineStats: false,
      toolIds: new Set(),
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }
  if (turn.summary.toolIds.has(item.id)) return;
  turn.summary.files += stats.files;
  turn.summary.added += stats.added || 0;
  turn.summary.removed += stats.removed || 0;
  turn.summary.hasLineStats = turn.summary.hasLineStats || stats.hasLineStats === true;
  if (!(turn.summary.agentTypes instanceof Set)) turn.summary.agentTypes = new Set();
  for (const type of (Array.isArray(item.agentTypes) ? item.agentTypes : [])) {
    if (typeof type === 'string' && type) turn.summary.agentTypes.add(type);
  }
  turn.summary.toolIds.add(item.id);
  if (!turn.summary.firstSeenAt) turn.summary.firstSeenAt = Date.now();
  turn.summary.lastSeenAt = Date.now();
  parser.changeReviewVersion += 1;
  parser.persistDirty = true;
}

function editActivityFromToolUse(block, ts) {
  if (!block || typeof block.id !== 'string') return null;
  const name = block.name;
  if (name !== 'Write' && name !== 'Edit' && name !== 'MultiEdit') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : null;
  if (!input) return null;
  const stats = computeEditActivityStats(name, input);
  if (!stats) return null;
  const filePath = typeof input.file_path === 'string' && input.file_path ? input.file_path : '';
  return {
    id: block.id,
    name,
    ts: ts || '',
    day: localDayKey(ts),
    filePath,
    added: stats.added || 0,
    removed: stats.removed || 0,
  };
}

function computeEditActivityStats(name, input) {
  if (name === 'Write') {
    if (typeof input.content !== 'string') return null;
    return { added: countTextLines(input.content), removed: 0 };
  }
  if (name === 'Edit') {
    if (typeof input.old_string !== 'string' && typeof input.new_string !== 'string') return null;
    return lineDiffStats(
      typeof input.old_string === 'string' ? input.old_string : '',
      typeof input.new_string === 'string' ? input.new_string : ''
    );
  }
  if (name === 'MultiEdit') {
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      return lineDiffStats(
        typeof input.old_string === 'string' ? input.old_string : '',
        typeof input.new_string === 'string' ? input.new_string : ''
      );
    }
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let added = 0;
    let removed = 0;
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      if (typeof edit.old_string !== 'string' && typeof edit.new_string !== 'string') continue;
      const stat = lineDiffStats(
        typeof edit.old_string === 'string' ? edit.old_string : '',
        typeof edit.new_string === 'string' ? edit.new_string : ''
      );
      added += stat.added || 0;
      removed += stat.removed || 0;
    }
    return added || removed ? { added, removed } : null;
  }
  return null;
}

function countTextLines(text) {
  return text === '' ? 0 : String(text).split('\n').length;
}

function lineDiffStats(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).split('\n');
  const b = String(newText == null ? '' : newText).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const m = Math.max(0, endA - start + 1);
  const n = Math.max(0, endB - start + 1);
  if (m === 0 && n === 0) return { added: 0, removed: 0 };
  if (m === 0) return { added: n, removed: 0 };
  if (n === 0) return { added: 0, removed: m };
  if (m * n > LINE_DIFF_EXACT_CELL_LIMIT) {
    return lineDiffStatsByCommonMultiset(a, b, start, endA, endB);
  }
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[start + i - 1] === b[start + j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = curr[j - 1] > prev[j] ? curr[j - 1] : prev[j];
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  const lcs = prev[n];
  return { added: n - lcs, removed: m - lcs };
}

function lineDiffStatsByCommonMultiset(a, b, start, endA, endB) {
  const counts = new Map();
  for (let i = start; i <= endA; i++) counts.set(a[i], (counts.get(a[i]) || 0) + 1);
  let common = 0;
  for (let i = start; i <= endB; i++) {
    const count = counts.get(b[i]) || 0;
    if (!count) continue;
    common++;
    if (count === 1) counts.delete(b[i]);
    else counts.set(b[i], count - 1);
  }
  return {
    added: Math.max(0, endB - start + 1 - common),
    removed: Math.max(0, endA - start + 1 - common),
  };
}

function localDayKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  const t = d.getTime();
  const x = Number.isNaN(t) ? new Date() : d;
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function countEditActivity(parser, item) {
  if (!item || !item.id || parser.editCounted.has(item.id)) return;
  parser.editCounted.set(item.id, item);
  parser.editSums.added += item.added || 0;
  parser.editSums.removed += item.removed || 0;
  parser.editSums.edits += 1;
  parser.editVersion += 1;
  parser.persistDirty = true;
  const key = item.day || localDayKey(item.ts);
  let day = parser.editDays.get(key);
  if (!day) {
    day = { day: key, added: 0, removed: 0, edits: 0 };
    parser.editDays.set(key, day);
  }
  day.added += item.added || 0;
  day.removed += item.removed || 0;
  day.edits += 1;
}

function payloadHistoryEntry(parser, id) {
  const { usage, ts } = parser.byRequest.get(id);
  const c = totalContextTokens(usage);
  return {
    ts,
    ctx: c,
    hit: c > 0 ? (usage.cache_read_input_tokens || 0) / c : 0,
    input: usage.input_tokens || 0,
    cw: usage.cache_creation_input_tokens || 0,
    cr: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  };
}

// Aggregate `parser.order` into <= HISTORY_MAX_BUCKETS contiguous,
// non-overlapping buckets that together cover every request exactly
// once (so Σ bucket sums == global sums, exactly). Each bucket also
// keeps min/max/last hit + the lowest point's ctx/ts so the webview can
// redraw a peak-preserving line and the low/latest markers without the
// raw per-request stream. `c === 1` buckets are single requests.
function payloadHistoryBuckets(parser) {
  const ids = parser.order;
  const n = ids.length;
  if (!n) return [];
  const k = Math.min(HISTORY_MAX_BUCKETS, n);
  const out = [];
  for (let b = 0; b < k; b++) {
    const start = Math.floor((b * n) / k);
    const end = Math.floor(((b + 1) * n) / k); // exclusive
    let cnt = 0, f = 0, w = 0, r = 0, o = 0, hs = 0;
    let lo = Infinity, hi = -Infinity, loCtx = 0, loTs = '';
    let lastHit = 0, lastCtx = 0, lastTs = '', firstTs = '';
    for (let i = start; i < end; i++) {
      const rec = parser.byRequest.get(ids[i]);
      if (!rec) continue;
      const u = rec.usage;
      const ctx = totalContextTokens(u);
      const hit = ctx > 0 ? (u.cache_read_input_tokens || 0) / ctx : 0;
      if (!firstTs) firstTs = rec.ts || '';
      cnt += 1;
      f += u.input_tokens || 0;
      w += u.cache_creation_input_tokens || 0;
      r += u.cache_read_input_tokens || 0;
      o += u.output_tokens || 0;
      hs += hit;
      if (hit < lo) { lo = hit; loCtx = ctx; loTs = rec.ts || ''; }
      if (hit > hi) hi = hit;
      lastHit = hit; lastCtx = ctx; lastTs = rec.ts || '';
    }
    if (!cnt) continue;
    out.push({
      c: cnt,
      ts: lastTs,
      t0: firstTs,
      hit: lastHit,
      ctx: lastCtx,
      lo: lo === Infinity ? lastHit : lo,
      loC: loCtx,
      loT: loTs || lastTs,
      hi: hi === -Infinity ? lastHit : hi,
      f, w, r, o,
      hs,
    });
  }
  return out;
}

function buildPayload(parser, includeHistory) {
  if (!parser.order.length) return null;
  const lastId = parser.latestUsageId && parser.byRequest.has(parser.latestUsageId)
    ? parser.latestUsageId
    : parser.order[parser.order.length - 1];
  const lastUsage = parser.byRequest.get(lastId).usage;
  const ctx = totalContextTokens(lastUsage);
  const totalContext = parser.sums.fresh + parser.sums.cw + parser.sums.cr;
  const totals = {
    requests: parser.order.length,
    fresh: parser.sums.fresh,
    cw: parser.sums.cw,
    cr: parser.sums.cr,
    out: parser.sums.out,
    hitOverall: totalContext > 0 ? parser.sums.cr / totalContext : 0,
    durationMs: 0,
  };
  if (parser.order.length >= 2) {
    const firstTs = parser.byRequest.get(parser.order[0]).ts;
    const lastTs  = parser.byRequest.get(lastId).ts;
    const a = Date.parse(firstTs);
    const b = Date.parse(lastTs);
    if (!Number.isNaN(a) && !Number.isNaN(b)) totals.durationMs = b - a;
  }
  const recent = parser.order.slice(-5).map(id => payloadHistoryEntry(parser, id));
  const payload = {
    ctx,
    hit: ctx > 0 ? (lastUsage.cache_read_input_tokens || 0) / ctx : 0,
    input: lastUsage.input_tokens || 0,
    cc: lastUsage.cache_creation_input_tokens || 0,
    cr: lastUsage.cache_read_input_tokens || 0,
    out: lastUsage.output_tokens || 0,
    ts: Date.now(),
    src: parser.path,
    recent,
    totals,
  };
  if (includeHistory) payload.history = payloadHistoryBuckets(parser);
  return payload;
}

function buildEditActivityPayload(parser) {
  if (!parser) return emptyEditActivityPayload(null, null);
  const projectDir = parser.path ? path.dirname(parser.path) : null;
  const projectName = projectDisplayName(projectDir, parser.projectCwd);
  const days = Array.from(parser.editDays.values())
    .sort((a, b) => a.day < b.day ? -1 : (a.day > b.day ? 1 : 0))
    .map(day => ({
      day: day.day,
      added: day.added || 0,
      removed: day.removed || 0,
      edits: day.edits || 0,
    }));
  return {
    empty: parser.editSums.edits <= 0,
    sessionId: path.basename(parser.path, JSONL_SUFFIX),
    src: parser.path,
    cwd: parser.projectCwd || null,
    projectName,
    ts: Date.now(),
    totals: {
      added: parser.editSums.added || 0,
      removed: parser.editSums.removed || 0,
      edits: parser.editSums.edits || 0,
      activeDays: days.length,
    },
    days,
  };
}

function buildChangeReviewPayload(parser, reviewState) {
  if (!parser) return emptyChangeReviewPayload(null, null);
  const turns = Array.from(parser.changeReviewTurns.values())
    .filter(turn => changeReviewTurnHasVisibleChanges(turn, reviewState))
    .filter(turn => isChangeReviewTurnFinalized(reviewState, turn.turnKey))
    .sort((a, b) => a.order - b.order)
    .map(turn => changeReviewTurnPayload(turn, reviewState))
    .filter(changeReviewTurnPayloadHasChanges);
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const totals = turns.reduce((sum, turn) => {
    sum.files += turn.totals && turn.totals.files || 0;
    sum.added += turn.totals && turn.totals.added || 0;
    sum.removed += turn.totals && turn.totals.removed || 0;
    return sum;
  }, { files: 0, added: 0, removed: 0 });
  return {
    empty: turns.length === 0,
    sessionId: path.basename(parser.path, JSONL_SUFFIX),
    src: parser.path,
    cwd: parser.projectCwd || null,
    ts: Date.now(),
    latestTurn,
    turns,
    totals,
  };
}

function changeReviewTurnPayload(turn, reviewState) {
  const files = changeReviewFilesForTurn(turn, reviewState)
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
    .map(file => changeReviewFilePayload(file, reviewState));
  const summary = changeReviewSummaryForTurn(turn, reviewState);
  const totals = files.reduce((sum, file) => {
    sum.files += 1;
    sum.added += file.added || 0;
    sum.removed += file.removed || 0;
    sum.hasLineStats = sum.hasLineStats || file.hasLineStats === true;
    return sum;
  }, { files: 0, added: 0, removed: 0, hasLineStats: false });
  if (summary) {
    totals.files += summary.files || 0;
    totals.added += summary.added || 0;
    totals.removed += summary.removed || 0;
    totals.hasLineStats = totals.hasLineStats || summary.hasLineStats === true;
  }
  return {
    id: turn.turnKey,
    turnKey: turn.turnKey,
    sessionId: turn.sessionId,
    cwd: turn.cwd || null,
    timestamp: turn.timestamp || '',
    summary,
    files,
    totals,
  };
}

function changeReviewTurnPayloadHasChanges(turn) {
  return !!(turn && turn.totals && safeTokenNumber(turn.totals.files) > 0);
}

function changeReviewTurnHasVisibleChanges(turn, reviewState) {
  if (!turn) return false;
  if (changeReviewFilesForTurn(turn, reviewState).length > 0) return true;
  return !!changeReviewSummaryForTurn(turn, reviewState);
}

function changeReviewLifecycleStartedAt(reviewState, turnKey) {
  const entry = reviewState && reviewState.turns && reviewState.turns[turnKey];
  return entry && Number.isFinite(entry.startedAt) ? entry.startedAt : 0;
}

function changeReviewFilesForTurn(turn, reviewState) {
  if (!turn || !turn.files) return [];
  const startedAt = changeReviewLifecycleStartedAt(reviewState, turn.turnKey);
  return Array.from(turn.files.values())
    .filter(file => !startedAt || (Number.isFinite(file.lastSeenAt) && file.lastSeenAt >= startedAt));
}

function changeReviewSummaryForTurn(turn, reviewState) {
  if (!turn || !turn.summary || safeTokenNumber(turn.summary.files) <= 0) return null;
  const startedAt = changeReviewLifecycleStartedAt(reviewState, turn.turnKey);
  if (startedAt &&
      (!Number.isFinite(turn.summary.lastSeenAt) || turn.summary.lastSeenAt < startedAt)) {
    return null;
  }
  return {
    source: typeof turn.summary.source === 'string' && turn.summary.source ? turn.summary.source : 'subagent',
    sourceLabel: typeof turn.summary.sourceLabel === 'string' && turn.summary.sourceLabel ? turn.summary.sourceLabel : 'Sub-agent',
    agentTypes: Array.from(turn.summary.agentTypes instanceof Set ? turn.summary.agentTypes : [])
      .filter(type => typeof type === 'string' && type),
    files: safeTokenNumber(turn.summary.files),
    added: safeTokenNumber(turn.summary.added),
    removed: safeTokenNumber(turn.summary.removed),
    hasLineStats: turn.summary.hasLineStats === true,
  };
}

function changeReviewFilePayload(file, reviewState) {
  const stateEntry = reviewState && reviewState.files ? reviewState.files[file.id] : null;
  const status = stateEntry && typeof stateEntry.status === 'string'
    ? stateEntry.status
    : 'pending';
  const out = {
    id: file.id,
    sessionId: file.sessionId,
    turnKey: file.turnKey,
    filePath: file.filePath,
    displayPath: file.displayPath || file.rawPath || file.filePath,
    hasBackup: typeof file.backupFileName === 'string' && !!file.backupFileName,
    isCreated: file.backupFileName === null,
    version: Number.isFinite(file.version) ? file.version : null,
    backupTime: file.backupTime || '',
    added: file.added || 0,
    removed: file.removed || 0,
    hasLineStats: file.hasLineStats === true,
    tool: typeof file.tool === 'string' ? file.tool : '',
    status,
  };
  if (file.backupFileName !== undefined) out.backupFileName = file.backupFileName;
  return out;
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function changeReviewItemBeforeLifecycle(turn, item, existingFile = null) {
  const startedAt = turn && Number.isFinite(turn.lifecycleStartedAt) ? turn.lifecycleStartedAt : 0;
  if (!startedAt || !item) return false;
  if (existingFile &&
      existingFile.toolIds instanceof Set &&
      typeof item.id === 'string' &&
      existingFile.toolIds.has(item.id)) {
    return true;
  }
  const itemMs = timestampMs(item.ts);
  return !!(itemMs && itemMs + 1000 < startedAt);
}

function changeReviewStatePath(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!safe) throw new Error('Missing change review session id.');
  return path.join(CHANGE_REVIEW_INDEX_DIR, safe + '.json');
}

function loadChangeReviewState(state, sessionId) {
  if (!sessionId) return { schemaVersion: CHANGE_REVIEW_SCHEMA_VERSION, sessionId: null, version: 0, turns: {}, files: {}, dirty: false };
  const cached = state.changeReviewStates.get(sessionId);
  if (cached) return cached;
  let out = null;
  try {
    const filePath = changeReviewStatePath(sessionId);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.schemaVersion === CHANGE_REVIEW_SCHEMA_VERSION && parsed.sessionId === sessionId) {
        out = {
          schemaVersion: CHANGE_REVIEW_SCHEMA_VERSION,
          sessionId,
          version: Number.isFinite(parsed.version) ? parsed.version : 0,
          turns: parsed.turns && typeof parsed.turns === 'object' ? parsed.turns : {},
          files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
          dirty: false,
        };
      }
    }
  } catch (_) {
    out = null;
  }
  if (!out) out = { schemaVersion: CHANGE_REVIEW_SCHEMA_VERSION, sessionId, version: 0, turns: {}, files: {}, dirty: false };
  state.changeReviewStates.set(sessionId, out);
  return out;
}

function markChangeReviewStateDirty(reviewState) {
  if (!reviewState) return;
  reviewState.version = (reviewState.version || 0) + 1;
  reviewState.dirty = true;
}

function saveChangeReviewState(state, reviewState) {
  if (!reviewState || !reviewState.sessionId || !reviewState.dirty) return;
  try {
    fs.mkdirSync(CHANGE_REVIEW_INDEX_DIR, { recursive: true });
    const finalPath = changeReviewStatePath(reviewState.sessionId);
    const tmpPath = finalPath + '.tmp-' + process.pid + '-' + Date.now();
    const serializable = {
      schemaVersion: CHANGE_REVIEW_SCHEMA_VERSION,
      sessionId: reviewState.sessionId,
      version: reviewState.version || 0,
      updatedAt: Date.now(),
      turns: reviewState.turns || {},
      files: reviewState.files || {},
    };
    fs.writeFileSync(tmpPath, JSON.stringify(serializable));
    fs.renameSync(tmpPath, finalPath);
    reviewState.dirty = false;
  } catch (error) {
    if (state && typeof state.log === 'function') {
      state.log(`change review state save skipped: ${error && error.message ? error.message : error}`);
    }
  }
}

function changeReviewTurnStateEntry(reviewState, turnKey) {
  if (!reviewState || !turnKey) return null;
  if (!reviewState.turns || typeof reviewState.turns !== 'object') reviewState.turns = {};
  let entry = reviewState.turns[turnKey];
  if (!entry || typeof entry !== 'object') {
    entry = { finalized: false };
    reviewState.turns[turnKey] = entry;
    markChangeReviewStateDirty(reviewState);
  }
  return entry;
}

function isChangeReviewTurnFinalized(reviewState, turnKey) {
  const entry = reviewState && reviewState.turns && reviewState.turns[turnKey];
  return !!(entry && entry.finalized === true);
}

function markChangeReviewTurnFinalized(reviewState, turnKey) {
  const entry = changeReviewTurnStateEntry(reviewState, turnKey);
  if (!entry) return false;
  if (entry.finalized === true) return false;
  entry.finalized = true;
  entry.finalizedAt = Date.now();
  markChangeReviewStateDirty(reviewState);
  return true;
}

function markChangeReviewTurnStarted(reviewState, turnKey) {
  const entry = changeReviewTurnStateEntry(reviewState, turnKey);
  if (!entry) return false;
  if (entry.finalized !== true) {
    if (!Object.prototype.hasOwnProperty.call(entry, 'startedAt')) {
      entry.startedAt = 0;
      markChangeReviewStateDirty(reviewState);
      return 0;
    }
    return false;
  }
  const previousFinalizedAt = Number.isFinite(entry.finalizedAt) ? entry.finalizedAt : 0;
  entry.finalized = false;
  delete entry.finalizedAt;
  entry.startedAt = previousFinalizedAt || Date.now();
  markChangeReviewStateDirty(reviewState);
  return entry.startedAt;
}

function restoreEmptyChangeReviewTurnStart(reviewState, turn) {
  if (!reviewState || !turn || !turn.turnKey) return false;
  const entry = reviewState.turns && reviewState.turns[turn.turnKey];
  if (!entry || entry.finalized === true || !Object.prototype.hasOwnProperty.call(entry, 'startedAt')) return false;
  if (changeReviewTurnHasVisibleChanges(turn, reviewState)) return false;
  entry.finalized = true;
  entry.finalizedAt = Date.now();
  delete entry.startedAt;
  turn.lifecycleStartedAt = 0;
  markChangeReviewStateDirty(reviewState);
  return true;
}

function changeReviewStateEntry(reviewState, file) {
  if (!reviewState || !file || !file.id) return null;
  let entry = reviewState.files[file.id];
  if (!entry || typeof entry !== 'object') {
    entry = { status: 'pending' };
    reviewState.files[file.id] = entry;
    markChangeReviewStateDirty(reviewState);
  }
  return entry;
}

function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function currentFileGuard(filePath) {
  const lst = fs.lstatSync(filePath);
  if (!lst.isFile() || lst.isSymbolicLink()) {
    return { ok: false, reason: 'not-regular-file' };
  }
  const stat = fs.statSync(filePath);
  return {
    ok: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: hashFileSync(filePath),
  };
}

function guardSignatureForFile(file) {
  return [
    file.sessionId || '',
    file.turnKey || '',
    file.filePath || '',
    file.backupFileName === null ? '<created>' : String(file.backupFileName || ''),
    Number.isFinite(file.version) ? file.version : '',
  ].join('\0');
}

function captureChangeReviewGuards(parser, reviewState, options = {}) {
  if (!parser || !reviewState) return false;
  const onlyTurnKey = typeof options.turnKey === 'string' && options.turnKey ? options.turnKey : '';
  const onlyFinalized = options.onlyFinalized === true;
  const force = options.force === true;
  let parserChanged = false;
  for (const turn of parser.changeReviewTurns.values()) {
    if (onlyTurnKey && turn.turnKey !== onlyTurnKey) continue;
    if (onlyFinalized && !isChangeReviewTurnFinalized(reviewState, turn.turnKey)) continue;
    for (const file of changeReviewFilesForTurn(turn, reviewState)) {
      if (file.backupFileName === undefined &&
          repairChangeReviewFileBackupFromBaseline(parser, file)) {
        parserChanged = true;
      }
      if (file.backupFileName === undefined) continue;
      const entry = changeReviewStateEntry(reviewState, file);
      if (!entry || entry.status === 'rejected') continue;
      const sig = guardSignatureForFile(file);
      if (!force &&
          entry.guard &&
          entry.guard.signature === sig &&
          entry.guard.lineStatsVersion === CHANGE_REVIEW_LINE_STATS_VERSION) continue;
      try {
        const guard = currentFileGuard(file.filePath);
        if (!guard.ok) {
          entry.status = 'unavailable';
          entry.error = guard.reason || 'not available';
        } else {
          const oldAdded = file.added || 0;
          const oldRemoved = file.removed || 0;
          const oldHasLineStats = file.hasLineStats === true;
          if (deriveChangeReviewLineStats(file) &&
              (file.added !== oldAdded ||
               file.removed !== oldRemoved ||
               file.hasLineStats !== oldHasLineStats)) {
            parser.changeReviewVersion += 1;
            parser.persistDirty = true;
            parserChanged = true;
          }
          if (force) {
            entry.status = 'pending';
            delete entry.error;
            delete entry.rejectedAt;
            delete entry.staleAt;
          }
          entry.status = entry.status === 'stale' ? 'stale' : 'pending';
          entry.guard = {
            signature: sig,
            size: guard.size,
            mtimeMs: guard.mtimeMs,
            hash: guard.hash,
            observedAt: Date.now(),
            lineStatsVersion: CHANGE_REVIEW_LINE_STATS_VERSION,
          };
          delete entry.error;
        }
      } catch (error) {
        entry.status = 'unavailable';
        entry.error = error && error.message ? error.message : String(error);
      }
      markChangeReviewStateDirty(reviewState);
    }
  }
  return parserChanged;
}

function changeReviewTextForStats(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > CHANGE_REVIEW_DIFF_MAX_BYTES) return null;
  const bytes = fs.readFileSync(filePath);
  if (bufferLooksBinary(bytes)) return null;
  return bytes.toString('utf8');
}

function setChangeReviewFileLineStats(file, added, removed) {
  file.added = Math.max(0, safeTokenNumber(added));
  file.removed = Math.max(0, safeTokenNumber(removed));
  file.hasLineStats = true;
}

function deriveChangeReviewLineStats(file) {
  if (!file || file.backupFileName === undefined) return false;
  try {
    const currentText = changeReviewTextForStats(file.filePath);
    if (currentText == null) return false;
    if (file.backupFileName === null) {
      setChangeReviewFileLineStats(file, countTextLines(currentText), 0);
      return true;
    }
    const backupPath = changeReviewBackupPath(file);
    if (!fs.existsSync(backupPath)) return false;
    const oldText = changeReviewTextForStats(backupPath);
    if (oldText == null) return false;
    const stats = lineDiffStats(oldText, currentText);
    setChangeReviewFileLineStats(file, stats.added || 0, stats.removed || 0);
    return true;
  } catch (_) {
    return false;
  }
}

function guardMatchesCurrent(filePath, guard) {
  if (!guard || typeof guard !== 'object') return { ok: false, reason: 'missing guard' };
  try {
    const current = currentFileGuard(filePath);
    if (!current.ok) return current;
    if (current.size !== guard.size) return { ok: false, reason: 'file size changed' };
    if (current.mtimeMs !== guard.mtimeMs) return { ok: false, reason: 'file mtime changed' };
    if (current.hash !== guard.hash) return { ok: false, reason: 'file content changed' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) };
  }
}

function markChangeReviewFileStatus(reviewState, file, status, detail = {}) {
  const entry = changeReviewStateEntry(reviewState, file);
  if (!entry) return;
  entry.status = status;
  if (detail.error) entry.error = detail.error;
  else delete entry.error;
  if (status === 'rejected') entry.rejectedAt = Date.now();
  if (status === 'stale') entry.staleAt = Date.now();
  markChangeReviewStateDirty(reviewState);
}

function clearChangeReviewTurnFileState(reviewState, turn) {
  if (!reviewState || !turn || !turn.files || !reviewState.files) return;
  for (const file of turn.files.values()) {
    if (file && file.id && reviewState.files[file.id]) {
      delete reviewState.files[file.id];
      markChangeReviewStateDirty(reviewState);
    }
  }
}

function fileHistoryRootForSession(sessionId) {
  return path.join(os.homedir(), '.claude', 'file-history', sessionId);
}

function changeReviewBackupPath(file) {
  const name = typeof file.backupFileName === 'string' ? file.backupFileName : '';
  if (!name || path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid file history backup name.');
  }
  return path.join(fileHistoryRootForSession(file.sessionId), name);
}

function atomicWriteFileBuffer(filePath, buffer) {
  const tmp = `${filePath}.incipit-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function changeReviewContext(state, comm, message) {
  const identity = revealIdentityForMessage(state, comm, message || {});
  const sessionId = typeof message.sessionId === 'string' && message.sessionId
    ? message.sessionId
    : (identity && identity.sessionId);
  const cwd = typeof message.cwd === 'string' && message.cwd
    ? message.cwd
    : (identity && identity.cwd);
  const target = identity && identity.target
    ? identity.target
    : resolveTargetFromIdentity(sessionId, cwd || null);
  if (!sessionId || !target || !fs.existsSync(target)) throw new Error('Could not resolve this Claude Code session.');
  const stat = fs.statSync(target);
  const parser = updateParser(state, target, stat);
  const reviewState = loadChangeReviewState(state, sessionId);
  const parserChanged = captureChangeReviewGuards(parser, reviewState, { onlyFinalized: true });
  if (reviewState.dirty) saveChangeReviewState(state, reviewState);
  if (parserChanged) saveUsageCacheParser(state, parser, stat);
  return { sessionId, cwd, target, stat, parser, reviewState };
}

function resolveChangeReviewTurnKey(parser, turnKey) {
  if (!parser || !turnKey) return turnKey || '';
  const mapped = parser.changeReviewAssistantTurns && parser.changeReviewAssistantTurns.get(turnKey);
  return mapped || turnKey;
}

function findChangeReviewTurn(parser, turnKey) {
  const resolvedTurnKey = resolveChangeReviewTurnKey(parser, turnKey);
  return parser && parser.changeReviewTurns
    ? parser.changeReviewTurns.get(resolvedTurnKey)
    : null;
}

function findChangeReviewFile(parser, fileId) {
  if (!parser || !fileId) return null;
  for (const turn of parser.changeReviewTurns.values()) {
    for (const file of turn.files.values()) {
      if (file.id === fileId) return file;
    }
  }
  return null;
}

function changeReviewFilesForRequest(parser, reviewState, message) {
  if (message.fileId) {
    const file = findChangeReviewFile(parser, message.fileId);
    return file ? [file] : [];
  }
  if (message.turnKey) {
    const turn = findChangeReviewTurn(parser, message.turnKey);
    return turn ? changeReviewFilesForTurn(turn, reviewState) : [];
  }
  return [];
}

function latestChangeReviewTurnWithChanges(parser, reviewState) {
  if (!parser || !parser.changeReviewTurns) return null;
  const turns = Array.from(parser.changeReviewTurns.values())
    .filter(turn => changeReviewTurnHasVisibleChanges(turn, reviewState))
    .sort((a, b) => a.order - b.order);
  return turns.length ? turns[turns.length - 1] : null;
}

function resolveChangeReviewTurnStarted(state, comm, message) {
  const ctx = changeReviewContext(state, comm, message);
  const turnKey = typeof message.turnKey === 'string' && message.turnKey
    ? resolveChangeReviewTurnKey(ctx.parser, message.turnKey)
    : '';
  if (!turnKey) return null;
  if (ctx.parser.changeReviewCurrentTurnKey && turnKey !== ctx.parser.changeReviewCurrentTurnKey) {
    return annotateChangeReviewPayload(
      buildChangeReviewPayload(ctx.parser, ctx.reviewState),
      ctx.sessionId,
      ctx.target
    );
  }
  const startedAt = markChangeReviewTurnStarted(ctx.reviewState, turnKey);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    const turn = findChangeReviewTurn(ctx.parser, turnKey) || ensureChangeReviewTurn(ctx.parser, turnKey, { cwd: ctx.cwd || '' });
    turn.lifecycleStartedAt = startedAt;
    clearChangeReviewTurnFileState(ctx.reviewState, turn);
    ctx.parser.changeReviewVersion += 1;
    ctx.parser.persistDirty = true;
    saveUsageCacheParser(state, ctx.parser, ctx.stat);
  }
  if (ctx.reviewState.dirty) saveChangeReviewState(state, ctx.reviewState);
  return annotateChangeReviewPayload(
    buildChangeReviewPayload(ctx.parser, ctx.reviewState),
    ctx.sessionId,
    ctx.target
  );
}

function resolveChangeReviewTurnFinalized(state, comm, message) {
  const ctx = changeReviewContext(state, comm, message);
  const turnKey = typeof message.turnKey === 'string' && message.turnKey
    ? message.turnKey
    : '';
  let turn = turnKey ? findChangeReviewTurn(ctx.parser, turnKey) : null;
  const hasVisibleChanges = turn ? changeReviewTurnHasVisibleChanges(turn, ctx.reviewState) : false;
  if (turnKey && (!turn || !hasVisibleChanges)) {
    if (turn && turn.turnKey) {
      if (!restoreEmptyChangeReviewTurnStart(ctx.reviewState, turn)) {
        markChangeReviewTurnFinalized(ctx.reviewState, turn.turnKey);
      }
    }
    if (ctx.reviewState.dirty) saveChangeReviewState(state, ctx.reviewState);
    ctx.parser.persistDirty = true;
    saveUsageCacheParser(state, ctx.parser, ctx.stat);
    return annotateChangeReviewPayload(
      buildChangeReviewPayload(ctx.parser, ctx.reviewState),
      ctx.sessionId,
      ctx.target
    );
  }
  if (!turn) turn = latestChangeReviewTurnWithChanges(ctx.parser, ctx.reviewState);
  if (!turn || !turn.turnKey) {
    return annotateChangeReviewPayload(
      buildChangeReviewPayload(ctx.parser, ctx.reviewState),
      ctx.sessionId,
      ctx.target
    );
  }
  markChangeReviewTurnFinalized(ctx.reviewState, turn.turnKey);
  captureChangeReviewGuards(ctx.parser, ctx.reviewState, { turnKey: turn.turnKey, force: true });
  if (ctx.reviewState.dirty) saveChangeReviewState(state, ctx.reviewState);
  ctx.parser.persistDirty = true;
  saveUsageCacheParser(state, ctx.parser, ctx.stat);
  return annotateChangeReviewPayload(
    buildChangeReviewPayload(ctx.parser, ctx.reviewState),
    ctx.sessionId,
    ctx.target
  );
}

function rejectOneChangeReviewFile(reviewState, file) {
  const stateEntry = changeReviewStateEntry(reviewState, file);
  if (stateEntry && stateEntry.status === 'rejected') {
    return { id: file.id, ok: true, status: 'rejected', skipped: true };
  }
  if (file.backupFileName === undefined) {
    markChangeReviewFileStatus(reviewState, file, 'unavailable', { error: 'No file history snapshot is available yet.' });
    return { id: file.id, ok: false, status: 'unavailable', error: 'No file history snapshot is available yet.' };
  }
  const guardCheck = guardMatchesCurrent(file.filePath, stateEntry && stateEntry.guard);
  if (!guardCheck.ok) {
    markChangeReviewFileStatus(reviewState, file, 'stale', { error: guardCheck.reason || 'file changed' });
    return { id: file.id, ok: false, status: 'stale', error: guardCheck.reason || 'file changed' };
  }
  try {
    if (file.backupFileName === null) {
      const lst = fs.lstatSync(file.filePath);
      if (!lst.isFile() || lst.isSymbolicLink()) throw new Error('Refusing to delete a non-regular file.');
      fs.unlinkSync(file.filePath);
    } else {
      const backupPath = changeReviewBackupPath(file);
      if (!fs.existsSync(backupPath)) throw new Error('Claude file-history backup is missing.');
      const bytes = fs.readFileSync(backupPath);
      atomicWriteFileBuffer(file.filePath, bytes);
    }
    markChangeReviewFileStatus(reviewState, file, 'rejected');
    return { id: file.id, ok: true, status: 'rejected' };
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    markChangeReviewFileStatus(reviewState, file, 'stale', { error: msg });
    return { id: file.id, ok: false, status: 'stale', error: msg };
  }
}

function resolveChangeReviewReject(state, comm, message) {
  if (message.busy === true) throw new Error('Wait for the current reply to finish before rejecting file changes.');
  const ctx = changeReviewContext(state, comm, message);
  const files = changeReviewFilesForRequest(ctx.parser, ctx.reviewState, message);
  if (!files.length) throw new Error('No matching file changes were found.');
  for (const file of files) repairChangeReviewFileBackupFromBaseline(ctx.parser, file);
  if (ctx.parser.persistDirty) saveUsageCacheParser(state, ctx.parser, ctx.stat);
  const results = files.map(file => rejectOneChangeReviewFile(ctx.reviewState, file));
  if (ctx.reviewState.dirty) saveChangeReviewState(state, ctx.reviewState);
  const ok = results.every(item => item.ok);
  const payload = annotateChangeReviewPayload(
    buildChangeReviewPayload(ctx.parser, ctx.reviewState),
    ctx.sessionId,
    ctx.target
  );
  return { ok, results, payload };
}

function bufferLooksBinary(buffer) {
  if (!buffer || !buffer.length) return false;
  const len = Math.min(buffer.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function readReviewTextFile(filePath, role) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${role} is not a regular file.`);
  if (stat.size > CHANGE_REVIEW_DIFF_MAX_BYTES) {
    throw new Error(`${role} is too large for inline review.`);
  }
  const bytes = fs.readFileSync(filePath);
  if (bufferLooksBinary(bytes)) throw new Error(`${role} appears to be binary.`);
  return bytes.toString('utf8');
}

function changeReviewDiffLines(text) {
  return text === '' ? [] : String(text).split('\n');
}

function changeReviewDiffGapRow() {
  return { kind: 'gap', oldLine: null, newLine: null, text: '...' };
}

// Longest non-crossing chain of lines that occur EXACTLY ONCE in both regions
// (patience-diff anchors). Returns [{oi, nj}] sorted ascending on both indices.
function changeReviewAnchorChain(oldLines, newLines, oStart, oEnd, nStart, nEnd) {
  const oldCount = new Map();
  const newCount = new Map();
  const newIndex = new Map();
  for (let i = oStart; i < oEnd; i++) {
    const t = oldLines[i];
    oldCount.set(t, (oldCount.get(t) || 0) + 1);
  }
  for (let j = nStart; j < nEnd; j++) {
    const t = newLines[j];
    newCount.set(t, (newCount.get(t) || 0) + 1);
    newIndex.set(t, j);
  }
  const pts = [];
  for (let i = oStart; i < oEnd; i++) {
    const t = oldLines[i];
    if (oldCount.get(t) === 1 && newCount.get(t) === 1) {
      pts.push({ oi: i, nj: newIndex.get(t) });
    }
  }
  if (!pts.length) return [];
  // LIS on nj (pts already ascending on oi) -> non-crossing matching.
  const prev = new Array(pts.length).fill(-1);
  const tailIdx = [];
  for (let k = 0; k < pts.length; k++) {
    const nj = pts[k].nj;
    let lo = 0;
    let hi = tailIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[tailIdx[mid]].nj < nj) lo = mid + 1;
      else hi = mid;
    }
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
    if (lo === tailIdx.length) tailIdx.push(k);
    else tailIdx[lo] = k;
  }
  const chain = [];
  let k = tailIdx[tailIdx.length - 1];
  while (k !== -1) {
    chain.push(pts[k]);
    k = prev[k];
  }
  chain.reverse();
  return chain;
}

// Last-resort alignment for a region with no unique common anchors. Uses the
// exact O(m*n) LCS only while the cell budget allows; otherwise marks the region
// as a full delete+add. After anchoring, such regions are small in practice.
function pushChangeReviewLcsRows(rows, oldLines, newLines, oStart, oEnd, nStart, nEnd) {
  const m = oEnd - oStart;
  const n = nEnd - nStart;
  if (m && n && m * n <= CHANGE_REVIEW_DIFF_EXACT_CELL_LIMIT) {
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = oldLines[oStart + i] === newLines[nStart + j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldLines[oStart + i] === newLines[nStart + j]) {
        rows.push({ kind: 'ctx', oldLine: oStart + i + 1, newLine: nStart + j + 1, text: newLines[nStart + j] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        rows.push({ kind: 'del', oldLine: oStart + i + 1, newLine: null, text: oldLines[oStart + i] });
        i++;
      } else {
        rows.push({ kind: 'add', oldLine: null, newLine: nStart + j + 1, text: newLines[nStart + j] });
        j++;
      }
    }
    while (i < m) { rows.push({ kind: 'del', oldLine: oStart + i + 1, newLine: null, text: oldLines[oStart + i] }); i++; }
    while (j < n) { rows.push({ kind: 'add', oldLine: null, newLine: nStart + j + 1, text: newLines[nStart + j] }); j++; }
  } else {
    for (let i = oStart; i < oEnd; i++) rows.push({ kind: 'del', oldLine: i + 1, newLine: null, text: oldLines[i] });
    for (let j = nStart; j < nEnd; j++) rows.push({ kind: 'add', oldLine: null, newLine: j + 1, text: newLines[j] });
  }
}

// Patience-style recursive line diff. Trims common prefix/suffix, then splits on
// unique common anchor lines and recurses into the gaps. This is what keeps a
// tiny edit in a huge file tiny: the unchanged body is all unique lines -> all
// anchors -> context, so the O(m*n) base case only ever sees the changed slivers.
// The old contiguous-suffix-only trim collapsed the whole tail into one O(m*n)
// region whenever the LAST line changed, blew past the cell budget, and degraded
// to a whole-file delete+add (the +N/-M header then disagreed with the body).
function pushChangeReviewLineDiff(rows, oldLines, newLines, oStart, oEnd, nStart, nEnd) {
  while (oStart < oEnd && nStart < nEnd && oldLines[oStart] === newLines[nStart]) {
    rows.push({ kind: 'ctx', oldLine: oStart + 1, newLine: nStart + 1, text: oldLines[oStart] });
    oStart++;
    nStart++;
  }
  const suffix = [];
  while (oEnd > oStart && nEnd > nStart && oldLines[oEnd - 1] === newLines[nEnd - 1]) {
    oEnd--;
    nEnd--;
    suffix.push({ kind: 'ctx', oldLine: oEnd + 1, newLine: nEnd + 1, text: oldLines[oEnd] });
  }

  if (oStart >= oEnd && nStart >= nEnd) {
    // fully reduced
  } else if (oStart >= oEnd) {
    for (let j = nStart; j < nEnd; j++) rows.push({ kind: 'add', oldLine: null, newLine: j + 1, text: newLines[j] });
  } else if (nStart >= nEnd) {
    for (let i = oStart; i < oEnd; i++) rows.push({ kind: 'del', oldLine: i + 1, newLine: null, text: oldLines[i] });
  } else {
    const anchors = changeReviewAnchorChain(oldLines, newLines, oStart, oEnd, nStart, nEnd);
    if (anchors.length) {
      let oi = oStart;
      let nj = nStart;
      for (const a of anchors) {
        pushChangeReviewLineDiff(rows, oldLines, newLines, oi, a.oi, nj, a.nj);
        rows.push({ kind: 'ctx', oldLine: a.oi + 1, newLine: a.nj + 1, text: oldLines[a.oi] });
        oi = a.oi + 1;
        nj = a.nj + 1;
      }
      pushChangeReviewLineDiff(rows, oldLines, newLines, oi, oEnd, nj, nEnd);
    } else {
      pushChangeReviewLcsRows(rows, oldLines, newLines, oStart, oEnd, nStart, nEnd);
    }
  }

  for (let k = suffix.length - 1; k >= 0; k--) rows.push(suffix[k]);
}

function buildChangeReviewFullDiffRows(oldText, newText) {
  const oldLines = changeReviewDiffLines(oldText);
  const newLines = changeReviewDiffLines(newText);
  if (!oldLines.length && !newLines.length) return [];
  if (!oldLines.length) {
    return newLines.map((text, i) => ({ kind: 'add', oldLine: null, newLine: i + 1, text }));
  }
  if (!newLines.length) {
    return oldLines.map((text, i) => ({ kind: 'del', oldLine: i + 1, newLine: null, text }));
  }
  const rows = [];
  pushChangeReviewLineDiff(rows, oldLines, newLines, 0, oldLines.length, 0, newLines.length);
  return rows;
}

function isChangeReviewContextRow(row) {
  return !!row && row.kind === 'ctx';
}

function compactChangeReviewDiffRows(rows) {
  rows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!rows.length) return [];
  const ranges = [];
  let i = 0;
  while (i < rows.length) {
    while (i < rows.length && isChangeReviewContextRow(rows[i])) i++;
    const start = i;
    while (i < rows.length && !isChangeReviewContextRow(rows[i])) i++;
    if (start < i) {
      ranges.push([
        Math.max(0, start - CHANGE_REVIEW_DIFF_CONTEXT_LINES),
        Math.min(rows.length, i + CHANGE_REVIEW_DIFF_CONTEXT_LINES),
      ]);
    }
  }
  if (!ranges.length) return rows.slice(0, Math.min(rows.length, CHANGE_REVIEW_DIFF_CONTEXT_LINES * 2 + 1));

  const merged = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else merged.push(range);
  }

  const out = [];
  let lastEnd = 0;
  for (const range of merged) {
    if (out.length && range[0] > lastEnd) out.push(changeReviewDiffGapRow());
    for (let idx = range[0]; idx < range[1]; idx++) out.push(rows[idx]);
    lastEnd = range[1];
  }
  return trimChangeReviewDiffRows(out);
}

function trimChangeReviewDiffRows(rows) {
  if (!Array.isArray(rows) || rows.length <= CHANGE_REVIEW_DIFF_MAX_RENDER_ROWS) return rows;
  const head = Math.floor((CHANGE_REVIEW_DIFF_MAX_RENDER_ROWS - 1) / 2);
  const tail = CHANGE_REVIEW_DIFF_MAX_RENDER_ROWS - 1 - head;
  return rows.slice(0, head)
    .concat([changeReviewDiffGapRow()])
    .concat(rows.slice(rows.length - tail));
}

function firstChangeReviewLine(rows, key) {
  for (const row of rows || []) {
    const value = row && Number(row[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

function changeReviewRowsText(rows, side) {
  const lines = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (row.kind === 'gap') {
      if (lines.length && lines[lines.length - 1] !== '...') lines.push('...');
      continue;
    }
    if (side === 'old' && row.kind === 'add') continue;
    if (side === 'new' && row.kind === 'del') continue;
    lines.push(typeof row.text === 'string' ? row.text : '');
  }
  return lines.join('\n');
}

function buildChangeReviewDiffPayload(file, oldText, currentText) {
  const rows = compactChangeReviewDiffRows(buildChangeReviewFullDiffRows(oldText, currentText));
  return {
    filePath: file.filePath,
    displayPath: file.displayPath,
    oldText: changeReviewRowsText(rows, 'old'),
    newText: changeReviewRowsText(rows, 'new'),
    oldStartLine: firstChangeReviewLine(rows, 'oldLine'),
    newStartLine: firstChangeReviewLine(rows, 'newLine'),
    rows,
  };
}

function resolveChangeReviewDiff(state, comm, message) {
  const ctx = changeReviewContext(state, comm, message);
  const file = findChangeReviewFile(ctx.parser, message.fileId);
  if (!file) throw new Error('No matching file change was found.');
  repairChangeReviewFileBackupFromBaseline(ctx.parser, file);
  if (ctx.parser.persistDirty) saveUsageCacheParser(state, ctx.parser, ctx.stat);
  if (file.backupFileName === undefined) {
    throw new Error('No file history snapshot is available yet.');
  }
  const currentText = readReviewTextFile(file.filePath, 'Current file');
  let oldText = '';
  if (file.backupFileName !== null) {
    const backupPath = changeReviewBackupPath(file);
    if (!fs.existsSync(backupPath)) throw new Error('Claude file-history backup is missing.');
    oldText = readReviewTextFile(backupPath, 'Backup file');
  }
  return {
    ok: true,
    file: changeReviewFilePayload(file, ctx.reviewState),
    diff: buildChangeReviewDiffPayload(file, oldText, currentText),
  };
}

function buildProjectEditActivityResponse(state, target, comm, sessionId) {
  const indexing = scheduleGlobalIndexJob(state, comm, sessionId);
  return buildEditActivityPopupPayload(state, target, indexing ? 'indexing' : 'ready');
}

function buildEditActivityPopupPayload(state, target, status) {
  const projectDir = target ? path.dirname(target) : null;
  const currentIndex = projectDir ? loadProjectEditActivityIndex(state, projectDir) : null;
  return {
    scope: 'popup',
    status: status || 'ready',
    ts: Date.now(),
    currentProject: currentIndex ? buildProjectEditActivityPayload(currentIndex, 'ready') : null,
    global: buildGlobalEditActivityPayload(loadAllProjectEditActivityIndexes(state), status || 'ready'),
  };
}

function persistProjectEditActivitySession(state, target, parser, stat) {
  if (!target || !parser) return null;
  const payload = buildEditActivityPayload(parser);
  const projectDir = path.dirname(target);
  const index = loadProjectEditActivityIndex(state, projectDir);
  const changed = upsertProjectIndexSession(
    index,
    payload,
    target,
    stat || null,
    parser.editVersion || 0
  );
  if (changed) saveProjectEditActivityIndex(index);
  return index;
}

function projectKeyForDir(projectDir) {
  const normalized = path.resolve(projectDir || '').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

function projectIndexPath(projectKey) {
  return path.join(EDIT_ACTIVITY_INDEX_DIR, projectKey + '.json');
}

function currentLanguage() {
  const cfg = (typeof globalThis !== 'undefined' && globalThis.__incipitConfig) || {};
  return cfg.language === 'zh' ? 'zh' : 'en';
}

function projectDisplayName(projectDir, cwd) {
  if (typeof cwd === 'string' && cwd) {
    const normalized = cwd.replace(/[\\/]+$/, '');
    const base = path.basename(normalized);
    if (base && base !== normalized) return base;
    if (base) return base;
  }
  const dirName = path.basename(projectDir || '');
  return dirName || (currentLanguage() === 'zh' ? '当前项目' : 'Current project');
}

function createProjectEditActivityIndex(projectDir) {
  const projectKey = projectKeyForDir(projectDir);
  return {
    schemaVersion: EDIT_ACTIVITY_SCHEMA_VERSION,
    projectKey,
    projectDir,
    projectName: projectDisplayName(projectDir, null),
    cwd: null,
    updatedAt: Date.now(),
    sessions: {},
  };
}

function loadProjectEditActivityIndex(state, projectDir) {
  const projectKey = projectKeyForDir(projectDir);
  const cached = state.editProjectIndexes.get(projectKey);
  if (cached) return cached;
  const filePath = projectIndexPath(projectKey);
  let index = null;
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.schemaVersion === EDIT_ACTIVITY_SCHEMA_VERSION && parsed.projectKey === projectKey) {
        index = parsed;
      }
    }
  } catch (_) {
    index = null;
  }
  if (!index || typeof index !== 'object') index = createProjectEditActivityIndex(projectDir);
  if (!index.sessions || typeof index.sessions !== 'object') index.sessions = {};
  index.projectDir = projectDir;
  index.projectKey = projectKey;
  if (!index.projectName) index.projectName = projectDisplayName(projectDir, index.cwd || null);
  state.editProjectIndexes.set(projectKey, index);
  return index;
}

function saveProjectEditActivityIndex(index) {
  if (!index || !index.projectKey) return;
  try {
    fs.mkdirSync(EDIT_ACTIVITY_INDEX_DIR, { recursive: true });
    index.updatedAt = Date.now();
    const finalPath = projectIndexPath(index.projectKey);
    const tmpPath = finalPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(index));
    fs.renameSync(tmpPath, finalPath);
  } catch (_) {}
}

// ============================================================
//  Notes (snippets) + reject reminder storage.
//
//  Global notes live in `<NOTES_INDEX_DIR>/global.json`; per-project notes in
//  `<NOTES_INDEX_DIR>/<projectKey>.json` keyed by the same SHA256(cwd) as the
//  edit-activity index. The webview owns CRUD and ships the whole array; the
//  host only sanitizes + atomically writes (tmp+rename), so a crash mid-write
//  never corrupts the live file. `baseDir` is injectable for offline tests.
// ============================================================
function notesFilePath(scope, cwd, baseDir) {
  const dir = baseDir || NOTES_INDEX_DIR;
  if (scope === 'project') {
    if (typeof cwd !== 'string' || !cwd) return null;
    return path.join(dir, projectKeyForDir(cwd) + '.json');
  }
  return path.join(dir, 'global.json');
}

function normalizeNotesScope(scope) {
  return scope === 'project' ? 'project' : 'global';
}

function sanitizeNoteText(value) {
  // Normalize CRLF so a note stored on Windows inserts identically to one
  // stored elsewhere, then cap bytes so a single huge paste can't bloat the file.
  let text = typeof value === 'string' ? value : '';
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (Buffer.byteLength(text, 'utf8') > NOTES_MAX_TEXT_BYTES) {
    text = Buffer.from(text, 'utf8').slice(0, NOTES_MAX_TEXT_BYTES).toString('utf8');
  }
  return text;
}

function sanitizeNoteId(value, fallbackIndex) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  return 'note-' + Date.now().toString(36) + '-' + fallbackIndex.toString(36);
}

function sanitizeNotesList(rawNotes) {
  const list = Array.isArray(rawNotes) ? rawNotes : [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length && out.length < NOTES_MAX_COUNT; i++) {
    const entry = list[i];
    if (!entry || typeof entry !== 'object') continue;
    const text = sanitizeNoteText(entry.text);
    if (!text.trim()) continue;
    let id = sanitizeNoteId(entry.id, i);
    while (seen.has(id)) id = id + '-' + i.toString(36);
    seen.add(id);
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
    out.push({ id, text, createdAt, updatedAt: Date.now() });
  }
  return out;
}

function loadNotes(scope, cwd, baseDir) {
  const filePath = notesFilePath(scope, cwd, baseDir);
  if (!filePath) return [];
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && parsed.schemaVersion === NOTES_SCHEMA_VERSION && Array.isArray(parsed.notes)) {
      return sanitizeNotesList(parsed.notes);
    }
  } catch (_) {}
  return [];
}

function saveNotes(scope, cwd, rawNotes, baseDir) {
  const filePath = notesFilePath(scope, cwd, baseDir);
  if (!filePath) return { ok: false, error: 'Project notes need a workspace path.' };
  const notes = sanitizeNotesList(rawNotes);
  const record = { schemaVersion: NOTES_SCHEMA_VERSION, scope, notes, updatedAt: Date.now() };
  if (scope === 'project') {
    record.projectKey = projectKeyForDir(cwd);
    record.projectDir = cwd;
  }
  try {
    fs.mkdirSync(baseDir || NOTES_INDEX_DIR, { recursive: true });
    const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(record));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
  return { ok: true, notes };
}

function handleNotesLoadRequest(comm, state, message) {
  const requestId = message.requestId;
  const scope = normalizeNotesScope(message.scope);
  const reply = payload => {
    try {
      comm.webview.postMessage({ __incipit: true, type: 'notes_load_response', requestId, payload });
    } catch (_) {}
  };
  try {
    const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : null;
    if (scope === 'project' && !cwd) { reply({ ok: true, scope, notes: [] }); return; }
    reply({ ok: true, scope, notes: loadNotes(scope, cwd) });
  } catch (error) {
    state.log(`notes load error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, scope, error: String(error && error.message ? error.message : error) });
  }
}

function handleNotesSaveRequest(comm, state, message) {
  const requestId = message.requestId;
  const scope = normalizeNotesScope(message.scope);
  const reply = payload => {
    try {
      comm.webview.postMessage({ __incipit: true, type: 'notes_save_response', requestId, payload });
    } catch (_) {}
  };
  try {
    const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : null;
    reply({ scope, ...saveNotes(scope, cwd, message.notes) });
  } catch (error) {
    state.log(`notes save error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, scope, error: String(error && error.message ? error.message : error) });
  }
}

function upsertProjectIndexSession(index, payload, filePath, stat, editVersion) {
  if (!index || !payload || !payload.sessionId) return false;
  const sessionId = payload.sessionId;
  const hasEdits = payload.totals && (payload.totals.edits || 0) > 0;
  if (!hasEdits) {
    if (index.sessions[sessionId]) {
      delete index.sessions[sessionId];
      return true;
    }
    return false;
  }
  const days = {};
  let metaChanged = false;
  if (payload.cwd && index.cwd !== payload.cwd) {
    index.cwd = payload.cwd;
    metaChanged = true;
  }
  if (payload.projectName && index.projectName !== payload.projectName) {
    index.projectName = payload.projectName;
    metaChanged = true;
  }
  const dayRows = Array.isArray(payload.days) ? payload.days : [];
  for (const day of dayRows) {
    if (!day || !day.day) continue;
    days[day.day] = {
      added: day.added || 0,
      removed: day.removed || 0,
      edits: day.edits || 0,
    };
  }
  const next = {
    sessionId,
    src: filePath ? path.basename(filePath) : null,
    cwd: payload.cwd || null,
    projectName: payload.projectName || projectDisplayName(index.projectDir, payload.cwd || index.cwd || null),
    size: stat && Number.isFinite(stat.size) ? stat.size : null,
    mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null,
    editVersion: Number.isFinite(editVersion) ? editVersion : null,
    indexedAt: Date.now(),
    totals: {
      added: payload.totals.added || 0,
      removed: payload.totals.removed || 0,
      edits: payload.totals.edits || 0,
      activeDays: payload.totals.activeDays || Object.keys(days).length,
    },
    days,
  };
  const old = index.sessions[sessionId];
  if (old &&
      old.size === next.size &&
      old.mtimeMs === next.mtimeMs &&
      old.editVersion === next.editVersion &&
      old.totals &&
      old.totals.added === next.totals.added &&
      old.totals.removed === next.totals.removed &&
      old.totals.edits === next.totals.edits) {
    return metaChanged;
  }
  index.sessions[sessionId] = next;
  return true;
}

function projectJsonlFiles(projectDir) {
  let entries = [];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch (_) { return []; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(JSONL_SUFFIX)) continue;
    const filePath = path.join(projectDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      files.push({ filePath, stat, sessionId: path.basename(entry.name, JSONL_SUFFIX) });
    } catch (_) {}
  }
  files.sort((a, b) => (b.stat.mtimeMs || 0) - (a.stat.mtimeMs || 0));
  return files;
}

function claudeProjectDirs() {
  let entries = [];
  try { entries = fs.readdirSync(projectsRoot(), { withFileTypes: true }); } catch (_) { return []; }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsRoot(), entry.name);
    let stat = null;
    try { stat = fs.statSync(dir); } catch (_) {}
    dirs.push({ projectDir: dir, mtimeMs: stat ? stat.mtimeMs : 0 });
  }
  dirs.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return dirs.map(item => item.projectDir);
}

function projectIndexNeedsFile(index, file) {
  if (!index || !file || !file.sessionId) return false;
  const old = index.sessions[file.sessionId];
  if (!old) return true;
  return old.size !== file.stat.size || old.mtimeMs !== file.stat.mtimeMs;
}

function scheduleProjectIndexJob(state, projectDir, comm, sessionId) {
  const index = loadProjectEditActivityIndex(state, projectDir);
  const projectKey = index.projectKey;
  let job = state.editProjectJobs.get(projectKey);
  const now = Date.now();
  const lastScanAt = state.editProjectScanAt.get(projectKey) || 0;
  const shouldScan = !job || now - lastScanAt >= PROJECT_INDEX_SCAN_MIN_INTERVAL_MS;
  const files = shouldScan
    ? projectJsonlFiles(projectDir).filter(file => projectIndexNeedsFile(index, file))
    : [];
  if (shouldScan) state.editProjectScanAt.set(projectKey, now);
  if (!files.length && !job) return false;
  if (!job) {
    job = {
      projectKey,
      projectDir,
      index,
      files,
      cursor: 0,
      subscribers: new Map(),
      scheduled: false,
    };
    state.editProjectJobs.set(projectKey, job);
  } else if (files.length) {
    const seen = new Set(job.files.slice(job.cursor).map(file => file.filePath));
    for (const file of files) {
      if (!seen.has(file.filePath)) job.files.push(file);
    }
  }
  if (comm && sessionId) job.subscribers.set(comm, { comm, sessionId });
  if (!job.scheduled) {
    job.scheduled = true;
    setTimeout(() => runProjectIndexJob(state, projectKey), 0);
  }
  return job.cursor < job.files.length;
}

function loadAllProjectEditActivityIndexes(state) {
  const indexes = new Map();
  for (const index of state.editProjectIndexes.values()) {
    if (index && index.projectKey) indexes.set(index.projectKey, index);
  }
  let entries = [];
  try { entries = fs.readdirSync(EDIT_ACTIVITY_INDEX_DIR, { withFileTypes: true }); } catch (_) { entries = []; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(EDIT_ACTIVITY_INDEX_DIR, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.schemaVersion !== EDIT_ACTIVITY_SCHEMA_VERSION || !parsed.projectKey) continue;
      if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
      state.editProjectIndexes.set(parsed.projectKey, parsed);
      indexes.set(parsed.projectKey, parsed);
    } catch (_) {}
  }
  return Array.from(indexes.values());
}

function scheduleGlobalIndexJob(state, comm, sessionId) {
  let job = state.editGlobalJob;
  if (comm && sessionId && job) job.subscribers.set(comm, { comm, sessionId });
  if (job) return true;

  const now = Date.now();
  if (state.editGlobalScanAt && now - state.editGlobalScanAt < GLOBAL_INDEX_SCAN_MIN_INTERVAL_MS) {
    return false;
  }
  const projectDirs = claudeProjectDirs();
  if (!projectDirs.length) {
    state.editGlobalScanAt = now;
    return false;
  }
  job = {
    projectDirs,
    dirCursor: 0,
    fileQueue: [],
    subscribers: new Map(),
    scheduled: false,
  };
  if (comm && sessionId) job.subscribers.set(comm, { comm, sessionId });
  state.editGlobalJob = job;
  job.scheduled = true;
  setTimeout(() => runGlobalIndexJob(state), 0);
  return true;
}

function runGlobalIndexJob(state) {
  const job = state.editGlobalJob;
  if (!job) return;
  job.scheduled = false;
  let processed = 0;
  let bytes = 0;
  let scannedDirs = 0;
  const changedIndexes = new Set();

  while (processed < PROJECT_INDEX_BATCH_FILES &&
         bytes < PROJECT_INDEX_BATCH_BYTES &&
         (job.fileQueue.length || job.dirCursor < job.projectDirs.length)) {
    if (!job.fileQueue.length) {
      const projectDir = job.projectDirs[job.dirCursor++];
      scannedDirs++;
      const index = loadProjectEditActivityIndex(state, projectDir);
      const files = projectJsonlFiles(projectDir).filter(file => projectIndexNeedsFile(index, file));
      for (const file of files) job.fileQueue.push({ ...file, index });
      if (!job.fileQueue.length && scannedDirs < 4) continue;
      if (!job.fileQueue.length) break;
    }

    const file = job.fileQueue.shift();
    if (!file || !file.index) continue;
    bytes += file.stat.size || 0;
    processed++;
    if (!projectIndexNeedsFile(file.index, file)) continue;
    let payload = null;
    try {
      payload = parseEditActivityFile(file.filePath, file.stat);
    } catch (error) {
      try {
        state.log(`global edit activity index skip ${file.filePath}: ${error && error.message ? error.message : error}`);
      } catch (_) {}
      continue;
    }
    if (upsertProjectIndexSession(file.index, payload, file.filePath, file.stat, null)) {
      changedIndexes.add(file.index);
    }
  }

  for (const index of changedIndexes) saveProjectEditActivityIndex(index);
  const done = !job.fileQueue.length && job.dirCursor >= job.projectDirs.length;
  notifyGlobalIndexSubscribers(state, job, done ? 'ready' : 'indexing');
  if (done) {
    state.editGlobalScanAt = Date.now();
    state.editGlobalJob = null;
    return;
  }
  job.scheduled = true;
  setTimeout(() => runGlobalIndexJob(state), PROJECT_INDEX_BATCH_DELAY_MS);
}

function notifyGlobalIndexSubscribers(state, job, status) {
  for (const [comm, sub] of job.subscribers) {
    if (!state.comms.has(comm)) {
      job.subscribers.delete(comm);
      continue;
    }
    const identity = state.commIdentities.get(comm);
    const target = identity && identity.target
      ? identity.target
      : resolveTargetFromIdentity(sub.sessionId, identity && identity.cwd);
    sendEditActivityPayload(comm, {
      projectOnly: true,
      sessionId: sub.sessionId || null,
      project: buildEditActivityPopupPayload(state, target, status),
    });
  }
}

function runProjectIndexJob(state, projectKey) {
  const job = state.editProjectJobs.get(projectKey);
  if (!job) return;
  job.scheduled = false;
  let processed = 0;
  let bytes = 0;
  let changed = false;
  while (job.cursor < job.files.length &&
         processed < PROJECT_INDEX_BATCH_FILES &&
         bytes < PROJECT_INDEX_BATCH_BYTES) {
    const file = job.files[job.cursor++];
    bytes += file.stat.size || 0;
    processed++;
    if (!projectIndexNeedsFile(job.index, file)) continue;
    let payload = null;
    try {
      payload = parseEditActivityFile(file.filePath, file.stat);
    } catch (error) {
      try {
        state.log(`edit activity index skip ${file.filePath}: ${error && error.message ? error.message : error}`);
      } catch (_) {}
      continue;
    }
    if (upsertProjectIndexSession(job.index, payload, file.filePath, file.stat, null)) changed = true;
  }
  if (changed) saveProjectEditActivityIndex(job.index);
  const done = job.cursor >= job.files.length;
  notifyProjectIndexSubscribers(state, job, done ? 'ready' : 'indexing');
  if (done) {
    state.editProjectJobs.delete(projectKey);
    return;
  }
  job.scheduled = true;
  setTimeout(() => runProjectIndexJob(state, projectKey), PROJECT_INDEX_BATCH_DELAY_MS);
}

function notifyProjectIndexSubscribers(state, job, status) {
  const project = buildProjectEditActivityPayload(job.index, status);
  for (const [comm, sub] of job.subscribers) {
    if (!state.comms.has(comm)) {
      job.subscribers.delete(comm);
      continue;
    }
    sendEditActivityPayload(comm, {
      projectOnly: true,
      sessionId: sub.sessionId || null,
      project,
    });
  }
}

function parseEditActivityFile(filePath, stat) {
  const parser = createParser(filePath, { editOnly: true });
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size || 1)));
    let pos = 0;
    while (pos < stat.size) {
      const len = Math.min(buffer.length, stat.size - pos);
      const read = fs.readSync(fd, buffer, 0, len, pos);
      if (read <= 0) break;
      pos += read;
      appendDecodedText(parser, parser.decoder.write(buffer.subarray(0, read)));
    }
    appendDecodedText(parser, parser.decoder.end());
    const tail = takePartialLine(parser);
    if (tail) processLine(parser, tail);
    parser.size = stat.size;
    parser.mtimeMs = stat.mtimeMs;
    return buildEditActivityPayload(parser);
  } finally {
    fs.closeSync(fd);
  }
}

function buildProjectEditActivityPayload(index, status) {
  const dayMap = new Map();
  let added = 0;
  let removed = 0;
  let edits = 0;
  let sessionCount = 0;
  for (const session of Object.values(index.sessions || {})) {
    if (!session || !session.totals || (session.totals.edits || 0) <= 0) continue;
    sessionCount++;
    added += session.totals.added || 0;
    removed += session.totals.removed || 0;
    edits += session.totals.edits || 0;
    const days = session.days || {};
    for (const [key, day] of Object.entries(days)) {
      if (!key || !day) continue;
      let out = dayMap.get(key);
      if (!out) {
        out = { day: key, added: 0, removed: 0, edits: 0 };
        dayMap.set(key, out);
      }
      out.added += day.added || 0;
      out.removed += day.removed || 0;
      out.edits += day.edits || 0;
    }
  }
  const days = Array.from(dayMap.values())
    .sort((a, b) => a.day < b.day ? -1 : (a.day > b.day ? 1 : 0));
  return {
    empty: edits <= 0,
    scope: 'project',
    status: status || 'ready',
    projectKey: index.projectKey,
    projectDir: index.projectDir,
    cwd: index.cwd || null,
    projectName: index.projectName || projectDisplayName(index.projectDir, index.cwd || null),
    ts: Date.now(),
    totals: {
      added,
      removed,
      edits,
      activeDays: days.length,
      sessions: sessionCount,
    },
    days,
  };
}

function buildGlobalEditActivityPayload(indexes, status) {
  const dayMap = new Map();
  let added = 0;
  let removed = 0;
  let edits = 0;
  let sessionCount = 0;
  let projectCount = 0;
  const list = Array.isArray(indexes) ? indexes : [];
  for (const index of list) {
    if (!index || !index.sessions) continue;
    let projectHasEdits = false;
    for (const session of Object.values(index.sessions || {})) {
      if (!session || !session.totals || (session.totals.edits || 0) <= 0) continue;
      projectHasEdits = true;
      sessionCount++;
      added += session.totals.added || 0;
      removed += session.totals.removed || 0;
      edits += session.totals.edits || 0;
      const days = session.days || {};
      for (const [key, day] of Object.entries(days)) {
        if (!key || !day) continue;
        let out = dayMap.get(key);
        if (!out) {
          out = { day: key, added: 0, removed: 0, edits: 0 };
          dayMap.set(key, out);
        }
        out.added += day.added || 0;
        out.removed += day.removed || 0;
        out.edits += day.edits || 0;
      }
    }
    if (projectHasEdits) projectCount++;
  }
  const days = Array.from(dayMap.values())
    .sort((a, b) => a.day < b.day ? -1 : (a.day > b.day ? 1 : 0));
  return {
    empty: edits <= 0,
    scope: 'global',
    label: 'Claude Code global',
    status: status || 'ready',
    ts: Date.now(),
    totals: {
      added,
      removed,
      edits,
      activeDays: days.length,
      sessions: sessionCount,
      projects: projectCount,
    },
    days,
  };
}

function totalContextTokens(usage) {
  return (
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  );
}

function broadcastTarget(state, target, payload) {
  for (const comm of state.comms) {
    const identity = state.commIdentities.get(comm);
    if (!identity || !identity.sessionId) continue;
    if (identity.target !== target) {
      if (!identity.target) identity.target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      if (identity.target !== target) continue;
    }
    sendPayload(comm, annotateBadgePayload(payload, identity.sessionId, target));
  }
}

function broadcastEditActivityTarget(state, target, payload) {
  for (const comm of state.comms) {
    const identity = state.commIdentities.get(comm);
    if (!identity || !identity.sessionId) continue;
    if (identity.target !== target) {
      if (!identity.target) identity.target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      if (identity.target !== target) continue;
    }
    const conversation = annotateEditActivityPayload(payload, identity.sessionId, target);
    sendEditActivityPayload(comm, editActivityEnvelope(conversation, null));
  }
}

function broadcastChangeReviewTarget(state, target, payload) {
  for (const comm of state.comms) {
    const identity = state.commIdentities.get(comm);
    if (!identity || !identity.sessionId) continue;
    if (identity.target !== target) {
      if (!identity.target) identity.target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      if (identity.target !== target) continue;
    }
    sendChangeReviewPayload(comm, annotateChangeReviewPayload(payload, identity.sessionId, target));
  }
}

function sendChangeReviewTarget(state, target, sessionId) {
  for (const comm of state.comms) {
    const identity = state.commIdentities.get(comm);
    if (!identity || !identity.sessionId) continue;
    if (sessionId && identity.sessionId !== sessionId) continue;
    if (identity.target !== target) {
      if (!identity.target) identity.target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      if (identity.target !== target) continue;
    }
    sendCurrentChangeReviewPayload(state, comm, target, identity.sessionId);
  }
}

function sendPayload(comm, payload) {
  try {
    if (!comm.webview || typeof comm.webview.postMessage !== 'function') {
      throw new Error('[cceBadge] attachComm expected a comm.webview.postMessage()');
    }
    comm.webview.postMessage({ __cceBadge: true, payload });
  } catch (_) {}
}

function sendEditActivityPayload(comm, payload) {
  try {
    if (!comm.webview || typeof comm.webview.postMessage !== 'function') {
      throw new Error('[cceBadge] attachComm expected a comm.webview.postMessage()');
    }
    comm.webview.postMessage({ __incipitEditActivity: true, payload });
  } catch (_) {}
}

function sendChangeReviewPayload(comm, payload) {
  try {
    if (!comm.webview || typeof comm.webview.postMessage !== 'function') {
      throw new Error('[cceBadge] attachComm expected a comm.webview.postMessage()');
    }
    comm.webview.postMessage({ __incipitChangeReview: true, payload });
  } catch (_) {}
}

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

module.exports = { attachComm };

// Pure helpers exposed only for the offline equivalence test
// (tests/cache-history-buckets.test.js). No runtime behaviour change:
// these are referenced, not invoked, by the published code path.
module.exports.__test = {
  createParser,
  processUsageEntry,
  resolveTargetFromIdentity,
  handleBadgeIdentityUpdate,
  handleEditActivityIdentityUpdate,
  payloadHistoryEntry,
  payloadHistoryBuckets,
  totalContextTokens,
  HISTORY_MAX_BUCKETS,
  // Rerun teardown serializer invariants (tests/rerun-handoff.test.js):
  // exercised offline against a temp JSONL, never invoked by the
  // published path through this object.
  readTranscript,
  serializeTranscript,
  atomicWriteTranscript,
  applyUserEdit,
  applyUserBlockEdit,
  applyTruncateFromUser,
  userEditHasDownstreamSignedThinking,
  canEditUserEntry,
  processChangeReviewEntry,
  processEditActivityEntry,
  handleChangeReviewIdentityUpdate,
  buildChangeReviewPayload,
  countChangeReviewTool,
  serializeUsageCacheParser,
  hydrateUsageCacheParser,
  resolveChangeReviewTurnStarted,
  resolveChangeReviewTurnFinalized,
  markChangeReviewTurnStarted,
  markChangeReviewTurnFinalized,
  loadChangeReviewState,
  saveChangeReviewState,
  resolveChangeReviewDiff,
  buildChangeReviewFullDiffRows,
  compactChangeReviewDiffRows,
  resolveChangeReviewReject,
  captureChangeReviewGuards,
  changeReviewEntryId,
  resolveChangeReviewPath,
  normalizeFileRevealPath,
  resolveFileRevealPathForCwd,
  resolveFileCopyPathsForCwd,
  relativePathFromWorkspaceRoot,
  normalizeWorkspaceRoots,
  containingWorkspaceRoot,
  assertFileRevealWorkspace,
  registerTruncateRollback,
  peekTruncateState,
  notesFilePath,
  sanitizeNotesList,
  sanitizeNoteText,
  loadNotes,
  saveNotes,
  NOTES_MAX_COUNT,
  NOTES_MAX_TEXT_BYTES,
};
