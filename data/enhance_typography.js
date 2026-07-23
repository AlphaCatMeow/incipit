import { SEL } from './host_probe.js';
import { renderMathInSegment as rewriteMathInSegment } from './math_rewriter.js';
import { collectMermaidBlocks, renderMermaidIn, MERMAID_GROUP_PALETTE } from './mermaid_render.js';
import { CFG, assetURL, loadCSS, loadJS, log, reportHealth, warn } from './enhance_shared.js';
import {
  bumpPerfCounter,
  conversationIsBusy as kernelConversationIsBusy,
  hasStreamDirty,
  markStreamDirty,
  scheduleIdleTask,
  subscribe,
  takeStreamDirtyRoots,
} from './runtime_kernel.js';

/**
 * Typography, math DOM rendering, CJK punctuation, and code highlighting.
 *
 * This module intentionally talks to the legacy transcript/diff surface only
 * through late-bound hooks. Bootstrap can import typography before or after
 * the legacy module without losing math/CJK/code work; when legacy arrives it
 * registers the richer transcript/copy callbacks and we seed one catch-up pass.
 */

const legacyHooks = {
  conversationIsBusy: null,
  noteTranscriptActionMutation: null,
  scanAndAddCopyButtons: null,
  sweepStreamingDisableState: null,
};

function hook(name) {
  const explicit = legacyHooks[name];
  if (typeof explicit === 'function') return explicit;
  const globalHooks = globalThis.__incipitLegacyHooks;
  const globalHook = globalHooks && globalHooks[name];
  return typeof globalHook === 'function' ? globalHook : null;
}

function conversationIsBusy() {
  try {
    const busy = kernelConversationIsBusy();
    if (busy === true) return true;
    if (busy === false) return false;
  }
  catch (_) {
    const fn = hook('conversationIsBusy');
    if (!fn) return domConversationLooksBusy();
    try { return !!fn(); }
    catch (e) {
      warn('conversationIsBusy hook failed:', e);
      return domConversationLooksBusy();
    }
  }
}

function domConversationLooksBusy() {
  try {
    return !!document.querySelector('[data-incipit-send-state="stop"], ' + SEL.stopIcon);
  } catch (_) {
    return false;
  }
}

function noteTranscriptActionMutation() {
  const fn = hook('noteTranscriptActionMutation');
  if (!fn) return;
  try { fn(); }
  catch (e) { warn('transcript mutation hook failed:', e); }
}

function scanAndAddCopyButtons(root, options = {}) {
  const fn = hook('scanAndAddCopyButtons');
  if (!fn) return;
  try { fn(root, options); }
  catch (e) { warn('copy/action scan hook failed:', e); }
}

function sweepStreamingDisableState() {
  const fn = hook('sweepStreamingDisableState');
  if (!fn) return;
  try { fn(); }
  catch (e) { warn('busy-state sweep hook failed:', e); }
}

export function configureTypographyHooks(hooks = {}) {
  for (const key of Object.keys(legacyHooks)) {
    if (typeof hooks[key] === 'function') legacyHooks[key] = hooks[key];
  }
}

function mermaidThemeVariables() {
  const P = MERMAID_GROUP_PALETTE;
  if (CFG.palette === 'ink-black') {
    return {
      darkMode: true,
      fontSize: '12px',
      background: '#0a0b0b',
      primaryColor: '#1c1d1e',
      primaryTextColor: '#fbfbfc',
      primaryBorderColor: '#a8a8a9',
      secondaryColor: '#232425',
      secondaryTextColor: '#fbfbfc',
      secondaryBorderColor: '#555657',
      tertiaryColor: '#2a2b2c',
      tertiaryTextColor: '#fbfbfc',
      tertiaryBorderColor: '#bd7a62',
      lineColor: '#a8a8a9',
      textColor: '#fbfbfc',
      mainBkg: '#1c1d1e',
      nodeBkg: '#1c1d1e',
      nodeBorder: '#a8a8a9',
      nodeTextColor: '#fbfbfc',
      edgeLabelBackground: '#1c1d1e',
      clusterBkg: '#232425',
      clusterBorder: '#555657',
      titleColor: '#fbfbfc',
      noteBkgColor: '#1c1d1e',
      noteTextColor: '#fbfbfc',
      noteBorderColor: '#bd7a62',
      actorBkg: '#1c1d1e',
      actorBorder: '#a8a8a9',
      actorTextColor: '#fbfbfc',
      actorLineColor: '#a8a8a9',
      labelBoxBkgColor: '#1c1d1e',
      labelBoxBorderColor: '#555657',
      labelTextColor: '#fbfbfc',
      loopTextColor: '#fbfbfc',
      signalColor: '#a8a8a9',
      signalTextColor: '#fbfbfc',
      activationBkgColor: '#232425',
      activationBorderColor: '#a8a8a9',
      sequenceNumberColor: '#0a0b0b',
      sectionBkgColor: '#232425',
      altSectionBkgColor: '#1c1d1e',
      sectionBkgColor2: '#2a2b2c',
      excludeBkgColor: '#141516',
      taskBkgColor: '#1c1d1e',
      taskBorderColor: '#a8a8a9',
      taskTextColor: '#fbfbfc',
      taskTextOutsideColor: '#fbfbfc',
      taskTextLightColor: '#fbfbfc',
      taskTextDarkColor: '#0a0b0b',
      activeTaskBkgColor: '#3a2c25',
      activeTaskBorderColor: '#bd7a62',
      doneTaskBkgColor: '#1e2a1e',
      doneTaskBorderColor: '#7cb27c',
      critBkgColor: '#3a2c25',
      critBorderColor: '#bd7a62',
      gridColor: '#555657',
      pieTitleTextColor: '#fbfbfc',
      pieSectionTextColor: '#fbfbfc',
      pieLegendTextColor: '#fbfbfc',
      pieStrokeColor: '#0a0b0b',
      pieOuterStrokeColor: '#0a0b0b',
      pieStrokeWidth: '2px',
      pieOuterStrokeWidth: '2px',
      pieOpacity: '0.88',
      pie0: P[0], pie1: P[1], pie2: P[2], pie3: P[3], pie4: P[4], pie5: P[5],
      pie6: P[6], pie7: P[7], pie8: P[8], pie9: P[9], pie10: P[10], pie11: P[11],
      cScale0: P[0], cScale1: P[1], cScale2: P[2], cScale3: P[3], cScale4: P[4],
      cScale5: P[5], cScale6: P[6], cScale7: P[7], cScale8: P[8], cScale9: P[9],
      classText: '#fbfbfc',
      stateLabelColor: '#fbfbfc',
      transitionLabelColor: '#fbfbfc',
      relationLabelColor: '#fbfbfc',
      branchLabelColor: '#0a0b0b',
      commitLabelColor: '#fbfbfc',
      commitLabelBackground: '#232425',
    };
  }
  if (CFG.palette === 'warm-white') {
    return {
      darkMode: false,
      // Smaller than body copy: diagrams read as dense captions, not headings.
      fontSize: '12px',
      background: '#f8f8f6',
      primaryColor: '#fffaf0',
      primaryTextColor: '#0d0d0d',
      primaryBorderColor: '#7a7166',
      secondaryColor: '#f1e8df',
      secondaryTextColor: '#0d0d0d',
      secondaryBorderColor: '#948779',
      tertiaryColor: '#ead8cf',
      tertiaryTextColor: '#321f18',
      tertiaryBorderColor: '#bf5d3a',
      lineColor: '#746d64',
      textColor: '#0d0d0d',
      mainBkg: '#fffaf0',
      nodeBkg: '#fffaf0',
      nodeBorder: '#7a7166',
      nodeTextColor: '#0d0d0d',
      edgeLabelBackground: '#f3eadf',
      clusterBkg: '#f1e8df',
      clusterBorder: '#c6baab',
      titleColor: '#0d0d0d',
      noteBkgColor: '#f1e1d8',
      noteTextColor: '#0d0d0d',
      noteBorderColor: '#bf5d3a',
      actorBkg: '#fffaf0',
      actorBorder: '#7a7166',
      actorTextColor: '#0d0d0d',
      actorLineColor: '#746d64',
      labelBoxBkgColor: '#f3eadf',
      labelBoxBorderColor: '#c6baab',
      labelTextColor: '#0d0d0d',
      loopTextColor: '#0d0d0d',
      signalColor: '#746d64',
      signalTextColor: '#0d0d0d',
      activationBkgColor: '#f1e8df',
      activationBorderColor: '#7a7166',
      sequenceNumberColor: '#f8f8f6',
      sectionBkgColor: '#f1e8df',
      altSectionBkgColor: '#fffaf0',
      sectionBkgColor2: '#ead8cf',
      excludeBkgColor: '#e6e4de',
      taskBkgColor: '#fffaf0',
      taskBorderColor: '#7a7166',
      taskTextColor: '#0d0d0d',
      taskTextOutsideColor: '#0d0d0d',
      taskTextLightColor: '#0d0d0d',
      taskTextDarkColor: '#0d0d0d',
      activeTaskBkgColor: '#ead8cf',
      activeTaskBorderColor: '#bf5d3a',
      doneTaskBkgColor: '#e4ede0',
      doneTaskBorderColor: '#718c5e',
      critBkgColor: '#ead8cf',
      critBorderColor: '#bf5d3a',
      gridColor: '#cfc5b7',
      pieTitleTextColor: '#0d0d0d',
      pieSectionTextColor: '#0d0d0d',
      pieLegendTextColor: '#0d0d0d',
      pieStrokeColor: '#f8f8f6',
      pieOuterStrokeColor: '#f8f8f6',
      pieStrokeWidth: '2px',
      pieOuterStrokeWidth: '2px',
      pieOpacity: '0.86',
      pie0: P[0], pie1: P[1], pie2: P[2], pie3: P[3], pie4: P[4], pie5: P[5],
      pie6: P[6], pie7: P[7], pie8: P[8], pie9: P[9], pie10: P[10], pie11: P[11],
      cScale0: P[0], cScale1: P[1], cScale2: P[2], cScale3: P[3], cScale4: P[4],
      cScale5: P[5], cScale6: P[6], cScale7: P[7], cScale8: P[8], cScale9: P[9],
      classText: '#0d0d0d',
      stateLabelColor: '#0d0d0d',
      transitionLabelColor: '#0d0d0d',
      relationLabelColor: '#0d0d0d',
      branchLabelColor: '#0d0d0d',
      commitLabelColor: '#0d0d0d',
      commitLabelBackground: '#f1eee8',
    };
  }
  return {
    darkMode: true,
    fontSize: '12px',
    background: '#1f1f1e',
    primaryColor: '#2d2a26',
    primaryTextColor: '#f8f8f6',
    primaryBorderColor: '#a99b8d',
    secondaryColor: '#34302b',
    secondaryTextColor: '#f0eee8',
    secondaryBorderColor: '#8f8579',
    tertiaryColor: '#4b372f',
    tertiaryTextColor: '#f8f8f6',
    tertiaryBorderColor: '#bd7a62',
    lineColor: '#b8aea2',
    textColor: '#f8f8f6',
    mainBkg: '#2d2a26',
    nodeBkg: '#2d2a26',
    nodeBorder: '#a99b8d',
    nodeTextColor: '#f8f8f6',
    edgeLabelBackground: '#302c27',
    clusterBkg: '#282622',
    clusterBorder: '#6f665b',
    titleColor: '#f8f8f6',
    noteBkgColor: '#2f2925',
    noteTextColor: '#f8f8f6',
    noteBorderColor: '#bd7a62',
    actorBkg: '#2d2a26',
    actorBorder: '#a99b8d',
    actorTextColor: '#f8f8f6',
    actorLineColor: '#b8aea2',
    labelBoxBkgColor: '#302c27',
    labelBoxBorderColor: '#6f665b',
    labelTextColor: '#f8f8f6',
    loopTextColor: '#f8f8f6',
    signalColor: '#b8aea2',
    signalTextColor: '#f8f8f6',
    activationBkgColor: '#34302b',
    activationBorderColor: '#a99b8d',
    sequenceNumberColor: '#1f1f1e',
    sectionBkgColor: '#2b2824',
    altSectionBkgColor: '#34302b',
    sectionBkgColor2: '#4b372f',
    excludeBkgColor: '#2f2a25',
    taskBkgColor: '#2d2a26',
    taskBorderColor: '#a99b8d',
    taskTextColor: '#f8f8f6',
    taskTextOutsideColor: '#f8f8f6',
    taskTextLightColor: '#f8f8f6',
    taskTextDarkColor: '#1f1f1e',
    activeTaskBkgColor: '#493932',
    activeTaskBorderColor: '#bd7a62',
    doneTaskBkgColor: '#303a30',
    doneTaskBorderColor: '#7cb27c',
    critBkgColor: '#493932',
    critBorderColor: '#bd7a62',
    gridColor: '#48433c',
    pieTitleTextColor: '#f8f8f6',
    pieSectionTextColor: '#f8f8f6',
    pieLegendTextColor: '#f8f8f6',
    pieStrokeColor: '#1f1f1e',
    pieOuterStrokeColor: '#1f1f1e',
    pieStrokeWidth: '2px',
    pieOuterStrokeWidth: '2px',
    pieOpacity: '0.88',
    pie0: P[0], pie1: P[1], pie2: P[2], pie3: P[3], pie4: P[4], pie5: P[5],
    pie6: P[6], pie7: P[7], pie8: P[8], pie9: P[9], pie10: P[10], pie11: P[11],
    cScale0: P[0], cScale1: P[1], cScale2: P[2], cScale3: P[3], cScale4: P[4],
    cScale5: P[5], cScale6: P[6], cScale7: P[7], cScale8: P[8], cScale9: P[9],
    classText: '#f8f8f6',
    stateLabelColor: '#f8f8f6',
    transitionLabelColor: '#f8f8f6',
    relationLabelColor: '#f8f8f6',
    branchLabelColor: '#1f1f1e',
    commitLabelColor: '#f8f8f6',
    commitLabelBackground: '#282826',
  };
}

