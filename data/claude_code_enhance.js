import { preprocessMarkdown } from './markdown_preprocess.js';
import { startHostProbe } from './host_probe.js';
import {
  CFG,
  applyAppVarOverrides,
  applyBodyBoldFlag,
  dbg,
  ensureDomFreeze,
  injectStyles,
  log,
  reportHealth,
  setupAppVarObserver,
  warn,
  whenDOMReady,
} from './enhance_shared.js';
import {
  bumpPerfCounter,
  conversationIsBusy as kernelConversationIsBusy,
  initRuntimeKernel,
} from './runtime_kernel.js';

/**
 * incipit webview bootstrap.
 *
 * Keep this file small and first-paint focused. Heavy behavior now loads from
 * separate modules after the critical attrs/styles are in place. The
 * synchronous markdown math hook stays here: the host react-markdown patch
 * cannot await a lazy import.
 */

(() => {
  'use strict';

  window.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__ =
    raw => preprocessMarkdown(raw, { math: CFG.math });
  reportHealth('markdown.preprocess', 'ok', {
    links: 'enabled',
    math: CFG.math ? 'enabled' : 'disabled',
  });

  let footerLoadStarted = false;
  function loadFooterBadge(reason) {
    if (footerLoadStarted) return;
    footerLoadStarted = true;
    reportHealth('module.footerBadge', 'loading', { reason });
    dbg('loading footer/badge module:', reason);
    import('./enhance_footer_badge.js')
      .then(mod => {
        if (mod && typeof mod.initFooterBadge === 'function') mod.initFooterBadge();
        reportHealth('module.footerBadge', 'ok');
      })
      .catch(e => {
        reportHealth('module.footerBadge', 'error', { message: e && e.message ? e.message : String(e) });
        warn('enhance_footer_badge.js import failed:', e);
      });
  }

  let thinkingLoadStarted = false;
  function loadThinking(reason) {
    if (thinkingLoadStarted) return;
    thinkingLoadStarted = true;
    reportHealth('module.thinking', 'loading', { reason });
    dbg('loading thinking module:', reason);
    import('./enhance_thinking.js')
      .then(mod => {
        if (mod && typeof mod.initThinking === 'function') mod.initThinking();
        reportHealth('module.thinking', 'ok');
      })
      .catch(e => {
        reportHealth('module.thinking', 'error', { message: e && e.message ? e.message : String(e) });
        warn('enhance_thinking.js import failed:', e);
      });
  }

  let typographyLoadStarted = false;
  function loadTypography(reason) {
    if (typographyLoadStarted) return;
    typographyLoadStarted = true;
    reportHealth('module.typography', 'loading', { reason });
    dbg('loading typography/code module:', reason);
    import('./enhance_typography.js')
      .then(mod => {
        if (mod && typeof mod.initTypography === 'function') mod.initTypography();
        reportHealth('module.typography', 'ok');
      })
      .catch(e => {
        reportHealth('module.typography', 'error', { message: e && e.message ? e.message : String(e) });
        warn('enhance_typography.js import failed:', e);
      });
  }

  function installRenderTimeCodeHighlighter() {
    if (typeof window.__INCIPIT_HIGHLIGHT_CODE_HTML__ === 'function') {
      reportHealth('markdown.renderTimeCode', 'ok', { installed: 'existing' });
      return;
    }
    const cache = new Map();
    const MAX_CACHE_ENTRIES = 160;
    const BUSY_AUTO_HIGHLIGHT_CHAR_LIMIT = 8000;
    let lastHealthKey = '';

    function fnv1a(str) {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return h.toString(36);
    }

    function cacheKey(classes, code) {
      const text = String(code || '');
      return String(classes || '') + '\u0000' + text.length + '\u0000' + fnv1a(text);
    }

    function renderTimeHighlightIsBusy() {
      try { return kernelConversationIsBusy(); }
      // Unknown host state must not authorize an expensive highlightAuto call
      // on the streaming render path; the settled DOM pass remains available.
      catch (_) { return true; }
    }

    function noteRenderHealth(status, detail = null) {
      const key = status + ':' + JSON.stringify(detail || {});
      if (key === lastHealthKey) return;
      lastHealthKey = key;
      reportHealth('markdown.renderTimeCode', status, detail);
    }

    function remember(key, value) {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(key, value);
      return value;
    }

    window.__INCIPIT_HIGHLIGHT_CODE_HTML__ = (rawCode, className) => {
      const hljs = window.hljs;
      if (!hljs || typeof hljs.highlight !== 'function') {
        noteRenderHealth('pending', { reason: 'hljs-not-ready' });
        return null;
      }

      const code = String(rawCode ?? '');
      const classes = String(className || '');
      const key = cacheKey(classes, code);
      if (cache.has(key)) return cache.get(key);

      const match = /\blanguage-([A-Za-z0-9_+.-]+)\b/.exec(classes);
      const language = match && match[1];
      if (!language && code.length > BUSY_AUTO_HIGHLIGHT_CHAR_LIMIT && renderTimeHighlightIsBusy()) {
        noteRenderHealth('degraded', {
          reason: 'busy-large-auto-highlight',
          length: code.length,
        });
        bumpPerfCounter('renderTimeCode.autoSkippedBusy', 1);
        return null;
      }
      try {
        const result = language && (!hljs.getLanguage || hljs.getLanguage(language))
          ? hljs.highlight(code, { language, ignoreIllegals: true })
          : hljs.highlightAuto(code);
        const html = result && typeof result.value === 'string' ? result.value : null;
        noteRenderHealth(html ? 'ok' : 'degraded', {
          mode: language ? 'language' : 'auto',
          language: language || null,
        });
        return remember(key, html);
      } catch (e) {
        noteRenderHealth('error', { message: e && e.message ? e.message : String(e) });
        warn('render-time code highlight failed:', e);
        return remember(key, null);
      }
    };
    reportHealth('markdown.renderTimeCode', 'installed');
    loadTypography('react-code-render-preload');
  }

  let heavyLoadStarted = false;
  function loadHeavy(reason) {
    if (heavyLoadStarted) return;
    heavyLoadStarted = true;
    reportHealth('module.legacy', 'loading', { reason });
    dbg('loading heavy module:', reason);
    import('./enhance_legacy.js')
      .then(() => reportHealth('module.legacy', 'ok'))
      .catch(e => {
        reportHealth('module.legacy', 'error', { message: e && e.message ? e.message : String(e) });
        warn('enhance_legacy.js import failed:', e);
      });
  }

  function scheduleDeferredModules() {
    const run = () => {
      loadFooterBadge('after-critical');
      loadThinking('after-critical');
      loadTypography('after-critical');
      loadHeavy('after-critical');
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function markCriticalReady() {
    try {
      document.documentElement.setAttribute('data-incipit-critical-ready', '1');
      reportHealth('bootstrap.critical', 'ok');
    } catch (_) {}
  }

  function initCritical() {
    reportHealth('bootstrap', 'starting');
    log('Initializing bootstrap (theme, host attrs, app vars)...');
    initRuntimeKernel();
    ensureDomFreeze();
    applyAppVarOverrides();
    setupAppVarObserver();
    applyBodyBoldFlag();
    startHostProbe();
    injectStyles();
    installRenderTimeCodeHighlighter();
    markCriticalReady();
    scheduleDeferredModules();
    reportHealth('bootstrap', 'ok');
  }

  ensureDomFreeze();
  reportHealth('bootstrap.domFreeze', 'ok');
  whenDOMReady(initCritical);
})();
