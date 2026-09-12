const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../data/host-badge.cjs').__test;

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-change-review-'));
}

function makeHarness(workspace, sessionId, lines) {
  const transcript = path.join(workspace, sessionId + '.jsonl');
  fs.writeFileSync(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const comm = { webview: { postMessage() {} } };
  const state = {
    comms: new Set([comm]),
    commIdentities: new Map([[comm, { sessionId, cwd: workspace, target: transcript }]]),
    targetCache: new Map(),
    parsers: new Map(),
    changeReviewStates: new Map(),
    log() {},
  };
  return { state, comm, transcript };
}

function userLine(sessionId, cwd, uuid) {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: 'please edit' }] },
    cwd,
    sessionId,
    timestamp: '2026-06-03T10:00:00.000Z',
  };
}

function snapshotLine(turnKey, trackedFileBackups, options = {}) {
  const entryMessageId = options.entryMessageId || turnKey;
  const snapshotMessageId = options.snapshotMessageId || turnKey;
  return {
    type: 'file-history-snapshot',
    messageId: entryMessageId,
    snapshot: {
      messageId: snapshotMessageId,
      trackedFileBackups,
      timestamp: '2026-06-03T10:00:00.001Z',
    },
    isSnapshotUpdate: options.isSnapshotUpdate === true,
  };
}

function snapshotUpdateLine(assistantUuid, trackedFileBackups, options = {}) {
  return snapshotLine(options.snapshotMessageId || assistantUuid, trackedFileBackups, {
    ...options,
    entryMessageId: assistantUuid,
    isSnapshotUpdate: true,
  });
}

function assistantToolLine(sessionId, cwd, uuid, toolId, name, input) {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolId,
        name,
        input,
      }],
    },
    cwd,
    sessionId,
    timestamp: '2026-06-03T10:00:00.010Z',
  };
}

function toolResultLine(sessionId, cwd, uuid, toolId, sourceToolAssistantUUID, options = {}) {
  const entry = {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{
        tool_use_id: toolId,
        type: 'tool_result',
        content: options.content || 'ok',
        is_error: options.isError === true,
      }],
    },
    cwd,
    sessionId,
    sourceToolAssistantUUID,
    timestamp: '2026-06-03T10:00:00.020Z',
  };
  if (Object.prototype.hasOwnProperty.call(options, 'toolUseResult')) {
    entry.toolUseResult = options.toolUseResult;
  }
  return entry;
}

function successfulWriteLines(sessionId, cwd, turnKey, filePath, backup, options = {}) {
  const assistantUuid = options.assistantUuid || ('assistant-' + turnKey);
  const toolId = options.toolId || ('tool-' + turnKey);
  return [
    userLine(sessionId, cwd, turnKey),
    // Real Claude Code can append this snapshot update before the assistant
    // tool_use row. It is backup metadata, not the source of the file row.
    snapshotUpdateLine(assistantUuid, { [filePath]: backup }, {
      snapshotMessageId: options.snapshotMessageId || turnKey,
    }),
    assistantToolLine(sessionId, cwd, assistantUuid, toolId, options.name || 'Write',
      options.input || { file_path: filePath, content: options.content || 'model version\n' }),
    toolResultLine(sessionId, cwd, options.resultUuid || ('tool-result-' + turnKey), toolId, assistantUuid),
  ];
}

function backupDir(sessionId) {
  return path.join(os.homedir(), '.claude', 'file-history', sessionId);
}

function reviewStatePath(sessionId) {
  return path.join(os.homedir(), '.incipit', 'change-review-v1', sessionId + '.json');
}

function finalizedReviewState(turnKey) {
  const reviewState = { turns: {}, files: {} };
  T.markChangeReviewTurnFinalized(reviewState, turnKey);
  reviewState.dirty = false;
  return reviewState;
}

function assertNoActiveTurn(payload, message = 'active composer review payload must not be exposed') {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'activeTurn'), false, message);
}

// Keep persistent checks focused on lifecycle isolation and guarded file rollback.