const HLJS_THEME_FILES = Object.freeze({
  'warm-black': 'hljs/styles/vs2015.min.css',
  'ink-black': 'hljs/styles/vs2015.min.css',
  'warm-white': 'hljs/styles/vs.min.css',
});

const assets = (() => {
  let katexPromise = null;
  let hljsPromise = null;
  let mermaidPromise = null;

  return {
    mermaid() {
      if (!mermaidPromise) {
        reportHealth('asset.mermaid', 'loading');
        mermaidPromise = loadJS(assetURL('mermaid/mermaid.min.js')).then(() => {
          // The vendored esbuild IIFE exposes the module namespace at
          // `window.__esbuild_esm_mermaid_nm.mermaid`; the live API (with
          // `.render`/`.initialize`) is its `.default`. Verified against the
          // pinned 11.15.0 bundle — normalise to a single `window.mermaid`.
          const ns = window.__esbuild_esm_mermaid_nm && window.__esbuild_esm_mermaid_nm.mermaid;
          const m = (ns && (ns.default || ns)) || window.mermaid;
          if (!m || typeof m.render !== 'function') {
            throw new Error('mermaid loaded but API missing');
          }
          window.mermaid = m;
          let bodyFont = 'inherit';
          try {
            const cs = getComputedStyle(document.documentElement);
            const v = (cs.getPropertyValue('--incipit-body-font') || '').trim();
            if (v) bodyFont = v;
          } catch (_) {}
          m.initialize({
            startOnLoad: false,
            // strict: no script exec, sanitized SVG, HTML labels escaped.
            securityLevel: 'strict',
            // Never let mermaid draw its own error diagram on parse failure —
            // we fall back to the raw code block instead.
            suppressErrorRendering: true,
            theme: 'base',
            themeVariables: mermaidThemeVariables(),
            fontFamily: bodyFont,
          });
          log('mermaid ready');
          reportHealth('asset.mermaid', 'ok');
          return m;
        }).catch(e => {
          reportHealth('asset.mermaid', 'error', { message: e && e.message ? e.message : String(e) });
          warn('mermaid load failed:', e);
          throw e;
        });
      }
      return mermaidPromise;
    },
    katex() {
      if (!katexPromise) {
        reportHealth('asset.katex', 'loading');
        katexPromise = Promise.all([
          loadCSS(assetURL('katex/katex.min.css')),
          loadJS(assetURL('katex/katex.min.js')),
        ]).then(() => {
          if (typeof window.katex === 'undefined') {
            throw new Error('KaTeX loaded but window.katex missing');
          }
          log('KaTeX ready');
          reportHealth('asset.katex', 'ok');
        }).catch(e => {
          reportHealth('asset.katex', 'error', { message: e && e.message ? e.message : String(e) });
          warn('KaTeX load failed:', e);
          throw e;
        });
      }
      return katexPromise;
    },
    hljs() {
      if (!hljsPromise) {
        reportHealth('asset.hljs', 'loading');
        const themeFile = HLJS_THEME_FILES[CFG.palette];
        hljsPromise = Promise.all([
          loadCSS(assetURL(themeFile)),
          loadJS(assetURL('hljs/highlight.min.js')),
        ]).then(() => {
          if (typeof window.hljs === 'undefined') {
            throw new Error('hljs loaded but window.hljs missing');
          }
          log('highlight.js ready (' + themeFile + ')');
          reportHealth('asset.hljs', 'ok', { themeFile });
        }).catch(e => {
          reportHealth('asset.hljs', 'error', { message: e && e.message ? e.message : String(e) });
          warn('hljs load failed:', e);
          throw e;
        });
      }
      return hljsPromise;
    },
  };
})();

