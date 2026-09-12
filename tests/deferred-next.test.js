'use strict';

// Regression fence for the "queue messages while streaming" composer layer.
//
// Contract (the design agreed with the user):
//   · a real ORDERED QUEUE (not one latest payload): mid-stream composer
//     submits APPEND; the card shows all of them, reorderable
//   · the card's per-row "Guide" still calls the original host send NOW
//   · AUTO-RELEASE fires only on a *natural* turn end. busy/finalized fire
//     identically for natural end, user Stop, and error — so release is
//     gated on the host "interrupted" marker + partial tail, behind a
//     sustained re-checked confirm window (an errored turn's marker can
//     lag busy=false — fail-closed: any doubt ⇒ do not send)
//   · only the HEAD is released; it does NOT chain — the next item waits
//     for the next natural end
//   · no floating toasts at all; errors surface inline in the card
//   · editing a row survives queue mutations / reorder (textarea + CJK IME
//     never torn down)
//   · the official composer text layer is fully host-owned: incipit only feeds
//     host input foreground tokens (+ retints reference chips); it never edits
//     text/selection, styles the text layers, or syncs mirror scroll geometry
//     (a manual sync races the host on paste/insert and desyncs the layers).
//     The single sanctioned mirror rule is static scroll headroom (an empty
//     `::after` block) so the host's own scrollTop copy can never clamp.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const legacy = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8').replace(/\r\n/g, '\n');
const theme = fs.readFileSync(path.join(__dirname, '..', 'data', 'theme.css'), 'utf8').replace(/\r\n/g, '\n');
const warm = fs.readFileSync(path.join(__dirname, '..', 'data', 'warm-white-override.css'), 'utf8').replace(/\r\n/g, '\n');
const ink = fs.readFileSync(path.join(__dirname, '..', 'data', 'ink-black-override.css'), 'utf8').replace(/\r\n/g, '\n');
const shared = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_shared.js'), 'utf8').replace(/\r\n/g, '\n');
const hostProbe = fs.readFileSync(path.join(__dirname, '..', 'data', 'host_probe.js'), 'utf8').replace(/\r\n/g, '\n');
const runtime = fs.readFileSync(path.join(__dirname, '..', 'data', 'runtime_kernel.js'), 'utf8').replace(/\r\n/g, '\n');
const typography = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_typography.js'), 'utf8').replace(/\r\n/g, '\n');
const moduleSrc = fs.readFileSync(path.join(__dirname, '..', 'data', 'legacy', 'deferred_next.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
function functionBody(name, span = 1800) {
  const idx = legacy.indexOf('function ' + name);
  assert.ok(idx >= 0, 'missing function ' + name);
  return legacy.slice(idx, idx + span);
}
function cssRuleBodyFrom(source, selector) {
  const idx = source.indexOf(selector);
  assert.ok(idx >= 0, 'missing CSS selector ' + selector);
  const open = source.indexOf('{', idx);
  const close = source.indexOf('}', open);
  assert.ok(open >= 0 && close > open, 'missing CSS block for ' + selector);
  return source.slice(open + 1, close);
}
function cssRuleBody(selector) {
  return cssRuleBodyFrom(theme, selector);
}

(function legacyModuleIsSplitAndRegistered() {
  assert.ok(
    moduleSrc.includes("runLegacyInit('deferred_next'") &&
      moduleSrc.includes('ctx.setupDeferredNextMessageQueue();'),
    'deferred_next legacy module must register an independent health init',
  );
  assert.ok(
    legacy.includes("import { initLegacyDeferredNext } from './legacy/deferred_next.js'") &&
      legacy.includes('initLegacyDeferredNext(legacyContext);'),
    'enhance_legacy must import and initialize deferred_next',
  );
  ok('legacy module split + init registration');
})();

(function changeReviewUiIsActiveForReleaseApply() {
  const initMatch = legacy.match(/\n  function init\(\) \{([\s\S]*?)\n  \}\n\n  whenDOMReady\(init\);/);
  assert.ok(initMatch, 'missing legacy root init() body');
  const init = initMatch[1];
  const setup = functionBody('setupChangeReviewFileReview', 2200);
  assert.ok(
    legacy.includes('function setupChangeReviewFileReview()') &&
      setup.includes("reportHealth('legacy.change_review', 'ok')") &&
      init.includes('setupChangeReviewFileReview,'),
    'change-review implementation must remain in source for continued development',
  );
  assert.ok(
    /^\s*setupChangeReviewFileReview\(\);/m.test(init),
    'release apply must activate transcript review blocks',
  );
  ok('change-review transcript UI: source retained and release init active');
})();

(function sendWrapperKeepsOfficialPath() {
  const wrap = functionBody('wrapDeferredSendOnSession');
  const captureGate = functionBody('shouldCaptureDeferredSend', 600);
  assert.ok(legacy.includes('const deferredOriginalSendBySession = new WeakMap();'),
    'original SessionState.send must be preserved per session');
  assert.ok(wrap.includes('session.send = function incipitDeferredNextSendWrapper(...args)'),
    'SessionState.send wrapper must be installed');
  assert.ok(captureGate.includes('sessionBusyForDeferredCapture(session)') &&
    captureGate.indexOf('sessionBusyForDeferredCapture(session)') < captureGate.indexOf('deferredPayloadHasContent'),
    'busy capture must use composite busy, not raw session busy alone');
  assert.ok(wrap.includes('shouldCaptureDeferredSend(this, args)') &&
    wrap.includes('captureDeferredNext(this, args);') &&
    wrap.includes('return Promise.resolve();'),
    'busy composer send must be captured without launching a second host send');
  assert.ok(wrap.includes('return original.apply(this, args);'),
    'non-captured sends must continue through the original host path');
  assert.ok(legacy.includes('deferredNextBypassDepth') &&
    legacy.includes('await rawSend.apply(session, [item.text, item.attachments, false])'),
    'Guide must bypass the wrapper and call the original host send immediately');
  ok('send wrapper: capture busy submit, preserve official send/Guide path');
})();

(function stateIsAnOrderedQueueAppended() {
  const capture = functionBody('captureDeferredNext', 1200);
  assert.ok(legacy.includes('let deferredQueue = [];'),
    'state must be an ordered queue, not one latest payload');
  assert.ok(!legacy.includes('let deferredNext = null;'),
    'the single-latest model must be gone');
  assert.ok(capture.includes('deferredQueue.push({') && !capture.includes('replacing'),
    'a mid-stream submit must APPEND to the queue, never replace');
  assert.ok(legacy.includes('function deferredHead') &&
    legacy.includes('function deferredRemoveById'),
    'queue needs head + remove-by-id helpers');
  ok('state model: ordered queue, capture appends');
})();

(function noFloatingToastsErrorsAreInline() {
  for (const key of ['sendFail', 'badType', 'tooLarge', 'readFail']) {
    assert.ok(!legacy.includes("showTranscriptToast(deferredText('" + key + "'"),
      'no status/error toast for ' + key + ' — the card is the feedback');
  }
  assert.ok(legacy.includes('function setDeferredInlineError'),
    'errors must be surfaced inline, not via a floating toast');
  const add = functionBody('addDeferredAttachmentFromFile', 1400);
  assert.ok(add.includes("setDeferredInlineError(deferredText('badType'))") &&
    add.includes("setDeferredInlineError(deferredText('readFail'))"),
    'image errors must be inline and NOT silently swallowed');
  ok('no floating toasts; errors inline, not swallowed');
})();

(function naturalEndGateRefusesInterruptedAndError() {
  const interrupted = functionBody('deferredLastTurnInterrupted', 900);
  const natural = functionBody('deferredTurnLooksNatural', 500);
  const arm = functionBody('armNaturalEndConfirm', 900);
  assert.ok(interrupted.includes('interruptedMessage') &&
    interrupted.includes('activeSessionHasPartialTail()'),
    'interruption = host interrupted marker (primary) + partial tail (secondary)');
  assert.ok(natural.includes('deferredConvBusySafe()') &&
    natural.includes('deferredLastTurnInterrupted()') &&
    natural.includes('askPanelIsActive()'),
    'a natural end requires: not busy, not interrupted, no Ask');
  assert.ok(legacy.includes('const DEFERRED_NEXT_NATURAL_CONFIRM_MS = 1500;'),
    'a deliberate sustained confirm window must exist (absorbs the lagging error marker)');
  assert.ok(arm.includes('DEFERRED_NEXT_NATURAL_CONFIRM_MS') &&
    arm.includes('if (!deferredTurnLooksNatural()) return;') &&
    arm.includes('flushDeferredNextIfReady();'),
    'the confirm window must re-check natural-ness before releasing');
  // bridge-unknown is treated as busy (fail-closed). The old catch-only shim
  // missed the probe-collapses-all-miss-to-false hole (2026-06-09); the gate
  // must ride the tri-state fail-closed predicate instead.
  assert.ok(/function deferredConvBusySafe\(\)[\s\S]{0,500}?return conversationBusyOrUnknown\(\);/.test(legacy),
    'unknown host state must be treated as busy, never as a free pass to send');
  assert.ok(!/function deferredConvBusySafe\(\)[\s\S]{0,500}?catch \(_\) \{ return true; \}/.test(legacy),
    'deferredConvBusySafe must not regress to the throw-only fail-closed shim (it never fired: the registered probe returned false on all-miss instead of throwing)');
  ok('natural-end gate: interrupted/error/partial freeze the queue');
})();

(function flushReleasesHeadOnlyAndDoesNotChain() {
  const fb = functionBody('flushDeferredNextIfReady', 1700);
  assert.ok(fb.includes('const item = deferredHead();'),
    'flush must target the queue head');
  assert.ok(fb.includes('if (!deferredTurnLooksNatural()) { scheduleDeferredNextRender(); return; }'),
    'flush must RE-CHECK natural-ness at fire time (marker can land late)');
  assert.ok(fb.includes('await rawSend.apply(active, [item.text, item.attachments, false])') &&
    fb.includes('deferredRemoveById(item.id);'),
    'flush sends via the original host send, then drops exactly that item');
  const afterSend = fb.indexOf('await rawSend.apply(active');
  assert.ok(afterSend >= 0 &&
    fb.indexOf('flushDeferredNextIfReady(', afterSend + 1) === -1,
    'flush must NOT chain-send the next item — it waits for the next natural end');
  ok('flush: head-only, gated, no burst/chain');
})();

(function setupArmsOnSettleNeverFlushesOnRawBusyFalse() {
  const setup = functionBody('setupDeferredNextMessageQueue', 1400);
  assert.ok(setup.includes("subscribeRuntime('streamSettled', () => { armNaturalEndConfirm(); })") &&
    setup.includes("subscribeRuntime('assistantTurnFinalized', () => { armNaturalEndConfirm(); })"),
    'settle/finalize only ARM the confirm window');
  assert.ok(setup.includes('if (evt && evt.busy === true) cancelNaturalEndConfirm();'),
    'a live turn must cancel any pending release');
  assert.ok(!setup.includes('evt.busy === false') && !legacy.includes('scheduleDeferredNextFlush'),
    'the naive "flush on busy=false" path must be gone (it mis-sent after a Stop)');
  ok('setup: arm-on-settle, cancel-on-busy, no raw busy-false flush');
})();

(function cardVisibilityAndKeyedReconciliation() {
  const hide = functionBody('deferredCardShouldHide', 600);
  const rowFor = functionBody('deferredRowFor', 900);
  const observer = functionBody('setupDeferredNextVisibilityObserver', 2400);
  assert.ok(hide.includes('deferredComposerIsVisible(mount.input)') &&
    hide.includes('askPanelIsActive()') &&
    hide.includes('deferredQueueSessionId()'),
    'card hides with the composer, when Ask is up, or off the queue session');
  assert.ok(observer.includes('!deferredQueue.length && !deferredNextEl') &&
    !observer.includes('changeReviewCardEl') &&
    !observer.includes('changeReviewActiveTurn') &&
    observer.includes('deferredNodeTouchesComposerOrAsk') &&
    observer.includes('mutationInsideFocusedEditor(m)') &&
    observer.includes('armNaturalEndConfirm();'),
    'observer is cheap when idle, skips focused editor mutations, stays deferred/Ask-scoped, and arms (not flushes) on touch');
  assert.ok(observer.includes('deferredNextVisibilityObserver.observe(document.body, { childList: true, subtree: true });') &&
    !observer.includes('attributes: true') &&
    !observer.includes('attributeFilter') &&
    !observer.includes("m.type === 'attributes'"),
    'deferred/change-review visibility must not observe body-wide class/style attributes');
  assert.ok(rowFor.includes('if (hasEditor) refreshDeferredEditorInPlace(row, item)'),
    'a row holding a live editor must be refreshed in place, never rebuilt');
  assert.ok(rowFor.includes('else { row.textContent = \'\'; renderDeferredNextEditor(row, item); }'),
    'the editor is built once (no live editor yet); summary stays stateless');
  ok('card: keyed reconciliation, editor row preserved, Ask-scoped observer');
})();

(function sharedComposerRailKeepsDeferredQueueClosestToInput() {
  const composerRoot = functionBody('currentComposerElement', 1400);
  const composerRootCheck = functionBody('isComposerRootElement', 900);
  const touches = functionBody('deferredNodeTouchesComposerOrAsk', 900);
  const rail = functionBody('ensureComposerRail', 1300);
  const mountPoint = functionBody('composerRailMountPoint', 500);
  const deferredMount = functionBody('deferredCardMountPoint', 500);
  const inputRule = cssRuleBody('fieldset[class*="inputContainer_"]');
  const warmInputRule = cssRuleBodyFrom(warm, 'fieldset[class*="inputContainer_"]');
  const inputBgRule = cssRuleBody('\n[class*="inputContainerBackground"]');
  const railRule = cssRuleBody('[data-incipit-composer-rail]');
  assert.ok(legacy.includes('let composerRailEl = null') &&
    rail.includes("composerRailEl.setAttribute('data-incipit-composer-rail', '')"),
    'incipit composer attachments must share one rail above the official input');
  assert.ok(legacy.includes("const COMPOSER_INPUT_CONTAINER_SELECTOR =\n    'fieldset[class*=\"inputContainer_\"], [class*=\"inputContainer_\"]:has(> [class*=\"inputContainerBackground\"])';") &&
    legacy.includes('function nodeInsideFocusedEditor(node)') &&
    legacy.includes('function nodeInsideMessagesContainer(node)') &&
    !composerRoot.includes('document.querySelectorAll(SEL.inputContainer)') &&
    composerRoot.includes("document.querySelectorAll('[class*=\"inputContainer_\"]')") &&
    composerRootCheck.includes("classes.includes('inputContainer_')") &&
    composerRootCheck.includes("classes.includes('inputContainerBackground')") &&
    composerRootCheck.includes("tag === 'fieldset' || hasDirectInputContainerBackground(node)") &&
    mountPoint.includes('const input = currentComposerElement();') &&
    touches.includes('nodeInsideFocusedEditor(node)') &&
    touches.includes('nodeTouchesPermissionRequest(node)') &&
    touches.includes('nodeInsideMessagesContainer(node)') &&
    touches.includes('isComposerRootElement(node)') &&
    touches.includes('closestComposerRoot(node)') &&
    touches.includes('queryComposerRoot(node)'),
    'composer rail must have a precise fallback while keeping input typing and message scrolling out of the hot composer scan');
  assert.ok(rail.includes('data-incipit-composer-rail-hidden') &&
    rail.includes('!deferredComposerIsVisible(mount.input) || askPanelIsActive()'),
    'AskUserQuestion / hidden composer must hide the whole composer rail');
  assert.ok(deferredMount.includes('return { parent: mount.rail, before: null, input: mount.input };'),
    'deferred-next must mount last in the rail, staying closest to the input');
  assert.ok(theme.includes('[data-incipit-composer-rail]') &&
    theme.includes('flex-direction: column') &&
    theme.includes('[data-incipit-composer-rail-hidden]') &&
    inputRule.includes('--focus-ring-color: transparent !important;') &&
    inputRule.includes('border-color: transparent !important;') &&
    inputRule.includes('outline: none !important;') &&
    warmInputRule.includes('--focus-ring-color: transparent !important;') &&
    warmInputRule.includes('border-color: transparent !important;') &&
    warmInputRule.includes('outline: none !important;') &&
    theme.includes('fieldset[class*="inputContainer_"][data-permission-mode]:focus-within') &&
    warm.includes('fieldset[class*="inputContainer_"][data-permission-mode]:focus-within') &&
    !/box-sizing|width\s*:|max-width|min-width|min-inline-size|background\s*:|background-color|border\s*:|box-shadow|transition/.test(inputRule) &&
    inputBgRule.includes('background: var(--ink-composer-input-bg) !important;') &&
    inputBgRule.includes('box-shadow: var(--ink-input-container-background-shadow) !important;') &&
    railRule.includes('max-width: 100% !important;') &&
    railRule.includes('min-width: 0 !important;') &&
    theme.includes('[data-incipit-deferred-next] {\n  box-sizing: border-box !important;\n  width: 100% !important;\n  margin: 0 !important;'),
    'rail sizing stays inside the official composer width; input container keeps host-owned scroll geometry while only its background layer is retinted');
  ok('shared composer rail: Ask hides all, deferred queue remains closest to input');
})();




(function reorderIsPointerDragNotNativeDnD() {
  const drag = functionBody('startDeferredRowDrag', 1100);
  const summary = functionBody('renderDeferredNextSummary', 2600);
  assert.ok(summary.includes("grip.addEventListener('pointerdown', evt => startDeferredRowDrag("),
    'reorder starts from a pointerdown on the grip');
  assert.ok(drag.includes("window.addEventListener('pointermove'") &&
    drag.includes("window.addEventListener('pointerup'") &&
    drag.includes('commitDeferredOrderFromDom(list)'),
    'reorder is pointer-driven and commits the new order back to the queue');
  assert.ok(drag.includes('if (item.sending || item.editing) return;'),
    'the in-flight / editing row is locked from dragging');
  assert.ok(!legacy.includes('.draggable = true'),
    'reorder must NOT use flaky native HTML5 drag-and-drop');
  ok('reorder: pointer-drag on grip, in-flight locked, no native DnD');
})();

(function perRowGuideAndDiscardById() {
  const guide = functionBody('guideDeferredNextNow', 1100);
  const discard = functionBody('discardDeferredNext', 400);
  assert.ok(legacy.includes('async function guideDeferredNextNow(item)') &&
    guide.includes('deferredRemoveById(item.id);') &&
    guide.includes('rawSend.apply(session, [item.text, item.attachments, false])'),
    'Guide sends THIS item now and removes only it; the rest stay queued');
  assert.ok(discard.includes('if (id == null) deferredQueue = [];') &&
    discard.includes('deferredRemoveById(id);'),
    'discard removes one row by id (or clears all)');
  ok('per-row Guide + discard by id; others keep queuing');
})();

(function editorTextAndImageStillEditableAndImeSafe() {
  const editor = functionBody('renderDeferredNextEditor', 4200);
  const strip = functionBody('renderDeferredAttachmentStrip', 4600);
  const add = functionBody('addDeferredAttachmentFromFile', 1400);
  // The image MIME allow-list / size cap are now SHARED with the
  // user-bubble editor — one source of truth, no parallel copy.
  assert.ok(!legacy.includes('DEFERRED_NEXT_ALLOWED_IMAGE_MIMES') &&
    !legacy.includes('DEFERRED_NEXT_MAX_IMAGE_BYTES'),
    'the duplicated DEFERRED_NEXT_* image constants must be gone');
  assert.ok(add.includes('ALLOWED_INLINE_IMAGE_MIMES.has(file.type)') &&
    add.includes('file.size > MAX_INLINE_IMAGE_BYTES'),
    'image validation must reuse the shared inline-editor allow-list/cap');
  assert.ok(strip.includes("fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp'") &&
    editor.includes("textarea.addEventListener('paste'") &&
    editor.includes("row.addEventListener('drop'"),
    'image input via the in-strip + picker, plus textarea paste and editor drop');
  assert.ok(add.includes('new FileReader()') &&
    add.includes('reader.readAsDataURL(file)') &&
    add.includes('draft.attachments.push({ file, dataUrl })'),
    'new image input must be converted back to the host attachment shape');
  assert.ok(editor.includes('evt.isComposing') && editor.includes('evt.keyCode === 229'),
    'editor keydown must ignore keys during CJK IME composition');
  assert.ok(editor.includes("evt.key === 'Escape'") &&
    editor.includes("evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)"),
    'Esc cancels and Cmd/Ctrl+Enter saves the queued edit');
  ok('editor: text+image editable, shared cap, IME-safe, Esc/⌘↵ shortcuts');
})();

(function officialComposerTextLayerIsHostOwned() {
  const composerTextSelector = /\[class\*="(?:messageInput|mentionMirror|voiceInterim)"\]/;
  const composerChipSelector = 'fieldset[class*="inputContainer_"] [class*="inputMentionChip"]';
  const inputRule = cssRuleBody('fieldset[class*="inputContainer_"]');
  const warmInputRule = cssRuleBodyFrom(warm, 'fieldset[class*="inputContainer_"]');
  const composerChip = cssRuleBody(composerChipSelector);
  const assistantMarkdownRule = cssRuleBody('[data-incipit-message] > [data-incipit-markdown-root]');
  assert.ok(!legacy.includes('setupComposerInputState') &&
    !legacy.includes('composerEditorPlainText') &&
    !legacy.includes('data-incipit-composer-empty'),
    'legacy runtime must not rebuild or reclassify the official composer text layer');
  // Composer mirror geometry is fully host-owned. The 2026-06-13 manual scroll
  // sync (mirror.scrollTop = input.scrollTop driven by a characterData/body
  // observer + capture listeners) raced the host on paste / programmatic insert
  // and desynced the visible mirror from the editable layer; it is removed.
  // incipit must not reintroduce any mirror geometry sync — no reading or
  // writing mirror scroll/padding, no observing the mentionMirror/messageInput.
  assert.ok(!legacy.includes('syncComposerMirrorGeometry') &&
    !legacy.includes('ensureComposerMirrorContentObserver') &&
    !legacy.includes('scheduleComposerMirrorSync') &&
    !legacy.includes('setupComposerMirrorScrollSync') &&
    !legacy.includes('composerMirrorForInput') &&
    !legacy.includes('mentionMirror') &&
    !legacy.includes('mirror.scrollTop') &&
    !legacy.includes('mirror.scrollLeft') &&
    !legacy.includes('elementVerticalScrollbarGutter') &&
    !legacy.includes('targetPaddingRight'),
    'legacy runtime must not touch composer mirror geometry; mentionMirror scroll/padding is host-owned (a manual sync races the host on paste/insert and desyncs the visible layer)');
  assert.ok(!hostProbe.includes('data-incipit-input-editor') &&
    !hostProbe.includes('inputEditor') &&
    !hostProbe.includes('[aria-multiline="true"][contenteditable]'),
    'host probe must not mark or observe the official contenteditable editor');
  assert.ok(!theme.includes('data-incipit-composer-empty') &&
    !theme.includes('[data-incipit-input-editor]') &&
    !theme.includes('[class*="mentionMirror"]') &&
    !theme.includes('--app-mention-chip-background') &&
    !theme.includes('--app-mention-chip-foreground') &&
    !composerTextSelector.test(theme),
    'theme.css must not style messageInput, mentionMirror, or voiceInterim');
  // The one sanctioned mirror rule: invisible scroll headroom. Chromium leaves
  // a placeholder <br> at the end of the editable after a trailing line is
  // deleted; the mirror (rendered from textContent) is then one line shorter,
  // the host's scrollTop copy clamps at the bottom, and the visible text drifts
  // off the caret. An empty ::after block keeps the mirror's scroll range >=
  // the editor's so the copy never clamps. It must stay range-only: no colour,
  // padding, font, position, or anything that could change the visible paint.
  const mirrorHeadroomSelector = '[class*="messageInputContainer_"] > [class*="mentionMirror_"]::after';
  const themeWithoutComments = theme.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.strictEqual(themeWithoutComments.split('mentionMirror').length - 1, 1,
    'theme.css may reference the composer mirror in exactly one rule (the scroll headroom block)');
  assert.ok(themeWithoutComments.includes(mirrorHeadroomSelector + ' {'),
    'mirror headroom must target the mirror as a direct child of messageInputContainer via ::after');
  assert.strictEqual(cssRuleBody(mirrorHeadroomSelector).replace(/\s+/g, ' ').trim(),
    'content: ""; display: block; height: 200px;',
    'mirror headroom rule must only extend scrollable range (empty block, fixed height, no !important)');
  assert.ok(!warm.includes('mentionMirror') && !ink.includes('mentionMirror'),
    'palette overrides must not add any mirror rule of their own');
  assert.ok(!theme.includes('* {\n  scrollbar-width: auto !important;') &&
    theme.includes('*:not([class*="inputContainer_"]):not([class*="inputContainer_"] *):not([contenteditable]):not([contenteditable] *)') &&
    theme.includes('scrollbar-width: auto !important;'),
    'global scrollbar styling must exclude the official composer/contenteditable subtree; when the composer becomes scrollable, forcing its scrollbar metrics desynchronizes text, mirror, and caret geometry');
  assert.ok(/max-height\s*:\s*none\s*!important\s*;/.test(assistantMarkdownRule) &&
    /overflow\s*:\s*visible\s*!important\s*;/.test(assistantMarkdownRule) &&
    /overflow-x\s*:\s*clip\s*!important\s*;/.test(assistantMarkdownRule) &&
    !/overflow-y\s*:/.test(assistantMarkdownRule),
    'assistant markdown roots must not become nested vertical scrollers; host overflow-x:hidden computes into wheel-catching overflow-y:auto in long replies, so prose must flow through the transcript scroller');
  assert.ok(inputRule.includes('--focus-ring-color: transparent !important;') &&
    inputRule.includes('border-color: transparent !important;') &&
    inputRule.includes('outline: none !important;') &&
    warmInputRule.includes('--focus-ring-color: transparent !important;') &&
    warmInputRule.includes('border-color: transparent !important;') &&
    warmInputRule.includes('outline: none !important;') &&
    theme.includes('fieldset[class*="inputContainer_"][data-permission-mode]:focus-within') &&
    warm.includes('fieldset[class*="inputContainer_"][data-permission-mode]:focus-within'),
    'composer input shell must not draw a focus/permission-state frame; only the caret inside the host editor should change on click');
  assert.ok(!/border\s*:|box-sizing\s*:|width\s*:|max-width\s*:|min-width\s*:|min-inline-size\s*:|transition\s*:|box-shadow\s*:|background(?:-color)?\s*:/.test(inputRule),
    'input container itself must not carry metric/layout/transition styling; long scrollable composer text uses that host box for caret and mirror geometry');
  assert.ok(!theme.includes('fieldset[class*="inputContainer_"] {\n  position: relative !important;') &&
    theme.includes('fieldset[class*="inputContainer_"][data-incipit-file-drag-hint="over"],') &&
    theme.includes('position: relative !important;'),
    'plain typing state must not position the host input container; only the temporary drag hint needs a containing block');
  assert.ok(!warm.includes('data-incipit-composer-empty') &&
    !warm.includes('[class*="mentionMirror"]') &&
    !warm.includes('--app-mention-chip-background') &&
    !warm.includes('--app-mention-chip-foreground') &&
    !composerTextSelector.test(warm),
    'warm-white override must not reintroduce composer text-layer styling');
  assert.ok(theme.includes('--app-primary-foreground: var(--ink-text-primary) !important;') &&
    theme.includes('--app-input-foreground: var(--ink-text-primary) !important;') &&
    theme.includes('--app-input-secondary-foreground: var(--ink-text-primary) !important;') &&
    theme.includes('--ink-text-primary: #f8f8f6;') &&
    warm.includes('--ink-text-primary: #0d0d0d;') &&
    shared.includes("'--app-input-foreground': SOFT_FG") &&
    shared.includes("'--app-input-secondary-foreground': SOFT_FG"),
    'host input foreground tokens must match the transcript body foreground in each palette');
  assert.ok(!shared.includes('--app-mention-chip-background') &&
    !shared.includes('--app-mention-chip-foreground'),
    'runtime app-var overrides must not recolor official composer mention chips');
  assert.ok(theme.includes('--incipit-composer-mention-chip-background: var(--ink-chip-bg);') &&
    theme.includes('--incipit-composer-mention-chip-foreground: var(--ink-chip-fg);') &&
    theme.includes('--incipit-composer-mention-chip-background-hover: var(--ink-chip-bg-hover);') &&
    theme.includes('--ink-chip-bg: #3d312d;') &&
    theme.includes('--ink-chip-fg: #e0a18b;') &&
    theme.includes('--ink-chip-bg-hover: #493932;') &&
    warm.includes('--ink-chip-bg: #ead8cf;') &&
    warm.includes('--ink-chip-fg: #8f452b;') &&
    warm.includes('--ink-chip-bg-hover: #e2c8bc;'),
    'composer mention chip retone must use incipit-scoped palette variables');
  assert.ok(composerChip.includes('background: var(--incipit-composer-mention-chip-background) !important;') &&
    composerChip.includes('background-color: var(--incipit-composer-mention-chip-background) !important;') &&
    composerChip.includes('color: var(--incipit-composer-mention-chip-foreground) !important;') &&
    composerChip.includes('box-shadow:') &&
    !/display\s*:|position\s*:|overflow\s*:|line-height\s*:|font-|caret-|visibility\s*:|opacity\s*:/m.test(composerChip),
    'composer mention chip rule may retint only, without taking over text or layout');
  assert.ok(theme.includes('fieldset[class*="inputContainer_"] [class*="inputMentionChip"]:hover') &&
    theme.includes('fieldset[class*="inputContainer_"] [class*="inputMentionChip"] *') &&
    !shared.includes('--incipit-composer-mention-chip'),
    'composer mention chip color is static CSS only, not runtime app-var mutation');
  assert.ok(theme.includes('--incipit-message-mention-chip-background') &&
    theme.includes('var(--incipit-message-mention-chip-background)') &&
    theme.includes('var(--incipit-message-mention-chip-foreground)'),
    'transcript mention chips must use incipit-scoped variables instead of app mention-chip variables');
  ok('composer text layer: official host owns messageInput, mirror, and placeholder; incipit only retints reference chips');
})();

(function attachmentChipsReuseBubbleVisualAndPreview() {
  const strip = functionBody('renderDeferredAttachmentStrip', 4600);
  // Reuse the user-bubble inline editor's chip CSS family + its
  // standalone fullscreen preview — same look, same behaviour, ZERO
  // changes to that battle-tested path.
  assert.ok(strip.includes("strip.className = 'incipit-edit-chip-strip'") &&
    strip.includes("chip.className = 'incipit-edit-chip'") &&
    strip.includes("chip.classList.add('incipit-edit-chip--image')") &&
    strip.includes("img.className = 'incipit-edit-chip-thumb'") &&
    strip.includes("x.className = 'incipit-edit-chip-x'") &&
    strip.includes("add.className = 'incipit-edit-chip-add'"),
    'chips must reuse the .incipit-edit-chip* visual language, not a parallel skin');
  assert.ok(strip.includes('openImagePreview(att.dataUrl)'),
    'clicking an image chip must open the SAME shared fullscreen preview');
  assert.ok(strip.includes("chip.setAttribute('role', 'button')") &&
    strip.includes("chip.setAttribute('tabindex', '0')") &&
    strip.includes("ev.key !== 'Enter' && ev.key !== ' '"),
    'image chip must be keyboard-activatable (a11y parity with the bubble)');
  assert.ok(strip.includes('CHIP_FILE_ICON_SVG') &&
    strip.includes("label.className = 'incipit-edit-chip-label'"),
    'non-image / no-dataUrl attachment must fall back to a neutral labelled chip');
  // The old parallel skin + its CSS/JS hooks must be retired.
  assert.ok(!legacy.includes('data-incipit-deferred-next-attachment="image"') &&
    !legacy.includes('data-incipit-deferred-next-chip-x') &&
    !legacy.includes('data-incipit-deferred-next-edit-attach'),
    'the perfunctory parallel attachment skin must be gone');
  assert.ok(!theme.includes('[data-incipit-deferred-next-chip-x]') &&
    !theme.includes('[data-incipit-deferred-next-edit-attach]') &&
    theme.includes('[data-incipit-deferred-next] .incipit-edit-chip-strip'),
    'dead chip CSS removed; chip strip scoped to the shared family');
  ok('attachment chips: reuse bubble chip skin + preview + a11y, no parallel copy');
})();

(function appliedGuiCopyIsBilingual() {
  // Project convention (revised): incipit-wide i18n means every panel,
  // including the applied in-editor GUI, follows CFG.language (EN/ZH) —
  // not just the CLI. The old English-only scaffold rule is overridden;
  // DEFERRED_NEXT_TEXT is a bilingual {en, zh} map like every other
  // localized dictionary in this file (see LEGACY_STR, CHANGE_REVIEW_TEXT).
  const dict = functionBody('deferredText', 700);
  assert.ok(legacy.includes('const DEFERRED_NEXT_TEXT = Object.freeze({') &&
    legacy.includes("guide: { en: 'Guide', zh: '引导' }") &&
    legacy.includes("cancel: { en: 'Cancel', zh: '取消' }"),
    'DEFERRED_NEXT_TEXT must be a bilingual {en, zh} map');
  assert.ok(dict.includes('CFG.language') && dict.includes('entry.en'),
    'deferredText must branch on CFG.language, falling back to English');
  ok('applied-GUI copy: bilingual EN/ZH, driven by CFG.language');
})();

(function genericPermissionRequestsUseThemeSkin() {
  assert.ok(theme.includes('Generic permission request panels.') &&
    theme.includes('[class*="permissionRequestContainer_"] {') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionRequestContainerBackground_"]') &&
    theme.includes('display: none !important;') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionRequestContent_"]') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionAction_"]') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionOption_"]') &&
    theme.includes('button:not([aria-label]):not(.incipit-ask-collapse-btn):not(.incipit-permission-collapse-btn):not([data-incipit-ask-collapsed-bar]):not([data-incipit-permission-collapsed-bar])') &&
    theme.includes('[class*="permissionRequestContainer_"] input:not([type="checkbox"]):not([type="radio"])') &&
    theme.includes('caret-color: var(--ink-permission-request-container-caret) !important;') &&
    theme.includes('--ink-permission-request-container-caret: #a8896e;'),
    'generic permission request panels must be themed, including Plan acceptance without questionsContainer');
  assert.ok(warm.includes('--ink-surface-panel: #ffffff;') &&
    warm.includes('--ink-permission-request-container-bg: #faf9f5;') &&
    warm.includes('--ink-permission-request-container-caret: #a8896e;') &&
    warm.includes('--ink-text-strong: #0d0d0d;'),
    'warm-white must override the semantic permission-panel tokens, not only AskUserQuestion');
  assert.ok(theme.includes('.incipit-permission-collapse-btn') &&
    theme.includes('[data-incipit-permission-floating-collapse] [class*="permissionRequestContent_"]') &&
    theme.includes('[data-incipit-permission-request][data-incipit-permission-collapsed="1"]') &&
    theme.includes('> .incipit-permission-collapsed-bar') &&
    warm.includes('--ink-permission-collapsed-bar-hover-bg: rgba(230,228,222,0.50);'),
    'generic permission request panels must share Ask collapse/expand styling through palette tokens');
  assert.ok(theme.includes('[class*="permissionRequestContainer_"]:has([class*="questionsContainer_"])') &&
    legacy.includes('function isPermissionRequestContainer(el)') &&
    legacy.includes('function closestPermissionRequestContainer(el)') &&
    legacy.includes("container.setAttribute('data-incipit-permission-request', '')") &&
    legacy.includes("container.setAttribute('data-incipit-permission-collapsed', '1')") &&
    legacy.includes("btn.setAttribute('data-incipit-permission-collapse-btn', '')") &&
    legacy.includes("bar.setAttribute('data-incipit-permission-collapsed-bar', '')") &&
    legacy.includes("container.setAttribute('data-incipit-permission-floating-collapse', '1')") &&
    legacy.includes('const nav = container.querySelector(ASK_NAV_SELECTOR);'),
    'collapse JS must decorate every permission request, with Ask retaining navigator-aware button placement');
  ok('permission request panels: Plan/Edit approvals share warm theme and Ask-style collapse');
})();