(function staleStartForPreviousTurnIsIgnoredAfterNextUserIsCurrent() {
  const dir = tmp();
  const sessionId = 'cr-stale-start-' + Date.now();
  try {
    fs.writeFileSync(path.join(dir, 'old.txt'), 'old turn file\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'old.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
      userLine(sessionId, dir, 'u2'),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const result = T.resolveChangeReviewTurnStarted(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const reviewState = state.changeReviewStates.get(sessionId);
    assert.strictEqual(reviewState.turns.u1.finalized, true, 'stale start must not unfinalize the previous turn');
    assertNoActiveTurn(result);
    assert.strictEqual(result.turns.length, 1);
    assert.strictEqual(result.latestTurn.turnKey, 'u1');
    ok('stale start for previous turn is ignored once next user is current');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function explicitFinalizeForMissingTurnDoesNotFallbackToPreviousFileTurn() {
  const dir = tmp();
  const sessionId = 'cr-finalize-no-fallback-' + Date.now();
  try {
    fs.writeFileSync(path.join(dir, 'old.txt'), 'old turn file\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'old.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const reviewState = state.changeReviewStates.get(sessionId);
    T.markChangeReviewTurnStarted(reviewState, 'u1');
    assert.strictEqual(reviewState.turns.u1.finalized, false);
    const result = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u2-missing' });
    assert.strictEqual(reviewState.turns.u1.finalized, false, 'explicit missing finalize must not finalize the latest old turn');
    assert.strictEqual(result.turns.length, 0);
    ok('explicit finalize for missing turn does not fallback to previous file turn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function rejectsCreatedFileByDeletingOnlyWhenGuardMatches() {
  const dir = tmp();
  const sessionId = 'cr-created-' + Date.now();
  try {
    const created = path.join(dir, 'created.txt');
    fs.writeFileSync(created, 'created by model\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'created.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, true);
    assert.ok(!fs.existsSync(created), 'created file should be removed');
    assert.strictEqual(result.payload.latestTurn.files[0].status, 'rejected');
    ok('reject created file: guarded delete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function rejectsExistingFileByRestoringOfficialBackup() {
  const dir = tmp();
  const sessionId = 'cr-restore-' + Date.now();
  const hist = backupDir(sessionId);
  try {
    fs.mkdirSync(hist, { recursive: true });
    fs.writeFileSync(path.join(hist, 'old@v1'), 'old contents\n');
    fs.writeFileSync(path.join(dir, 'target.txt'), 'new contents\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'target.txt', {
        backupFileName: 'old@v1',
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }, {
        name: 'Edit',
        input: { file_path: 'target.txt', old_string: 'old contents\n', new_string: 'new contents\n' },
      }),
    ]);
    const finalized = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assert.strictEqual(finalized.latestTurn.files[0].hasLineStats, true);
    assert.strictEqual(finalized.latestTurn.files[0].added, 1);
    assert.strictEqual(finalized.latestTurn.files[0].removed, 1);
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8'), 'old contents\n');
    ok('reject existing file: restore official backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hist, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function rejectTurnAfterSameUuidRerunOnlyTouchesFreshLifecycleFiles() {
  const dir = tmp();
  const sessionId = 'cr-lifecycle-reject-' + Date.now();
  try {
    const oldFile = path.join(dir, 'old.txt');
    const newFile = path.join(dir, 'new.txt');
    fs.writeFileSync(oldFile, 'old lifecycle model file\n');
    fs.writeFileSync(newFile, 'new lifecycle model file\n');
    const { state, comm, transcript } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'old.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    const oldFinal = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assert.strictEqual(oldFinal.latestTurn.files[0].displayPath.replace(/\\/g, '/'), 'old.txt');
    const parser = state.parsers.get(transcript);
    const turn = parser.changeReviewTurns.get('u1');
    const staleOld = Array.from(turn.files.values())[0];
    staleOld.lastSeenAt = 1;
    const started = T.resolveChangeReviewTurnStarted(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assertNoActiveTurn(started, 'same-uuid rerun starts with no active payload');
    T.processChangeReviewEntry(parser, snapshotUpdateLine('assistant-new', {
      'new.txt': {
        backupFileName: null,
        version: 2,
        backupTime: '2026-06-03T10:00:02.000Z',
      },
    }));
    T.countChangeReviewTool(parser, {
      id: 'tool-new',
      turnKey: 'u1',
      assistantUuid: 'assistant-new',
      filePath: 'new.txt',
      added: 1,
      removed: 0,
    });
    const newFinal = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assertNoActiveTurn(newFinal);
    assert.strictEqual(newFinal.latestTurn.files.length, 1);
    assert.strictEqual(newFinal.latestTurn.files[0].displayPath.replace(/\\/g, '/'), 'new.txt');
    const reviewState = state.changeReviewStates.get(sessionId);
    const oldId = T.changeReviewEntryId(sessionId, 'u1', oldFile);
    const newId = T.changeReviewEntryId(sessionId, 'u1', newFile);
    assert.strictEqual(reviewState.files[oldId], undefined, 'hidden old lifecycle file must not get a fresh guard state');
    assert.ok(reviewState.files[newId], 'fresh lifecycle file must get a guard state');
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.results.length, 1, 'reject turn must clear only fresh lifecycle files');
    assert.ok(fs.existsSync(oldFile), 'old lifecycle file must not be deleted by the rerun reject');
    assert.ok(!fs.existsSync(newFile), 'fresh lifecycle created file should be deleted');
    ok('reject turn after same-uuid rerun touches only fresh lifecycle files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function staleGuardRefusesUserModifiedFile() {
  const dir = tmp();
  const sessionId = 'cr-stale-' + Date.now();
  try {
    const created = path.join(dir, 'created.txt');
    fs.writeFileSync(created, 'model version\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'created.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    fs.writeFileSync(created, 'user changed it\n');
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(fs.existsSync(created), 'stale file must not be deleted');
    assert.strictEqual(result.payload.latestTurn.files[0].status, 'stale');
    ok('stale guard refuses reject after user modification');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function busyRejectIsRefused() {
  const dir = tmp();
  const sessionId = 'cr-busy-' + Date.now();
  try {
    fs.writeFileSync(path.join(dir, 'created.txt'), 'model version\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'created.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    assert.throws(() => T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: true,
    }), /current reply/);
    ok('busy reject is refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

console.log(`change-review health checks passed: ${passed}`);