// 32-bit FNV-1a with no dependencies.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function isKatexReady() {
  return typeof window.katex !== 'undefined';
}

let katexLoadRequested = false;

function ensureKatexLoaded() {
  if (!CFG.math || isKatexReady() || katexLoadRequested) return;
  katexLoadRequested = true;
  assets.katex().then(() => {
    schedule();
  }).catch(() => { /* Already warned by assets.katex(). */ });
}

// ========== 3. math-rewriter ==========

// Apply narrow TeX fixes only for cases that are known to break rendering.
//
// 1. Display mode: normalise matrix and alignment newlines into `\\\n`.
// 2. `demoteLeftRightAroundBraces`: when a token contains `\underbrace`
//    or `\overbrace`, strip every `\left` / `\right` modifier from its
//    delimiters. KaTeX's auto-sizing reads the max depth of enclosed
//    content to pick a delimiter size, and a brace label inflates that
//    depth enough to jump straight to `delim-size4` (absurdly large
//    parens around a short formula). The classic `\smash[b]{}` trick
//    works in real LaTeX but KaTeX's implementation crops the smashed
//    depth visually, taking the label with it. Removing `\left\right`
//    drops us back to the literal delimiter characters at their natural
//    size — which is exactly what classical TeX typesetting (and the
//    Google AI Studio reference rendering) does for a labelled-brace
//    expression. For expressions with genuinely tall content that need
//    auto-sized delimiters, the label-brace shape is rare enough in
//    long-form prose that the trade-off is net positive.
function fixTeX(tex, display) {
  let fixed = demoteLeftRightAroundBraces(tex);
  if (display) {
    fixed = fixed.replace(/([^\\])\\\s*\n/g, '$1\\\\\n');
  }
  return fixed;
}

// Only the common delimiter pairs are handled. `\left.` (invisible) is
// intentionally left alone because replacing it with a literal `.` would
// introduce a visible dot; any expression that opens with `\left.` is
// outside the "labelled brace in prose" scenario this fix targets.
const LEFT_RIGHT_SUBSTITUTIONS = [
  [/\\left\(/g, '('],
  [/\\right\)/g, ')'],
  [/\\left\[/g, '['],
  [/\\right\]/g, ']'],
  [/\\left\\\{/g, '\\{'],
  [/\\right\\\}/g, '\\}'],
  [/\\left\|/g, '|'],
  [/\\right\|/g, '|'],
  [/\\left\\lvert\b/g, '\\lvert'],
  [/\\right\\rvert\b/g, '\\rvert'],
  [/\\left\\langle\b/g, '\\langle'],
  [/\\right\\rangle\b/g, '\\rangle'],
];

function demoteLeftRightAroundBraces(tex) {
  if (typeof tex !== 'string' || tex.length === 0) return tex;
  if (tex.indexOf('\\underbrace') === -1 && tex.indexOf('\\overbrace') === -1) {
    return tex;
  }
  let fixed = tex;
  for (const [pattern, replacement] of LEFT_RIGHT_SUBSTITUTIONS) {
    fixed = fixed.replace(pattern, replacement);
  }
  return fixed;
}

const ENV_TEX_PROBE_RE = /\\begin\{[A-Za-z]+\*?\}/;

function renderTokenToNode(tok) {
  const node = document.createElement(tok.display ? 'div' : 'span');
  node.setAttribute('data-tex-source', tok.tex);
  node.setAttribute('data-tex-display', tok.display ? '1' : '0');
  // Tex containing a LaTeX environment (matrix/align/cases/...) is marked
  // so theme.css can pin its font-size to body scale. Without this an
  // inline env embedded in a heading inherits heading em scaling, which
  // compounds with KaTeX's own 1.21× factor and balloons the 2D delimiter
  // layout visually. Detection is content-based so env math picked up via
  // bare `\begin..\end`, `$..$`, or `$$..$$` all receive the same treatment.
  if (ENV_TEX_PROBE_RE.test(tok.tex)) {
    node.setAttribute('data-tex-kind', 'env');
  }
  node.className = 'claude-math';
  try {
    node.innerHTML = window.katex.renderToString(
      fixTeX(tok.tex, tok.display),
      {
        displayMode: tok.display,
        throwOnError: false,
        strict: 'ignore',
        output: 'html',
        trust: false,
      },
    );
  } catch (e) {
    warn('KaTeX render error:', (e && e.message) || e, 'tex:', tok.tex);
    node.setAttribute('data-render-error', (e && e.message) || 'unknown');
    node.textContent =
      (tok.display ? '$$' : '$') + tok.tex + (tok.display ? '$$' : '$');
  }
  return node;
}

function renderMathInSegment(segment) {
  if (!CFG.math) {
    return { complete: true, mutated: false };
  }
  if (!isKatexReady()) {
    return { complete: false, mutated: false };
  }
  try {
    return rewriteMathInSegment(segment, renderTokenToNode);
  } catch (e) {
    warn('renderMathInSegment failed:', e);
    return { complete: true, mutated: false };
  }
}

// Diff text is source text, not prose. It must not be touched by the math
// renderer or by the CJK punctuation pass, even when it contains markdown,
// TeX delimiters, or a live placeholder-looking string.
const DIFF_MATH_BLOCK_SELECTOR = [
  '[data-incipit-diff-island]',
  '[data-incipit-write-diff]',
  '[data-incipit-write-diff-modal]',
  '[class*="diffEditorWrapper"]',
  '[class*="diffEditorContainer"]',
  '.monaco-diff-editor',
].join(', ');
const HOST_DIFF_MODAL_SELECTOR = '[class*="modalContent_"]';
const HOST_DIFF_MODAL_CONTENT_SELECTOR = '[class*="diffEditorContainer"], .monaco-diff-editor';
// Incipit-owned transcript widgets are not assistant prose. Their internal
// rebuilds must not wake the legacy transcript action settle scanner, or a
// review render can feed back into action-row placement and back into review
// render again.
const TRANSCRIPT_ACTION_MUTATION_IGNORED_SELECTOR = [
  '[data-incipit-change-review-turn]',
].join(', ');

function isDiffSurfaceNode(node) {
  let el = node;
  if (el && el.nodeType !== 1) el = el.parentElement;
  if (!el || !el.closest) return false;
  if (el.closest(DIFF_MATH_BLOCK_SELECTOR)) return true;
  const modal = el.closest(HOST_DIFF_MODAL_SELECTOR);
  return !!(modal && modal.querySelector && modal.querySelector(HOST_DIFF_MODAL_CONTENT_SELECTOR));
}

function isTranscriptActionIgnoredMutationNode(node) {
  let el = node;
  if (el && el.nodeType !== 1) el = el.parentElement;
  if (!el || !el.matches || !el.closest) return false;
  return !!(
    el.matches(TRANSCRIPT_ACTION_MUTATION_IGNORED_SELECTOR) ||
    el.closest(TRANSCRIPT_ACTION_MUTATION_IGNORED_SELECTOR)
  );
}

function mutationTouchesIgnoredTranscriptActionSurface(mutation) {
  if (isTranscriptActionIgnoredMutationNode(mutation.target)) return true;
  const lists = [mutation.addedNodes, mutation.removedNodes];
  let sawNode = false;
  for (const list of lists) {
    for (const node of list) {
      sawNode = true;
      if (!isTranscriptActionIgnoredMutationNode(node)) return false;
    }
  }
  return sawNode;
}

// ========== 4b. Table `<br>` visual breaks ==========
//
// Markdown tables cannot receive real newlines in the source preprocessor:
// that would split the row. Treat literal <br> tokens as a narrow visual
// affordance only, and keep a hidden source token so DOM text fallbacks still
// read like the original markdown.
const TABLE_BR_TEXT_RE = /<br\s*\/?>/i;
const TABLE_BR_SPLIT_RE = /<br\s*\/?>/ig;
const TABLE_BR_NODE_ATTR = 'data-incipit-table-br';
const TABLE_BR_SOURCE_ATTR = 'data-incipit-table-br-source';
const TABLE_BR_SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'BUTTON',
  'SVG', 'MATH',
]);

