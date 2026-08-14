'use strict';

// Regression fence for the Notes (snippets) + reject-reminder feature.
//
// Contract (the design agreed with the user, see
// dev-notes/2026-06-13-notes-and-reject-reminder.md):
//   · clicking a snippet (or the reject bubble's Insert) puts text in the
//     composer WITHOUT sending. Insertion simulates a real text edit via
//     execCommand('insertText') (the host's own input pipeline, same as typing/
//     paste); it is NOT the @mention command (mangles multi-line prose) and NOT
//     a raw DOM write into the contenteditable (would bypass the host model and
//     break IME — still forbidden, memo 2026-04-15 / 2026-06-06)
//   · notes persist per scope: Global in one file, Project keyed by SHA256(cwd),
//     written atomically (tmp + rename); the two scopes never bleed
//   · the reject bubble accumulates rejected files (deduped by path, last wins),
//     only fires on a SUCCESSFUL reject, and renders a plain-fact, localized
//     (EN/ZH via t()) reminder with one tool-aware line per file (no edit line
//     ranges)
//   · panel interactions are delegated to the stable panel element, never bound
//     per-row (memo 2026-06-13: per-node handlers die on rebuild)
//   · the note icon mounts on the identity heartbeat, not a new body observer

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostBadge = require('../data/host-badge.cjs');
const T = hostBadge.__test;

const footer = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_footer_badge.js'), 'utf8');
const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'data', 'host-badge.cjs'), 'utf8');
const legacy = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
const theme = fs.readFileSync(path.join(__dirname, '..', 'data', 'theme.css'), 'utf8');
const warm = fs.readFileSync(path.join(__dirname, '..', 'data', 'warm-white-override.css'), 'utf8');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

function setupNotesBody() {
  const idx = footer.indexOf('function setupNotes(');
  assert.ok(idx >= 0, 'missing function setupNotes');
  const end = footer.indexOf('\nexport function initFooterBadge', idx);
  assert.ok(end > idx, 'could not bound setupNotes');
  return footer.slice(idx, end);
}
const notes = setupNotesBody();

