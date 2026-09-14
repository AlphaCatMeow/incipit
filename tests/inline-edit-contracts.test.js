'use strict';

// Regression coverage for the merge damage that shipped in 6b2b963: the
// conflict resolution kept this fork's OLD `openInlineEditor` signature
// while taking upstream's NEW body and call sites. The body reads `kind`
// and `initialText`; the signature bound neither, so the first statement
// that touched `kind` threw ReferenceError inside the pencil's click
// handler, `makeTranscriptActionButton` swallowed it into the generic
// `action_failed` toast, and user-message editing was dead — the failure
// surfaced to users as nothing but "failed".
//
// Two layers:
//   1. Static source invariants on enhance_legacy: the destructured
//      parameter list must bind every name the body reads from it, and
//      every call site must state its `kind`. A future refactor that
//      drops either fails CI loudly instead of degrading to that toast.
//   2. host-badge: assistant text edits work, and the record gates that
//      keep them honest still refuse what they should.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../data/host-badge.cjs').__test;

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

const source = fs.readFileSync(
  path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
const lines = source.split('\n');

// ---- Layer 1: signature / body / call-site agreement ----

function openInlineEditorSpan() {
  const i = lines.findIndex(l => /function openInlineEditor\(\{/.test(l));
  assert.ok(i >= 0, 'openInlineEditor must exist');
  let j = i + 1;
  for (; j < lines.length; j++) if (lines[j] === '  }') break;
  return {
    signature: lines[i],
    body: lines.slice(i + 1, j + 1).join('\n'),
  };
}

(function signatureBindsWhatBodyReads() {
  const { signature, body } = openInlineEditorSpan();
  const inner = signature.slice(
    signature.indexOf('{', signature.indexOf('(')) + 1,
    signature.lastIndexOf('}'));
  const bound = new Set(
    inner.split(',').map(s => s.trim().split(/[:=]/)[0].trim()).filter(Boolean));

  // These two are exactly what the merge dropped. Both are read as bare
  // identifiers, so an unbound one is a ReferenceError at first touch —
  // not a silent undefined.
  for (const name of ['kind', 'initialText']) {
    assert.ok(bound.has(name),
      'openInlineEditor must bind `' + name + '`; its body reads it as a bare identifier');
  }
  for (const name of ['record', 'bubbleHost', 'contentEl']) {
    assert.ok(bound.has(name), 'openInlineEditor must bind `' + name + '`');
  }

  // `kind` must still be load-bearing; otherwise the dual-kind plumbing
  // has been half-reverted again and the two kinds diverge silently.
  assert.ok(/\bkind === 'user'/.test(body),
    'openInlineEditor body must branch on `kind`');
  ok('openInlineEditor signature binds every name its body reads');
})();

(function everyCallSiteDeclaresKind() {
  const calls = [...source.matchAll(/openInlineEditor\(\{([\s\S]{0,400}?)\}\);/g)];
  assert.strictEqual(calls.length, 2,
    'expected two openInlineEditor call sites (user pencil + assistant pencil)');
  const kinds = calls.map(m => {
    const hit = /kind:\s*'(user|assistant)'/.exec(m[1]);
    assert.ok(hit, 'every openInlineEditor call site must pass an explicit kind');
    return hit[1];
  }).sort();
  assert.deepStrictEqual(kinds, ['assistant', 'user'],
    'call sites must cover both kinds exactly once');
  ok('both openInlineEditor call sites declare an explicit kind');
})();

(function stateCarriesKind() {
  // saveInlineEditor dispatches on state.kind. If the stored state omits
  // it, a user save takes the text-only host path with no text to send
  // and dies on "Missing replacement text".
  const i = lines.findIndex(l => l.includes('inlineEditByUuid.set(record.uuid, {'));
  assert.ok(i >= 0, 'inline editor state must be stored');
  assert.strictEqual(lines[i + 1].trim(), 'kind,',
    'stored inline-edit state must carry `kind` — saveInlineEditor dispatches on it');
  ok('inline-edit state carries kind');
})();

(function saveDispatchesComputedOp() {
  // The merge hardcoded 'edit_user' here, stranding the computed `op`.
  const save = source.slice(source.indexOf('async function saveInlineEditor'));
  const region = save.slice(0, save.indexOf('\n  }'));
  assert.ok(/requestTranscriptMutation\(op,/.test(region),
    'saveInlineEditor must dispatch the computed op');
  assert.ok(!/requestTranscriptMutation\('edit_user'/.test(region),
    'saveInlineEditor must not hardcode edit_user');
  ok('saveInlineEditor dispatches the computed op');
})();

(function actionRowAppendIsNullSafe() {
  // saveRerunBtn is null for assistant, and Element.append(null)
  // stringifies into a literal "null" text node in the action row.
  const { body } = openInlineEditorSpan();
  assert.ok(!/editActions\.append\(cancelBtn, saveBtn, saveRerunBtn\)/.test(body),
    'must not append a possibly-null saveRerunBtn positionally');
  assert.ok(/if \(saveRerunBtn\)/.test(body),
    'saveRerunBtn must be appended behind a null check');
  ok('edit action row append is null-safe for assistant');
})();

// ---- Layer 2: host-side assistant text edits ----

function fixture(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-inline-edit-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

const ASSISTANT_ROWS = [
  { type: 'user', uuid: 'u1', parentUuid: null,
    message: { role: 'user', content: 'hi' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'original' }] } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'a1',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'SIG' }] } },
];

(function assistantTextEditRewrites() {
  const t = T.readTranscript(fixture(ASSISTANT_ROWS));
  assert.strictEqual(T.applyAssistantTextEdit(t, 'a1', 'rewritten').changed, true,
    'assistant text edit must report a change');
  const out = T.serializeTranscript(t);
  assert.ok(out.includes('rewritten'), 'new assistant text must be written');
  assert.ok(!out.includes('original'), 'old assistant text must be gone');
  ok('assistant text edit rewrites the text block');
})();

(function assistantWithoutTextIsRefused() {
  // requireExistingText: a thinking/tool_use-only record must not have a
  // text block minted onto it — that would desync the signed thinking.
  const t = T.readTranscript(fixture(ASSISTANT_ROWS));
  assert.throws(() => T.applyAssistantTextEdit(t, 'a2', 'nope'),
    /no editable text block/, 'thinking-only assistant record must be refused');
  ok('assistant record with no text block is refused');
})();

(function assistantOpRejectsNonAssistant() {
  const t = T.readTranscript(fixture(ASSISTANT_ROWS));
  assert.throws(() => T.applyAssistantTextEdit(t, 'u1', 'nope'),
    /Only assistant messages/, 'user record must be refused by the assistant op');
  ok('assistant op refuses a user record');
})();

(function editabilityGate() {
  assert.strictEqual(T.canEditAssistantTextEntry(ASSISTANT_ROWS[1]), true);
  assert.strictEqual(T.canEditAssistantTextEntry(ASSISTANT_ROWS[2]), false);
  assert.strictEqual(T.canEditAssistantTextEntry(ASSISTANT_ROWS[0]), false);
  ok('canEditAssistantTextEntry gates on a real text block');
})();

(function userPathsUnaffected() {
  // No downstream signed thinking, so the ordinary user edit applies.
  const file = fixture([
    { type: 'user', uuid: 'u1', parentUuid: null,
      message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  ]);
  let t = T.readTranscript(file);
  assert.strictEqual(T.applyUserEdit(t, 'u1', 'edited').changed, true);
  assert.ok(T.serializeTranscript(t).includes('edited'));

  t = T.readTranscript(file);
  assert.strictEqual(
    T.applyUserBlockEdit(t, 'u1', [{ kind: 'text', text: 'via blocks' }]).changed, true);
  assert.ok(T.serializeTranscript(t).includes('via blocks'));
  ok('user text and blocks edit paths still work');
})();

(function signedThinkingGuardStillFires() {
  const t = T.readTranscript(fixture([
    { type: 'user', uuid: 'u9', parentUuid: null,
      message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a9', parentUuid: 'u9',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'SIG' }] } },
  ]));
  assert.throws(() => T.applyUserEdit(t, 'u9', 'x'), /signed thinking/,
    'local-only user edit ahead of signed thinking must still be refused');
  ok('signed-thinking user-edit guard still fires');
})();

console.log('inline-edit-contracts: ok (' + passed + ' checks)');