function shouldSkipTableBreakSubtree(el) {
  if (!el || el.nodeType !== 1) return true;
  if (TABLE_BR_SKIP_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
  if (isDiffSurfaceNode(el)) return true;
  if (el.hasAttribute && (
        el.hasAttribute(TABLE_BR_NODE_ATTR) ||
        el.hasAttribute(TABLE_BR_SOURCE_ATTR) ||
        el.hasAttribute('data-tex-source')
      )) return true;
  if (el.classList) {
    if (el.classList.contains('katex')) return true;
    if (el.classList.contains('claude-math')) return true;
  }
  return false;
}

function isAssistantTableBreakCell(cell) {
  if (!cell || cell.nodeType !== 1) return false;
  if (cell.tagName !== 'TD' && cell.tagName !== 'TH') return false;
  if (!cell.closest || !cell.closest('table')) return false;
  const markdownRoot = cell.closest(SEL.markdownRoot);
  if (!markdownRoot) return false;
  if (cell.isContentEditable || cell.closest('[contenteditable="true"]')) return false;
  if (isDiffSurfaceNode(cell)) return false;
  return !cell.closest([
    SEL.userBubble,
    SEL.toolUse,
    SEL.toolBody,
    SEL.thinking,
    SEL.thinkingSummary,
    SEL.thinkingContent,
  ].join(', '));
}

function collectTableBreakCells(root) {
  let scope = root;
  if (scope && scope.nodeType !== 1) scope = scope.parentElement;
  if (!scope || scope.nodeType !== 1) return [];
  if (shouldSkipTableBreakSubtree(scope) && !isAssistantTableBreakCell(scope)) return [];
  const cells = [];
  const add = cell => {
    if (isAssistantTableBreakCell(cell)) cells.push(cell);
  };
  if (scope.matches && scope.matches('td, th')) add(scope);
  if (scope.querySelectorAll) {
    for (const cell of scope.querySelectorAll('td, th')) add(cell);
  }
  return cells;
}

function splitTextNodeForTableBreak(textNode) {
  const value = textNode.nodeValue || '';
  if (!TABLE_BR_TEXT_RE.test(value)) return false;
  const parent = textNode.parentNode;
  if (!parent) return false;

  TABLE_BR_SPLIT_RE.lastIndex = 0;
  let match;
  let firstBreak = -1;
  let cursor = 0;
  const toInsert = [];
  while ((match = TABLE_BR_SPLIT_RE.exec(value))) {
    if (firstBreak === -1) {
      firstBreak = match.index;
      cursor = match.index;
    }
    if (match.index > cursor) {
      toInsert.push(document.createTextNode(value.slice(cursor, match.index)));
    }
    const source = document.createElement('span');
    source.setAttribute(TABLE_BR_SOURCE_ATTR, '');
    source.setAttribute('aria-hidden', 'true');
    source.hidden = true;
    source.textContent = match[0];
    toInsert.push(source);

    const br = document.createElement('br');
    br.setAttribute(TABLE_BR_NODE_ATTR, '');
    toInsert.push(br);
    cursor = match.index + match[0].length;
  }
  TABLE_BR_SPLIT_RE.lastIndex = 0;
  if (firstBreak === -1) return false;
  if (cursor < value.length) {
    toInsert.push(document.createTextNode(value.slice(cursor)));
  }

  const anchor = textNode.nextSibling;
  textNode.nodeValue = value.slice(0, firstBreak);
  for (const node of toInsert) {
    parent.insertBefore(node, anchor);
  }
  return true;
}

function renderTableBreaksInCell(cell) {
  if (!cell || !cell.isConnected) return false;
  if (!isAssistantTableBreakCell(cell)) return false;
  const candidates = [];
  const walker = document.createTreeWalker(
    cell,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const value = node.nodeValue || '';
        if (!TABLE_BR_TEXT_RE.test(value)) return NodeFilter.FILTER_REJECT;
        let p = node.parentElement;
        while (p && p !== cell) {
          if (shouldSkipTableBreakSubtree(p)) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  let textNode;
  while ((textNode = walker.nextNode())) candidates.push(textNode);

  let mutated = false;
  for (const node of candidates) {
    if (!node.isConnected) continue;
    if (splitTextNodeForTableBreak(node)) mutated = true;
  }
  return mutated;
}

function renderTableBreakTextNodes(root) {
  const cells = collectTableBreakCells(root);
  if (!cells.length) return false;
  let mutated = false;
  for (const cell of cells) {
    if (renderTableBreaksInCell(cell)) mutated = true;
  }
  return mutated;
}

function runTableBreakScan() {
  if (conversationIsBusy()) return;
  const root = attachedMessagesRoot || document.querySelector(MESSAGES_ROOT_SELECTOR) || document.body;
  if (!root) return;
  renderTableBreakTextNodes(root);
}

function scheduleTableBreakScan(reason = 'deferred') {
  scheduleIdleTask('typography.tableBreakScan', () => {
    try { runTableBreakScan(); }
    catch (e) { warn('table <br> scan failed:', e); }
  }, {
    delay: reason === 'assistantTurnFinalized' ? 80 : STREAMING_TYPOGRAPHY_RECHECK_MS,
    timeout: 1200,
  });
}

// ========== 4c. CJK ↔ ASCII punctuation spacing ==========
//
// Some Chromium and Electron builds do not apply `text-autospace`
// consistently. This walker wraps ASCII punctuation that touches CJK text
// in `<span class="claude-punc">` so CSS can add spacing.
//
// The wrapped span still contains the original punctuation character, so
// `textContent` stays unchanged. Existing `.claude-punc` nodes are skipped.
const CJK_RANGE_RE = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f]/;
// Limit the set to punctuation that commonly needs spacing next to CJK.
// Exclude `-`, `_`, quotes, and `/` to avoid noisy false positives.
const PUNCT_CHARS = new Set([',', '.', ':', ';', '!', '?', '(', ')']);
const PUNCT_SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'BUTTON',
  'SVG', 'MATH',
]);

function shouldSkipPunctSubtree(el) {
  if (!el || el.nodeType !== 1) return true;
  if (PUNCT_SKIP_TAGS.has(el.tagName)) return true;
  // Skip contenteditable subtrees as a second line of defense.
  if (el.isContentEditable) return true;
  if (isDiffSurfaceNode(el)) return true;
  if (el.classList) {
    if (el.classList.contains('katex')) return true;
    if (el.classList.contains('claude-math')) return true;
    if (el.classList.contains('claude-punc')) return true;
    if (el.classList.contains('claude-user-copy-btn')) return true;
    if (el.classList.contains('claude-user-copy-btn-row')) return true;
    if (el.classList.contains('claude-show-more-row')) return true;
    if (el.classList.contains('claude-show-more-btn')) return true;
  }
  if (el.hasAttribute && el.hasAttribute('data-tex-source')) return true;
  return false;
}

function findPunctBoundaries(text) {
  const boundaries = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!PUNCT_CHARS.has(ch)) continue;
    const prev = i > 0 ? text[i - 1] : '';
    const next = i < text.length - 1 ? text[i + 1] : '';
    // Only touch punctuation that borders at least one CJK character.
    if (CJK_RANGE_RE.test(prev) || CJK_RANGE_RE.test(next)) {
      boundaries.push(i);
    }
  }
  return boundaries;
}

function splitTextNodeForPunct(textNode) {
  const value = textNode.nodeValue || '';
  const boundaries = findPunctBoundaries(value);
  if (boundaries.length === 0) return false;

  const parent = textNode.parentNode;
  if (!parent) return false;

  // Do not replace the original text node. React may still hold references
  // to it for later incremental updates. Shrink the original node in place
  // and insert the new nodes beside it instead.
  const firstBoundary = boundaries[0];
  const prefix = value.slice(0, firstBoundary);
  const anchor = textNode.nextSibling; // May be `null`, which means append.

  // Build all replacement nodes before mutating the DOM.
  const toInsert = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const idx = boundaries[i];
    const span = document.createElement('span');
    span.className = 'claude-punc';
    span.textContent = value[idx];
    toInsert.push(span);

    const sliceStart = idx + 1;
    const sliceEnd = i + 1 < boundaries.length ? boundaries[i + 1] : value.length;
    if (sliceEnd > sliceStart) {
      toInsert.push(document.createTextNode(value.slice(sliceStart, sliceEnd)));
    }
  }

  // Shorten the original text node only after the replacement nodes exist.
  textNode.nodeValue = prefix;

  for (const node of toInsert) {
    parent.insertBefore(node, anchor);
  }
  return true;
}