function tmpNotesDir() {
  const dir = path.join(os.tmpdir(), 'incipit-notes-test-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Storage roundtrip + scope isolation + atomic write (host-badge exports)
// ---------------------------------------------------------------------------
(function storageRoundtripAndIsolation() {
  const dir = tmpNotesDir();
  try {
    const g = T.saveNotes('global', null, [{ id: 'a', text: 'global one', createdAt: 1 }], dir);
    assert.ok(g.ok, 'global save ok');
    assert.ok(fs.existsSync(path.join(dir, 'global.json')), 'global.json written');

    const cwdA = '/work/projA';
    const cwdB = '/work/projB';
    assert.ok(T.saveNotes('project', cwdA, [{ id: 'pa', text: 'A note', createdAt: 1 }], dir).ok);
    assert.ok(T.saveNotes('project', cwdB, [{ id: 'pb', text: 'B note', createdAt: 1 }], dir).ok);

    const loadedA = T.loadNotes('project', cwdA, dir);
    const loadedB = T.loadNotes('project', cwdB, dir);
    assert.strictEqual(loadedA.length, 1);
    assert.strictEqual(loadedA[0].text, 'A note');
    assert.strictEqual(loadedB[0].text, 'B note');
    assert.notStrictEqual(
      T.notesFilePath('project', cwdA, dir),
      T.notesFilePath('project', cwdB, dir),
      'distinct cwds map to distinct files (keyed by projectKey)',
    );

    // Global and project stay separate.
    assert.strictEqual(T.loadNotes('global', null, dir)[0].text, 'global one');

    // Atomic: no .tmp- leftovers after a write.
    const leftovers = fs.readdirSync(dir).filter(f => f.indexOf('.tmp-') !== -1);
    assert.strictEqual(leftovers.length, 0, 'no temp files remain (atomic rename)');

    ok('storage: roundtrip, global/project isolation, atomic write');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function projectScopeNeedsCwd() {
  assert.strictEqual(T.notesFilePath('project', '', '/x'), null, 'project notes without cwd → no path');
  const res = T.saveNotes('project', null, [{ id: 'a', text: 'x' }], '/x');
  assert.strictEqual(res.ok, false, 'project save without cwd is refused');
  ok('storage: project scope without a workspace is refused, not misfiled');
})();

(function sanitizeRules() {
  const cleaned = T.sanitizeNotesList([
    { id: 'keep', text: 'real' },
    { id: 'blank', text: '   ' },            // dropped: blank
    { text: 'no id here' },                   // gets a synthesized id
    { id: 'keep', text: 'dup id' },           // duplicate id is disambiguated
    null,                                     // ignored
  ]);
  assert.ok(cleaned.every(n => n.text.trim()), 'blank notes dropped');
  const ids = cleaned.map(n => n.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique after sanitize');
  assert.ok(cleaned.length <= T.NOTES_MAX_COUNT);

  const crlf = T.sanitizeNoteText('line1\r\nline2\rline3');
  assert.strictEqual(crlf, 'line1\nline2\nline3', 'CRLF/CR normalized to LF so stored text inserts identically');
  ok('storage: sanitize drops blanks, dedups ids, normalizes CRLF');
})();

// ---------------------------------------------------------------------------
// 2. Insertion simulates a real text edit on the host composer — NOT the host
//    @mention command (that mangles multi-line prose), and NOT a raw DOM write
//    (that bypasses the host model + breaks IME).
// ---------------------------------------------------------------------------
(function insertionSimulatesDirectInput() {
  // The host no longer round-trips insertion: the @mention bridge command stays
  // for companion @path references only, not snippets.
  assert.ok(hostBadge.__test.NOTES_INSERT_COMMAND === undefined,
    'host no longer exposes a notes insert command (insertion moved to the webview)');
  assert.ok(!hostSrc.includes('handleNotesInsertRequest') &&
    !hostSrc.includes("type: 'notes_insert_request'"),
    'host has no notes insert handler/dispatch anymore');

  // Webview side: insertion calls the host composer's own setInputText via a
  // one-shot React-fiber lookup (controlled component; only the host setter syncs
  // DOM + state for multi-line). execCommand is only a degraded fallback.
  assert.ok(!notes.includes("type: 'notes_insert_request'"),
    'webview no longer posts a notes_insert_request');
  const fiberIdx = notes.indexOf('function hostComposerSetText');
  assert.ok(fiberIdx >= 0, 'webview has the host-setter fiber bridge');
  const fiberBody = notes.slice(fiberIdx, fiberIdx + 900);
  assert.ok(fiberBody.includes('__reactFiber$') &&
    fiberBody.includes('ref.current.setInputText') &&
    fiberBody.includes('fiber.return'),
    'host insert walks the React fiber to the composer ref and calls setInputText');
  const insIdx = notes.indexOf('function insertText');
  assert.ok(insIdx >= 0, 'webview has the insertText entry point');
  const insBody = notes.slice(insIdx, insIdx + 1000);
  assert.ok(insBody.includes('hostComposerSetText(input, combined)'),
    'insertText routes through the host setInputText bridge first');
  // insertText READS textContent (to append) but must NOT WRITE the editor DOM —
  // those vectors bypass the host model and break IME.
  assert.ok(!/\.(?:innerHTML|textContent|contentEditable)\s*=[^=]/.test(insBody) &&
    !/\.(?:insertNode|appendChild|insertAdjacent)\(/.test(insBody),
    'insertText does no raw DOM write into the host editor (reading textContent to append is fine)');
  ok('insert: host setInputText via fiber (no @mention, no raw DOM write); execCommand only as fallback');
})();

// ---------------------------------------------------------------------------
// 3. Reject reminder bubble: success-only, deduped, plain-fact, localized
// ---------------------------------------------------------------------------
(function rejectBubbleContract() {
  assert.ok(
    notes.includes("window.addEventListener('incipit:change-review-rejected'"),
    'bubble listens for the reject bridge event',
  );
  // Per-file accumulation deduped BY PATH (last tool/line-stats win), not the old
  // string-path set.
  assert.ok(notes.includes('function addRejectedFiles') &&
    notes.includes('rejectedFiles[found] = entry'),
    'rejected files accumulate, deduped by path with last entry winning');
  assert.ok(notes.includes('function buildRejectReminder') &&
    notes.includes('function rejectReminderLine'),
    'has a per-file reminder builder');
  // Per-file, tool-aware copy: created -> deleted, existing -> restored, with
  // +N/-M totals but NEVER edit line ranges (post-revert line numbers mislead).
  assert.ok(notes.includes("(f.tool ? f.tool + ' ' : '')"),
    'each reminder line is prefixed by the editing tool name when known');
  // Reminder copy is localized via t(key, vars) (EN/ZH, see CFG.language); the
  // call sites live inside setupNotes, the dictionary values live in the
  // module-level STR table above it, so both must be checked.
  assert.ok(notes.includes("t('file_created_deleted')"),
    'created files use the localized file_created_deleted string');
  assert.ok(footer.includes("file_created_deleted: ' — newly created; now deleted.'"),
    'EN dict: created files report deletion, not restore');
  assert.ok(footer.includes("file_created_deleted: ' — 新建后已删除。'"),
    'ZH dict: created files report deletion, not restore');
  assert.ok(notes.includes("t('file_restored', { stats: stats })"),
    'existing files use the localized file_restored string');
  assert.ok(footer.includes("file_restored: ' — {stats}restored to its previous contents.'"),
    'EN dict: existing files report restore to previous contents');
  assert.ok(footer.includes("file_restored: ' — {stats}已恢复为先前内容。'"),
    'ZH dict: existing files report restore to previous contents');
  assert.ok(notes.includes("t('file_line_stats', { added: f.added || 0, removed: f.removed || 0 })"),
    'existing files may show +N/-M line totals via the localized file_line_stats string');
  assert.ok(footer.includes("file_line_stats: '+{added}/−{removed} lines; '"),
    'EN dict: line totals keep the +N/-M template');
  // No edit line ranges anywhere in the reminder path (user decision 2026-06-13).
  assert.ok(!/lineRange|startLine|endLine|':' \+ .*line/i.test(notes),
    'reminder must not emit edit line ranges, only +N/-M totals');

  // enhance_legacy: dispatch ONLY on success, with file details captured BEFORE the post.
  const turnIdx = legacy.indexOf('function rejectChangeReviewTurn');
  const turnBody = legacy.slice(turnIdx, turnIdx + 700);
  assert.ok(turnBody.indexOf('changeReviewTurnRejectedFiles(turnKey)') < turnBody.indexOf('postChangeReviewRequest'),
    'turn reject captures file details before posting');
  assert.ok(turnBody.indexOf('.then(() => { dispatchChangeReviewRejected') < turnBody.indexOf('.catch('),
    'turn reject dispatches in the success branch, not on failure');

  const fileIdx = legacy.indexOf('function rejectChangeReviewFile');
  const fileBody = legacy.slice(fileIdx, fileIdx + 700);
  assert.ok(fileBody.indexOf('changeReviewRejectedFilesByIds([fileId])') < fileBody.indexOf('postChangeReviewRequest'),
    'file reject captures file detail before posting');
  assert.ok(fileBody.includes('.then(() => { dispatchChangeReviewRejected'),
    'file reject dispatches in the success branch');

  // Capture pulls tool/created/line-stats off the host payload, and the bridge
  // carries the file objects (not bare paths).
  assert.ok(legacy.includes('function changeReviewFileRejectInfo') &&
    legacy.includes('tool: typeof file.tool') &&
    legacy.includes('isCreated: file.isCreated === true'),
    'reject capture reads tool + created + line stats off the host file payload');
  assert.ok(
    legacy.includes("new CustomEvent('incipit:change-review-rejected', { detail: { files: clean } })"),
    'bridge carries per-file detail objects over the agreed window CustomEvent',
  );

  // host-badge: the tool name (Write/Edit/MultiEdit) is threaded onto the file
  // and exposed in the webview payload.
  assert.ok(hostSrc.includes('tool: typeof item.name === \'string\' ? item.name : \'\'') &&
    hostSrc.includes("if (typeof patch.tool === 'string' && patch.tool) file.tool = patch.tool;"),
    'countChangeReviewTool records the editing tool name on the file');
  assert.ok(hostSrc.includes("tool: typeof file.tool === 'string' ? file.tool : ''"),
    'changeReviewFilePayload exposes the tool name to the webview');
  ok('reject bubble: per-file tool-aware copy, no line ranges, dedup-by-path, success-only dispatch');
})();

// ---------------------------------------------------------------------------
// 4. Panel interactions delegated to the stable element; icon rides heartbeat
// ---------------------------------------------------------------------------
(function delegationAndMount() {
  assert.ok(notes.includes('function bindPanelDelegation'), 'panel uses a single delegation binder');
  // Rows are pure factories — no per-node click handlers that die on rebuild.
  const rowIdx = notes.indexOf('function buildNoteRow');
  const rowBody = notes.slice(rowIdx, notes.indexOf('function buildEditor'));
  assert.ok(!rowBody.includes('addEventListener'), 'note rows do not self-bind handlers (memo 2026-06-13)');

  // Icon mounts on the shared identity heartbeat, not a fresh body observer.
  assert.ok(notes.includes('registerIdentityPublisher'), 'note icon rides the identity heartbeat');
  assert.ok(!notes.includes('new MutationObserver'), 'no new body-wide observer for the note icon');

  // Icon sits immediately left of the cache badge.
  assert.ok(notes.includes("host.insertBefore(btn, badge)"), 'note icon anchored left of the cache badge');
  ok('panel: delegated interactions, heartbeat mount, icon left of badge');
})();

// ---------------------------------------------------------------------------
// 5. Themed both ways with the shared dialog tokens
// ---------------------------------------------------------------------------
(function themedBothWays() {
  assert.ok(theme.includes('[data-incipit-notes-panel]') && theme.includes('[data-incipit-notes-bubble]'),
    'dark theme styles the panel and bubble');
  assert.ok(theme.includes('#a8896e'), 'primary action uses the shared #a8896e');
  assert.ok(warm.includes('[data-incipit-notes-panel]') && warm.includes('#ffffff'),
    'warm-white override repaints the panel');
  assert.ok(warm.includes('[data-incipit-notes-bubble-insert]'), 'warm-white override repaints the bubble insert button');
  ok('theme: dark + warm-white share the custom-model dialog language');
})();

console.log('\nnotes: ' + passed + ' checks PASSED');