(function uiHasDarkAndWarmWhiteTreatment() {
  for (const sel of [
    '[data-incipit-deferred-next]',
    '[data-incipit-deferred-next-list]',
    '[data-incipit-deferred-row]',
    '[data-incipit-deferred-next-error]',
    '[data-incipit-deferred-dragging]',
    '[data-incipit-deferred-next-guide]',
    '[data-incipit-deferred-next-textarea]',
  ]) {
    assert.ok(theme.includes(sel), 'dark theme missing ' + sel);
  }
  for (const token of [
    '--ink-deferred-next-bg: #efeee9;',
    '--ink-deferred-next-error-bg: rgba(199,104,73,0.12);',
    '--ink-deferred-dragging-bg: rgba(13,13,13,0.05);',
    '--ink-deferred-next-textarea-bg: #f8f8f6;',
  ]) assert.ok(warm.includes(token), 'warm-white override missing ' + token);
  assert.ok(theme.includes('max-height: 168px') && theme.includes('overflow-y: auto'),
    'the queue list must cap height and scroll, not eat the panel');
  // Flattened summary action row: Edit + Delete are DIRECT icon
  // buttons. The old kebab held only Edit + "Close queue", where
  // "Close queue" was the literal same call as the trash button — a
  // redundant destructive duplicate hidden behind an extra tap.
  const summary = functionBody('renderDeferredNextSummary', 2600);
  assert.ok(summary.includes("makeDeferredIconButton('edit', deferredText('edit'), EDIT_ICON_SVG") &&
    summary.includes("makeDeferredIconButton('delete', deferredText('removeTitle'), TRASH_ICON_SVG"),
    'summary exposes Edit + Delete as direct icon buttons');
  assert.ok(!summary.includes('openActionDropdown') && !summary.includes('MORE_ICON_SVG') &&
    !legacy.includes("deferredText('close')") && !legacy.includes("deferredText('moreTitle')"),
    'the redundant kebab (Edit + duplicate-Delete) must be gone');
  ok('UI: shared queue structure + warm-white tokens, scroll cap, flattened action row');
})();

console.log('\ndeferred-next: ' + passed + ' checks PASSED');