function padCjkPunctInSegment(segment) {
  if (!segment || !segment.isConnected) return false;
  // Recheck contenteditable state even though `closestSegment` already gates it.
  if (segment.isContentEditable) return false;
  if (isDiffSurfaceNode(segment)) return false;
  // Collect candidates first, then mutate. Editing during traversal would
  // destabilize the walk.
  const candidates = [];
  const stack = [segment];
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType === 3) {
      const v = node.nodeValue || '';
      if (v.length >= 2 && CJK_RANGE_RE.test(v)) {
        candidates.push(node);
      }
      continue;
    }
    if (node.nodeType !== 1) continue;
    if (node !== segment && shouldSkipPunctSubtree(node)) continue;
    for (const child of node.childNodes) stack.push(child);
  }
  let mutated = false;
  for (const textNode of candidates) {
    if (!textNode.isConnected) continue;
    if (splitTextNodeForPunct(textNode)) mutated = true;
  }
  return mutated;
}

// ========== 5. segment-processor ==========

const SEG_VERSION_ATTR = 'data-math-rendered';
const SEG_HASH_ATTR    = 'data-math-hash';
const SEG_VERSION      = 'v18';
const SEG_SELECTOR     = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, dd, dt';
// Never use structural containers as fallback segments.
// Doing so would let `linearizeSegment` stitch text across child blocks and
// produce invalid DOM when a math span is inserted.
const FALLBACK_BLOCKED_TAGS = new Set([
  'UL', 'OL', 'DL', 'MENU',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP',
  'PICTURE', 'FIGURE',
]);

// Fingerprint the segment using plain text plus `data-tex-source` placeholders.
function segmentHash(segment) {
  const parts = [];
  const collect = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    // Already-rendered math contributes its source token.
    if (node.hasAttribute && node.hasAttribute('data-tex-source')) {
      parts.push('\x01M');
      parts.push(node.getAttribute('data-tex-display') === '1' ? 'D' : 'I');
      parts.push(':');
      parts.push(node.getAttribute('data-tex-source'));
      parts.push('\x01');
      return; // Skip the subtree.
    }
    // KaTeX's `<span class="katex">` should already be wrapped by
    // our `data-tex-source` attribute. This fallback only fires for
    // stray KaTeX output without the wrapper — read its TeX source
    // annotation for a stable hash key and stop descending.
    if (node.classList && node.classList.contains('katex')) {
      const annot = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"]');
      parts.push('\x01K:' + (annot ? annot.textContent : '') + '\x01');
      return;
    }
    // Ignore UI elements injected by this script.
    if (node.classList && (
          node.classList.contains('claude-user-copy-btn') ||
          node.classList.contains('claude-user-copy-btn-row') ||
          node.classList.contains('claude-show-more-row') ||
          node.classList.contains('claude-show-more-btn')
        )) return;
    for (const child of node.childNodes) collect(child);
  };
  for (const child of segment.childNodes) collect(child);
  return fnv1a(parts.join(''));
}

function processSegment(segment) {
  if (!segment.isConnected) return;
  // A queued segment may later move into a contenteditable subtree.
  // Bail out immediately in that case and leave the DOM untouched.
  if (segment.isContentEditable) return;
  if (segment.closest && segment.closest('[contenteditable="true"]')) return;
  if (isDiffSurfaceNode(segment)) return;

  const curHash = segmentHash(segment);
  if (segment.getAttribute(SEG_VERSION_ATTR) === SEG_VERSION &&
      segment.getAttribute(SEG_HASH_ATTR) === curHash) {
    return; // Cache hit. Leave the DOM untouched.
  }

  const needsMath = CFG.math && (segment.textContent || '').indexOf('CCREMATH') !== -1;
  if (needsMath && !isKatexReady()) {
    pendingSegments.add(segment);
    ensureKatexLoaded();
    return;
  }

  if (needsMath) {
    const renderResult = renderMathInSegment(segment);
    if (!renderResult.complete) return;
  }

  // Apply CJK punctuation spacing only after math rendering.
  // Math nodes are skipped by class, and running punctuation first would
  // distort token offsets inside math source text.
  padCjkPunctInSegment(segment);

  segment.setAttribute(SEG_VERSION_ATTR, SEG_VERSION);
  segment.setAttribute(SEG_HASH_ATTR, segmentHash(segment));
}

// ========== 6. observer / scheduler ==========

const pendingSegments = new Set();
const deferredSegments = new Set();
// Roots whose subtree may contain new code blocks or user bubbles. We used
// to re-scan the entire document on every flush, which was fine in short
// sessions but became a measurable per-frame cost during long streaming
// chats. Now characterData mutations only feed `pendingSegments` (math),
// and only childList mutations push their added Elements here for
// localized hljs / copy-button passes.
const pendingRoots = new Set();
const deferredCodeRoots = new Set();
let rafId = null;
let deferredSegmentsTimer = 0;
let attachedMessagesRoot = null;
const STREAMING_TYPOGRAPHY_RECHECK_MS = 240;
const FLUSH_SEGMENT_BUDGET_MS = 5;
const FLUSH_ROOT_BUDGET_MS = 5;
const FLUSH_SEGMENT_MIN = 12;
const FLUSH_ROOT_MIN = 4;

function timeNow() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

function shouldYield(start, processed, minCount, budgetMs) {
  if (processed < minCount) return false;
  return timeNow() - start >= budgetMs;
}

function firstSetValue(set) {
  return set && set.size ? set.values().next().value : undefined;
}

function closestSegment(node) {
  let el = node;
  if (el && el.nodeType !== 1) el = el.parentElement;
  if (!el) return null;
  // Never touch contenteditable subtrees. The chat input contains real
  // `<p>` nodes that match `SEG_SELECTOR`, and mutating them would
  // desynchronize the editor model from the DOM.
  if (el.isContentEditable) return null;
  if (isDiffSurfaceNode(el)) return null;
  // First try the strict `SEG_SELECTOR`.
  let cur = el;
  while (cur && cur !== document.body) {
    if (cur.matches && cur.matches(SEG_SELECTOR)) return cur;
    cur = cur.parentElement;
  }
  // Fallback to the direct parent element when a strict segment is missing,
  // such as display math rendered inside a bare `<div>`.
  // Reject root containers and structural blocks so math ranges cannot span
  // across list items, table rows, or similar child blocks.
  if (el === document.body || el === document.documentElement) return null;
  if (FALLBACK_BLOCKED_TAGS.has(el.tagName)) return null;
  return el;
}

function nodeContainsMathPlaceholder(node) {
  if (!CFG.math || !node) return false;
  if (node.nodeType === 3) return (node.nodeValue || '').indexOf('CCREMATH') !== -1;
  if (node.nodeType === 1) return (node.textContent || '').indexOf('CCREMATH') !== -1;
  return false;
}

function queueSegment(seg, deferUntilIdle) {
  if (!seg) return;
  if (deferUntilIdle) {
    pendingSegments.delete(seg);
    deferredSegments.add(seg);
    scheduleDeferredSegmentsFlush();
    return;
  }
  deferredSegments.delete(seg);
  pendingSegments.add(seg);
}

function enqueueNode(node, options = {}) {
  if (!node) return;
  const deferUntilIdle = options.deferTypography === true;
  if (node.nodeType === 1) {
    const cls = (typeof node.className === 'string' ? node.className : '') || '';
    if (cls.indexOf('katex') !== -1 ||
        cls.indexOf('hljs') !== -1 ||
        cls.indexOf('claude-user-copy-btn') !== -1 ||
        cls.indexOf('claude-show-more') !== -1 ||
        cls.indexOf('claude-math') !== -1 ||
        cls.indexOf('claude-punc') !== -1) {
      return;
    }
    // Skip any subtree rooted inside a contenteditable editor.
    if (node.isContentEditable) return;
    if (isDiffSurfaceNode(node)) return;
    const seg = closestSegment(node);
    if (seg) queueSegment(seg, deferUntilIdle);
    if (node.querySelectorAll) {
      for (const s of node.querySelectorAll(SEG_SELECTOR)) {
        if (s.isContentEditable) continue;
        if (isDiffSurfaceNode(s)) continue;
        queueSegment(s, deferUntilIdle);
      }
    }
  } else if (node.nodeType === 3) {
    const seg = closestSegment(node);
    if (seg) queueSegment(seg, deferUntilIdle);
  }
}

function flushDeferredSegmentsIfReady() {
  if (!deferredSegments.size) return false;
  if (conversationIsBusy()) {
    scheduleDeferredSegmentsFlush();
    return false;
  }
  if (deferredSegmentsTimer) {
    clearTimeout(deferredSegmentsTimer);
    deferredSegmentsTimer = 0;
  }
  const segs = Array.from(deferredSegments);
  deferredSegments.clear();
  for (const seg of segs) {
    if (seg && seg.isConnected) pendingSegments.add(seg);
  }
  schedule();
  return true;
}

function scheduleDeferredSegmentsFlush() {
  if (deferredSegmentsTimer || !deferredSegments.size) return;
  deferredSegmentsTimer = setTimeout(() => {
    deferredSegmentsTimer = 0;
    flushDeferredSegmentsIfReady();
  }, STREAMING_TYPOGRAPHY_RECHECK_MS);
}

function enqueueKernelDirtyTypographyRoots() {
  if (conversationIsBusy()) return false;
  const roots = takeStreamDirtyRoots('typography');
  if (!roots.length) return false;
  for (const root of roots) {
    if (!root || root.isConnected === false) continue;
    enqueueNode(root, { deferTypography: false });
    pendingRoots.add(root);
  }
  bumpPerfCounter('typography.dirtyRootsFlushed', roots.length);
  schedule();
  return true;
}

// Cheap structural test for the streaming childList fast path. We let new
// user bubbles and new markdown roots through to the normal mint pipeline
// because they carry user-visible UI (action rows, copy buttons, code
// blocks) that should appear within the same tick. Token-level inserts
// (the bulk of streaming mutations) just mark the latest markdown root
// dirty so the settled pass repolishes once.
function isStreamingMountWorthScanning(node) {
  if (!node || node.nodeType !== 1) return false;
  const cls = typeof node.className === 'string' ? node.className : '';
  return cls.indexOf('userMessage_') !== -1 || cls.indexOf('root_') !== -1;
}

function rootForCodeBlock(block) {
  if (!block || !block.closest) return block || null;
  return block.closest(SEL.markdownRoot) || block.closest('pre') || block;
}

function rememberDeferredCodeBlock(block) {
  const root = rootForCodeBlock(block);
  if (!root) return;
  deferredCodeRoots.add(root);
  markStreamDirty('codeHighlight', root);
  bumpPerfCounter('codeHighlight.deferred', 1);
}

// ---- mermaid ----
// Diagrams render only after the turn settles (busy=false). The scan is gated
// twice: scheduled as an idle task (never inline on a stream/mutation hot
// path), and runMermaidScan bails immediately while busy — the next settle
// event re-triggers it. The heavy 3.3MB library is loaded lazily and only
// when an eligible block actually exists, never on bootstrap.
let mermaidLoadFailed = false;

function mermaidScanRoot() {
  return attachedMessagesRoot || document.querySelector(MESSAGES_ROOT_SELECTOR) || document.body;
}

function runMermaidScan() {
  if (mermaidLoadFailed) return;
  if (conversationIsBusy()) return; // streaming: settle event will re-trigger
  const root = mermaidScanRoot();
  if (!root) return;
  // Cheap pure-read gate before paying the library load cost.
  if (!collectMermaidBlocks(root).length) return;
  assets.mermaid().then(m => {
    if (conversationIsBusy()) { scheduleMermaidScan('busyAgain'); return; }
    return renderMermaidIn(m, root, { isBusy: () => conversationIsBusy() });
  }).catch(() => { mermaidLoadFailed = true; /* blocks stay as code fallback */ });
}

function scheduleMermaidScan(reason = 'deferred') {
  if (mermaidLoadFailed) return;
  scheduleIdleTask('typography.mermaidScan', () => {
    try { runMermaidScan(); }
    catch (e) { warn('mermaid scan failed:', e); }
  }, {
    delay: reason === 'assistantTurnFinalized' ? 80 : STREAMING_TYPOGRAPHY_RECHECK_MS,
    timeout: 1500,
  });
}

function scheduleDeferredRuntimeFlush(reason = 'deferred') {
  scheduleIdleTask('typography.deferredFlush', () => {
    try { flushDeferredCodeHighlights(); }
    catch (e) { warn('deferred typography flush failed:', e); }
  }, {
    delay: reason === 'streamSettled' ? 80 : STREAMING_TYPOGRAPHY_RECHECK_MS,
    timeout: 1200,
  });
}

function schedule() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(flush);
}

function flush() {
  rafId = null;
  if (pendingSegments.size) {
    const start = timeNow();
    let processed = 0;
    while (pendingSegments.size) {
      const seg = firstSetValue(pendingSegments);
      pendingSegments.delete(seg);
      if (!seg || !seg.isConnected) continue;
      try { processSegment(seg); }
      catch (e) { warn('processSegment failed:', e); }
      processed++;
      if (shouldYield(start, processed, FLUSH_SEGMENT_MIN, FLUSH_SEGMENT_BUDGET_MS)) break;
    }
  }
  // Localized hljs + copy-button passes — only roots that grew on this tick.
  // Mounted-but-already-scanned content is left alone (`:not(.hljs)` keeps
  // hljs idempotent; `addUserCopyButton` and `classifyUserBubble` are too).
  if (pendingRoots.size) {
    const start = timeNow();
    let processed = 0;
    let swept = false;
    const hljsReady = typeof window.hljs !== 'undefined';
    let busy = false;
    try { busy = conversationIsBusy(); } catch (_) { busy = false; }
    while (pendingRoots.size) {
      const root = firstSetValue(pendingRoots);
      pendingRoots.delete(root);
      if (!root || (root.isConnected === false)) continue;
      if (busy) {
        markStreamDirty('typography', root);
      } else {
        try { renderTableBreakTextNodes(root); }
        catch (e) { warn('table <br> render failed:', e); }
      }
      if (hljsReady) {
        try { enqueueCodeHighlight(root); } catch (e) { warn('highlight queue failed:', e); }
      }
      try {
        scanAndAddCopyButtons(root, {
          assistantActions: false,
          sweepBusyState: false,
        });
        swept = true;
      } catch (e) { warn('copy-btn failed:', e); }
      processed++;
      if (shouldYield(start, processed, FLUSH_ROOT_MIN, FLUSH_ROOT_BUDGET_MS)) break;
    }
    if (swept) sweepStreamingDisableState();
    // New content settled into the DOM (e.g. opening a transcript or switching
    // sessions, which fire no streamSettled). Debounced + busy-gated, so this
    // is a no-op during streaming and only renders once content is static.
    if (swept) scheduleMermaidScan('flush');
  }
  if (pendingSegments.size || pendingRoots.size) schedule();
  else if (hasDeferredCodeHighlights()) flushDeferredCodeHighlights();
}

function handleMutations(mutations) {
  let dirty = false;
  let workQueued = false;
  // One busy read per batch; downstream paths reuse this value rather than
  // re-querying the kernel/fiber for every mutation record.
  let busy = false;
  try { busy = conversationIsBusy(); } catch (_) { busy = false; }
  for (const m of mutations) {
    if (mutationTouchesIgnoredTranscriptActionSurface(m)) continue;
    if (m.type === 'characterData') {
      const hasMath = nodeContainsMathPlaceholder(m.target);
      if (busy && !hasMath) {
        // True streaming O(1): no closestSegment, no markStreamDirty (which
        // itself calls closest), no enqueue. The settled pass repolishes
        // CJK punctuation, code highlighting, and copy buttons in one go;
        // noteTranscriptActionMutation below is the only side effect.
        dirty = true;
        continue;
      }
      const seg = closestSegment(m.target);
      if (seg) {
        queueSegment(seg, false);
        dirty = true;
        workQueued = true;
      }
    } else if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        const hasMath = nodeContainsMathPlaceholder(node);
        if (busy && !hasMath) {
          // Structural mounts (new user bubble, new markdown root) go
          // through the normal mint path so their copy buttons / action
          // rows appear in the same tick. Everything else (token-level
          // assistant inserts) only marks the nearest markdown root dirty
          // — settled flush replays it.
          if (isStreamingMountWorthScanning(node)) {
            pendingRoots.add(node);
            workQueued = true;
          } else {
            markStreamDirty('typography', node);
          }
          dirty = true;
          continue;
        }
        enqueueNode(node, { deferTypography: false });
        // Element-only — text nodes never match hljs/userBubble selectors.
        // For streaming markdown, also rescan the nearest markdown root.
        // Regular assistant code highlighting itself stays deferred while
        // busy; this root pass still catches newly mounted user/action UI and
        // lets the idle flush find all unhighlighted blocks in one sweep.
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (node.nodeType === 1) pendingRoots.add(node);
        const markdownRoot = el && el.closest && el.closest(SEL.markdownRoot);
        if (markdownRoot) pendingRoots.add(markdownRoot);
        workQueued = true;
      }
      if (m.addedNodes.length) dirty = true;
    }
  }
  if (dirty) noteTranscriptActionMutation();
  if (workQueued || pendingSegments.size || pendingRoots.size) schedule();
}

// Chromium bug workaround: a MutationObserver with `characterData: true`
// observing `document.body` disables the IME paint optimization for the
// contenteditable chat input. Every composition buffer update must
// generate a mutation record, which forces composition text through the
// regular paint path — but that path leaves the previous composition
// frame's pixels behind, accumulating as phantom glyphs (especially when
// narrow Latin punctuation like `,` `.` precedes wide CJK characters).
//
// Fix: scope the content observer to the messages container. The chat
// input lives in `inputContainer` which is a sibling, not a descendant,
// so the editor subtree is completely excluded from characterData
// observation and the paint optimization stays on.
const MESSAGES_ROOT_SELECTOR = '[class*="messagesContainer_"]';

function setupObserver() {
  let contentObs = null;
  let attachedRoot = null;

  function mutationInsideFocusedEditor(mutation) {
    const active = document.activeElement;
    return !!(
      active &&
      active.isContentEditable &&
      mutation &&
      mutation.target &&
      (mutation.target === active || active.contains(mutation.target))
    );
  }

  function mutationsAllInsideFocusedEditor(mutations) {
    if (!mutations || !mutations.length) return false;
    for (let i = 0; i < mutations.length; i++) {
      if (!mutationInsideFocusedEditor(mutations[i])) return false;
    }
    return true;
  }

  function attachContent(root) {
    if (!root || root === attachedRoot) return;
    if (contentObs) contentObs.disconnect();
    attachedRoot = root;
    attachedMessagesRoot = root;
    contentObs = new MutationObserver(handleMutations);
    contentObs.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    for (const s of root.querySelectorAll(SEG_SELECTOR)) {
      if (s.isContentEditable) continue;
      if (isDiffSurfaceNode(s)) continue;
      pendingSegments.add(s);
    }
    // Seed the localized hljs / copy-button pass for everything already
    // mounted under this messages root. Subsequent growth is handled by
    // `handleMutations` adding individual subtrees to `pendingRoots`.
    pendingRoots.add(root);
    noteTranscriptActionMutation();
    schedule();
  }

  const initial = document.querySelector(MESSAGES_ROOT_SELECTOR);
  if (initial) attachContent(initial);

  // Lightweight finder: childList-only on body, so it does NOT affect the
  // editor's IME paint. Its job is to pick up messagesContainer when React
  // mounts or remounts it, and hand it off to the content observer.
  const finder = new MutationObserver(mutations => {
    if (mutationsAllInsideFocusedEditor(mutations)) return;
    const root = document.querySelector(MESSAGES_ROOT_SELECTOR);
    if (root && root !== attachedRoot) attachContent(root);
  });
  finder.observe(document.body, { childList: true, subtree: true });

  if (!initial) {
    enqueueInitialSegments(document.body);
    schedule();
  }
}

// Initial scan:
//   1. enqueue every element matched by `SEG_SELECTOR`
//   2. walk text nodes containing `$` or `\` and use `closestSegment`
//      as a fallback
function enqueueInitialSegments(root = document.body) {
  const scope = root || document.body;
  if (!scope) return;
  for (const s of scope.querySelectorAll(SEG_SELECTOR)) {
    // `querySelectorAll` bypasses `closestSegment`, so filter editor and
    // diff nodes explicitly here.
    if (s.isContentEditable) continue;
    if (isDiffSurfaceNode(s)) continue;
    pendingSegments.add(s);
  }

  const walker = document.createTreeWalker(
    scope,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || v.length < 2) return NodeFilter.FILTER_REJECT;
        if (isDiffSurfaceNode(node)) return NodeFilter.FILTER_REJECT;
        // The render path only cares about placeholders, not raw `$` or
        // backslash text. Skipping pages without the placeholder prefix
        // keeps the walker from touching unrelated chrome text.
        if (v.indexOf('CCREMATH') === -1) return NodeFilter.FILTER_REJECT;
        // Skip text inside scripts, styles, and code blocks.
        let p = node.parentNode;
        while (p && p.nodeType === 1) {
          const tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE') {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  let tn;
  while ((tn = walker.nextNode())) {
    const seg = closestSegment(tn);
    if (seg) pendingSegments.add(seg);
  }
}

// ========== 7. code-highlight ==========

function incipitCodeUnitOffsetForCodePoint(text, offset) {
  if (offset <= 0) return 0;
  let units = 0;
  let points = 0;
  for (const ch of String(text || '')) {
    if (points >= offset) break;
    units += ch.length;
    points++;
  }
  return units;
}

function wrapIncipitDiffTextNodeRange(node, start, end, kind) {
  if (!node || !node.parentNode || end <= start) return;
  const text = node.nodeValue || '';
  const startOffset = incipitCodeUnitOffsetForCodePoint(text, start);
  const endOffset = incipitCodeUnitOffsetForCodePoint(text, end);
  if (endOffset <= startOffset) return;

  let target = node;
  if (endOffset < text.length) target.splitText(endOffset);
  if (startOffset > 0) target = target.splitText(startOffset);
  if (!target.nodeValue) return;

  const span = document.createElement('span');
  span.setAttribute('data-incipit-diff-island-char', kind);
  span.setAttribute('data-incipit-write-diff-char', kind);
  target.parentNode.insertBefore(span, target);
  span.appendChild(target);
}

function applyIncipitDiffCharRangesToCode(code) {
  const ranges = Array.isArray(code && code.__incipitDiffCharRanges)
    ? code.__incipitDiffCharRanges
    : [];
  const kind = code && code.__incipitDiffCharKind;
  if (!code || code.dataset.incipitDiffCharsApplied === '1' || !ranges.length ||
      (kind !== 'add' && kind !== 'del')) {
    return;
  }

  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement && node.parentElement.closest('[data-incipit-diff-island-char]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = Array.from(node.nodeValue || '').length;
    if (length > 0) {
      nodes.push({ node, start: pos, end: pos + length });
      pos += length;
    }
  }

  for (let r = ranges.length - 1; r >= 0; r--) {
    const range = ranges[r];
    if (!range || range.length < 2) continue;
    const start = range[0];
    const end = range[1];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const item = nodes[i];
      const a = Math.max(start, item.start);
      const b = Math.min(end, item.end);
      if (b <= a) continue;
      wrapIncipitDiffTextNodeRange(item.node, a - item.start, b - item.start, kind);
    }
  }
  code.dataset.incipitDiffCharsApplied = '1';
}

function isIncipitDiffCodeBlock(block) {
  return !!(
    block &&
    block.matches &&
    block.matches('[data-incipit-diff-island-code], [data-incipit-write-diff-code]')
  );
}

function explicitHighlightLanguage(block) {
  if (!block || !block.classList) return '';
  for (const cls of block.classList) {
    const m = /^language-(.+)$/i.exec(cls);
    if (!m) continue;
    const lang = (m[1] || '').trim().toLowerCase();
    if (!lang || lang === 'plaintext' || lang === 'text' || lang === 'nohighlight') return '';
    return lang;
  }
  return '';
}

function hljsCanHighlightBlock(block) {
  const lang = explicitHighlightLanguage(block);
  if (!lang) return true;
  if (!window.hljs || typeof window.hljs.getLanguage !== 'function') return true;
  if (window.hljs.getLanguage(lang)) return true;
  // highlightElement logs a warning for every unsupported language. Diff
  // islands can contain hundreds of one-line code nodes, so one missing
  // grammar (e.g. powershell) otherwise floods the VS Code console.
  if (block.dataset) block.dataset.incipitHljsUnsupportedLanguage = lang;
  if (block.classList) block.classList.add('hljs');
  return false;
}

function shouldDeferRegularCodeHighlight(block, busy) {
  if (!busy) return false;
  if (!block || !block.closest) return false;
  // Normal assistant markdown is React-owned while the reply streams. Running
  // hljs mutates `<code>` into token spans; React then keeps reconciling the
  // same tail and can replace that subtree, producing a visible layout/color
  // fight around the code block and everything below it. Defer every regular
  // markdown code block until SessionState.busy flips false. Diff islands and
  // tool bodies are owned by separate paths and remain eligible immediately.
  if (block.closest(`${SEL.toolUse}, ${SEL.toolBody}, [class*="toolBody"], [class*="toolResult"]`)) {
    return false;
  }
  if (!block.closest(SEL.markdownRoot)) return false;
  return true;
}

function highlightOneCodeBlock(block, options = {}) {
  const isDiffIsland = isIncipitDiffCodeBlock(block);
  if (!isDiffIsland && shouldDeferRegularCodeHighlight(block, options.busy === true)) {
    rememberDeferredCodeBlock(block);
    // Deliberately avoid even a diagnostic data-attr here. During streaming
    // this `<code>` node is React-owned; any mutation by us can be reverted by
    // the next host commit and contribute to the visible code-block twitch.
    return;
  }

  if (isDiffIsland) {
    if (block.dataset) delete block.dataset.incipitDiffCharsApplied;
    // If char spans were applied before highlight.js loaded, strip that
    // markup back to plain text before hljs tokenizes. The original text is
    // still exactly `textContent`; the row metadata lives on expando props.
    if (block.querySelector && block.querySelector('[data-incipit-diff-island-char]')) {
      block.textContent = block.textContent || '';
    }
  } else if (block.dataset && block.dataset.incipitHljsDeferred) {
    delete block.dataset.incipitHljsDeferred;
  }
  if (hljsCanHighlightBlock(block)) {
    try { window.hljs.highlightElement(block); } catch (e) { /* ignore */ }
  }
  if (isDiffIsland) applyIncipitDiffCharRangesToCode(block);
}

export function highlightAllCode(root) {
  if (typeof window.hljs === 'undefined') return;
  const scope = root || document.body;
  if (!scope) return;
  // During streaming the host keeps rebuilding the markdown tail. Running
  // hljs on regular assistant code blocks makes incipit and React fight over
  // the same `<code>` node, causing visible color/layout jitter. Queue them
  // and let the busy-state hook flush once the stream is actually idle.
  let busy = false;
  try { busy = conversationIsBusy(); } catch (_) { busy = false; }
  // Match the root itself too — `querySelectorAll` excludes the host node,
  // so a mutation that lands a `<pre><code>` directly would otherwise miss.
  if (scope.matches && scope.matches('pre code:not(.hljs)') &&
      !scope.classList.contains('language-latex') &&
      !scope.classList.contains('language-mermaid')) {
    highlightOneCodeBlock(scope, { busy });
  }
  if (!scope.querySelectorAll) return;
  const blocks = scope.querySelectorAll('pre code:not(.hljs)');
  for (const block of blocks) {
    // language-mermaid is owned by the mermaid render pass, not hljs.
    if (block.classList.contains('language-latex') ||
        block.classList.contains('language-mermaid')) continue;
    highlightOneCodeBlock(block, { busy });
  }
}

const HIGHLIGHT_CHUNK_BUDGET_MS = 8;
const HIGHLIGHT_CHUNK_MIN_BLOCKS = 8;
const pendingCodeHighlights = [];
const pendingCodeHighlightSet = new Set();
let codeHighlightRaf = 0;

export function enqueueCodeHighlight(root) {
  if (typeof window.hljs === 'undefined') return;
  const scope = root || document.body;
  if (!scope) return;
  const add = block => {
    if (!block || pendingCodeHighlightSet.has(block)) return;
    if (block.classList && (
          block.classList.contains('hljs') ||
          block.classList.contains('language-latex') ||
          block.classList.contains('language-mermaid')
        )) return;
    pendingCodeHighlightSet.add(block);
    pendingCodeHighlights.push(block);
  };
  if (scope.matches && scope.matches('pre code:not(.hljs)')) add(scope);
  if (scope.querySelectorAll) {
    scope.querySelectorAll('pre code:not(.hljs)').forEach(add);
  }
  scheduleCodeHighlightChunk();
}

function scheduleCodeHighlightChunk() {
  if (codeHighlightRaf || !pendingCodeHighlights.length) return;
  codeHighlightRaf = requestAnimationFrame(runCodeHighlightChunk);
}

function runCodeHighlightChunk() {
  codeHighlightRaf = 0;
  if (typeof window.hljs === 'undefined') {
    pendingCodeHighlightSet.clear();
    pendingCodeHighlights.length = 0;
    return;
  }
  let busy = false;
  try { busy = conversationIsBusy(); } catch (_) { busy = false; }
  const start = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
  let processed = 0;
  while (pendingCodeHighlights.length) {
    const block = pendingCodeHighlights.shift();
    pendingCodeHighlightSet.delete(block);
    if (block && block.isConnected && !block.classList.contains('hljs') &&
        !block.classList.contains('language-latex') &&
        !block.classList.contains('language-mermaid')) {
      try { highlightOneCodeBlock(block, { busy }); }
      catch (e) { warn('highlight failed:', e); }
    }
    processed++;
    const elapsed = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    if (processed >= HIGHLIGHT_CHUNK_MIN_BLOCKS && elapsed >= HIGHLIGHT_CHUNK_BUDGET_MS) {
      break;
    }
  }
  if (pendingCodeHighlights.length) scheduleCodeHighlightChunk();
}

export function flushDeferredCodeHighlights() {
  const flushedTypography = flushDeferredSegmentsIfReady();
  const flushedDirtyTypography = enqueueKernelDirtyTypographyRoots();
  if (typeof window.hljs === 'undefined') {
    if (deferredCodeRoots.size || hasStreamDirty('codeHighlight')) {
      scheduleDeferredRuntimeFlush();
    }
    return flushedTypography || flushedDirtyTypography;
  }
  if (conversationIsBusy()) {
    if (deferredCodeRoots.size || hasStreamDirty('codeHighlight')) {
      scheduleDeferredRuntimeFlush();
    }
    return flushedTypography || flushedDirtyTypography;
  }

  const roots = [];
  for (const root of deferredCodeRoots) roots.push(root);
  deferredCodeRoots.clear();
  for (const root of takeStreamDirtyRoots('codeHighlight')) roots.push(root);
  if (!roots.length) return flushedTypography || flushedDirtyTypography;

  let queued = 0;
  const seen = new Set();
  for (const root of roots) {
    if (!root || root.isConnected === false || seen.has(root)) continue;
    seen.add(root);
    enqueueCodeHighlight(root);
    queued++;
  }
  if (queued) bumpPerfCounter('codeHighlight.deferredRootsFlushed', queued);
  return flushedTypography || flushedDirtyTypography || queued > 0;
}

export function hasDeferredCodeHighlights() {
  return (
    deferredCodeRoots.size > 0 ||
    deferredSegments.size > 0 ||
    hasStreamDirty('typography') ||
    hasStreamDirty('codeHighlight')
  );
}

export function scanCopyButtons(root, options = {}) {
  scanAndAddCopyButtons(root || document.body, options);
}

let typographyStarted = false;

export function initTypography(hooks = {}) {
  configureTypographyHooks(hooks);
  exposeTypographyApi();
  if (typographyStarted) {
    reportHealth('typography', 'ok', { alreadyStarted: true });
    return globalThis.__incipitTypography;
  }
  typographyStarted = true;
  reportHealth('typography', 'starting');
  subscribe('streamSettled', () => scheduleDeferredRuntimeFlush('streamSettled'));
  // Mermaid renders on turn finalize (the quietest signal — busy=false plus
  // dirty-quiet); streamSettled is a backstop. Both only schedule; the actual
  // render is gated on busy=false inside runMermaidScan.
  subscribe('assistantTurnFinalized', () => scheduleTableBreakScan('assistantTurnFinalized'));
  subscribe('streamSettled', () => scheduleTableBreakScan('streamSettled'));
  subscribe('assistantTurnFinalized', () => scheduleMermaidScan('assistantTurnFinalized'));
  subscribe('streamSettled', () => scheduleMermaidScan('streamSettled'));
  setupObserver();

  assets.hljs().then(() => {
    // Once hljs lands, queue only the transcript code blocks. User/action
    // controls were already seeded by the messages-root pass; putting
    // document.body back into pendingRoots here caused a second full
    // copy/action sweep on long transcripts during open.
    const root = attachedMessagesRoot || document.querySelector(MESSAGES_ROOT_SELECTOR) || document.body;
    if (root) enqueueCodeHighlight(root);
  }).catch(() => { /* Already warned. */ });

  // Render any mermaid already present in an opened transcript (no stream, so
  // no settle event will fire for it).
  scheduleTableBreakScan('init');
  scheduleMermaidScan('init');

  reportHealth('typography', 'ok');
  return globalThis.__incipitTypography;
}

function exposeTypographyApi() {
  globalThis.__incipitTypography = {
    configure: configureTypographyHooks,
    init: initTypography,
    enqueueCodeHighlight,
    flushDeferredCodeHighlights,
    hasDeferredCodeHighlights,
    highlightAllCode,
    scanCopyButtons,
  };
}

exposeTypographyApi();
