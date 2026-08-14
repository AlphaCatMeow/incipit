import { CFG, getActiveClaudeSessionId } from './enhance_shared.js';
import { SEL } from './host_probe.js';
import {
  getHostState as kernelGetHostState,
  subscribe as subscribeRuntime,
} from './runtime_kernel.js';

// Footer badge / notes / activity-popup copy, keyed the same way as the CLI's
// src/i18n.js (`t(key, vars)` + `{name}` placeholder substitution) so both
// halves of the project read as one system. `CFG.language` is read fresh on
// every call instead of cached, since it never changes within a webview
// session (see enhance_shared.js).
var STR = {
  en: {
    ctx_window: 'Context window',
    cache_hit_rate: 'Cache hit rate',
    cache_hit_history: 'Cache hit history',
    selected_range: 'Selected range',
    no_cache_history: 'No cache hit history yet',
    lowest: 'Lowest',
    latest: 'Latest',
    mean: 'Mean',
    current_cache: 'Current cache',
    context: 'Context',
    request_one: '{n} request',
    request_other: '{n} requests',
    fresh: 'Fresh',
    write: 'Write',
    read: 'Read',
    cache_read: 'Cache read',
    cache_write: 'Cache write',
    output: 'Output',
    fresh_input: 'Fresh input',
    lowest_tip: 'Lowest · {pct} · {ctx} · {time}',
    latest_tip: 'Latest · {pct} · {ctx} · {time}',
    duration_s: '{n} s',
    duration_min: '{n} min',
    duration_h_min: '{h} h {m}',
    duration_h_exact: '{h} h',
    model_edit_activity: 'Model edit activity',
    model_edits_title: 'Model edits: +{added} / −{removed} across {edits} tool edits',
    cell_tip: '{date} · +{added} / −{removed} · {edits} edits',
    current_project: 'Current project',
    global_tool_edits: '{n} global tool edits',
    conversations: '{n} conversations',
    recorded_projects: '{n} recorded projects',
    active_days: '{n} active days',
    loading_index: 'Loading index',
    all_conversations_kicker: 'All Claude Code conversations',
    across_recorded_projects: 'Across recorded projects',
    indexing: 'Indexing',
    less: 'Less',
    more: 'More',
    no_model_edits: 'No model edits yet',
    notes: 'Notes',
    notes_tab_project: 'Project',
    notes_tab_global: 'Global',
    no_project_notes: 'No project notes yet.',
    open_workspace_for_notes: 'Open a workspace to use project notes.',
    no_notes: 'No notes yet.',
    new_note: '+ New note',
    insert_into_composer: 'Insert into composer',
    edit_note: 'Edit note',
    edit: 'Edit',
    delete_note: 'Delete note',
    delete: 'Delete',
    note_placeholder: 'Snippet text to insert into the composer…',
    cancel: 'Cancel',
    save: 'Save',
    dismiss: 'Dismiss',
    insert: 'Insert',
    file_created_deleted: ' — newly created; now deleted.',
    file_line_stats: '+{added}/−{removed} lines; ',
    file_restored: ' — {stats}restored to its previous contents.',
    reject_intro_one: 'I rejected the following change; it has been reverted:',
    reject_intro_many: 'I rejected the following changes; they have been reverted:',
  },
  zh: {
    ctx_window: '上下文窗口',
    cache_hit_rate: '缓存命中率',
    cache_hit_history: '缓存命中历史',
    selected_range: '选定区间',
    no_cache_history: '暂无缓存命中历史',
    lowest: '最低',
    latest: '最新',
    mean: '平均',
    current_cache: '当前缓存',
    context: '上下文',
    request_one: '{n} 个请求',
    request_other: '{n} 个请求',
    fresh: '新输入',
    write: '写入',
    read: '读取',
    cache_read: '缓存读取',
    cache_write: '缓存写入',
    output: '输出',
    fresh_input: '新输入',
    lowest_tip: '最低 · {pct} · {ctx} · {time}',
    latest_tip: '最新 · {pct} · {ctx} · {time}',
    duration_s: '{n} 秒',
    duration_min: '{n} 分钟',
    duration_h_min: '{h} 小时 {m}',
    duration_h_exact: '{h} 小时',
    model_edit_activity: '模型编辑活动',
    model_edits_title: '模型编辑：+{added} / −{removed}，共 {edits} 次工具编辑',
    cell_tip: '{date} · +{added} / −{removed} · {edits} 次编辑',
    current_project: '当前项目',
    global_tool_edits: '{n} 次全局工具编辑',
    conversations: '{n} 次对话',
    recorded_projects: '{n} 个已记录项目',
    active_days: '{n} 个活跃天',
    loading_index: '正在加载索引',
    all_conversations_kicker: '所有 Claude Code 对话',
    across_recorded_projects: '跨已记录项目',
    indexing: '索引中',
    less: '更少',
    more: '更多',
    no_model_edits: '暂无模型编辑',
    notes: '笔记',
    notes_tab_project: '项目',
    notes_tab_global: '全局',
    no_project_notes: '暂无项目笔记。',
    open_workspace_for_notes: '打开工作区以使用项目笔记。',
    no_notes: '暂无笔记。',
    new_note: '+ 新建笔记',
    insert_into_composer: '插入到输入框',
    edit_note: '编辑笔记',
    edit: '编辑',
    delete_note: '删除笔记',
    delete: '删除',
    note_placeholder: '要插入输入框的片段文本…',
    cancel: '取消',
    save: '保存',
    dismiss: '关闭',
    insert: '插入',
    file_created_deleted: ' — 新建后已删除。',
    file_line_stats: '+{added}/−{removed} 行；',
    file_restored: ' — {stats}已恢复为先前内容。',
    reject_intro_one: '我拒绝了以下更改，已撤销：',
    reject_intro_many: '我拒绝了以下更改，均已撤销：',
  },
};
function t(key, vars) {
  var dict = STR[CFG.language] || STR.en;
  var raw = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : STR.en[key] || key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, function (m, name) {
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
  });
}
function tRequests(n) {
  return t(n === 1 ? 'request_one' : 'request_other', { n: n });
}

function classText(node) {
  if (!node || node.nodeType !== 1) return '';
  return typeof node.className === 'string'
    ? node.className
    : String(node.getAttribute && node.getAttribute('class') || '');
}

function nodeInsideFocusedEditor(node) {
  var active = document.activeElement;
  return !!(
    active &&
    active.isContentEditable &&
    node &&
    (node === active || active.contains(node))
  );
}

function mutationInsideFocusedEditor(mutation) {
  return !!(mutation && mutation.target && nodeInsideFocusedEditor(mutation.target));
}

function nodeInsideMessagesContainer(node) {
  if (!node || node.nodeType !== 1) return false;
  try {
    return !!(
      node.matches && node.matches(SEL.messagesContainer) ||
      node.matches && node.matches('[class*="messagesContainer_"]') ||
      node.closest && node.closest(SEL.messagesContainer) ||
      node.closest && node.closest('[class*="messagesContainer_"]')
    );
  } catch (_) {
    return false;
  }
}

function mutationTouchesAddedNode(mutation, predicate) {
  if (!mutation || typeof predicate !== 'function') return false;
  for (var i = 0; i < mutation.addedNodes.length; i++) {
    var node = mutation.addedNodes[i];
    if (node && node.nodeType === 1 && predicate(node)) return true;
  }
  return false;
}

// ============================================================
// Shared active-session identity heartbeat.
// ============================================================
// Cache stats and edit activity both need to notice active-session changes.
// Keep one lightweight heartbeat/listener set and let each feature decide
// whether its own payload needs to be posted.
var identityPublishers = [];
var identityBridgeInstalled = false;
var identityBridgeScheduled = false;
var identityBridgeForce = false;

function currentSessionIdentity() {
  var sessionId = null;
  var cwd = null;
  try {
    var state = kernelGetHostState();
    if (state && typeof state.sessionId === 'string' && state.sessionId) sessionId = state.sessionId;
    if (state && typeof state.cwd === 'string' && state.cwd) cwd = state.cwd;
  } catch (_) {}
  if (!sessionId) sessionId = getActiveClaudeSessionId();
  return { sessionId: sessionId || null, cwd: cwd || null };
}

function currentSessionId() {
  return currentSessionIdentity().sessionId;
}

function currentSessionCwd() {
  return currentSessionIdentity().cwd || '';
}

function registerIdentityPublisher(publisher) {
  if (typeof publisher !== 'function') return;
  identityPublishers.push(publisher);
  ensureIdentityBridge();
  scheduleIdentityHeartbeat(true);
}

function scheduleIdentityHeartbeat(force) {
  identityBridgeForce = identityBridgeForce || !!force;
  if (identityBridgeScheduled) return;
  identityBridgeScheduled = true;
  requestAnimationFrame(function() {
    var forceNow = identityBridgeForce;
    identityBridgeForce = false;
    identityBridgeScheduled = false;
    var list = identityPublishers.slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](forceNow); } catch (_) {}
    }
  });
}

function ensureIdentityBridge() {
  if (identityBridgeInstalled) return;
  identityBridgeInstalled = true;
  // sessionChanged is the only kernel signal we need: it forces a fresh
  // identity heartbeat when the user switches conversations. Subscribing
  // to messagesChanged too added one wakeup per signal commit during
  // streaming without ever altering the identity payload.
  try {
    subscribeRuntime('sessionChanged', function() { scheduleIdentityHeartbeat(true); });
  } catch (_) {}
  setTimeout(function() { scheduleIdentityHeartbeat(true); }, 450);
  setTimeout(function() { scheduleIdentityHeartbeat(true); }, 1800);
  setInterval(function() { scheduleIdentityHeartbeat(false); }, 15000);
  window.addEventListener('focus', function() { scheduleIdentityHeartbeat(true); });
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) scheduleIdentityHeartbeat(true);
  });
  document.addEventListener('click', function() {
    setTimeout(function() { scheduleIdentityHeartbeat(false); }, 0);
  }, true);
}

// ============================================================
// Footer button label abbreviation.
// ============================================================
// Host renders the permission-mode button label in full ("Bypass
// permissions", "Ask before edits", ...). At our 13px footer width those
// wrap or get clipped by the host's own truncation. Strip them down to
// the first word ("Bypass", "Ask", ...) — the parent button keeps the
// full sentence in its `title` attribute, so hover still discloses the
// mode description.
//
// Why scope to the footer instead of `document.body`: a `characterData`
// observer on body subtree disables Chromium's IME paint optimization
// and re-introduces the phantom-glyph bug (see "IME paint 残留 bug" in
// memo). The footer is a sibling of `inputContainer`, never an ancestor
// of the editor, so its observer cannot reach the contenteditable node.
function setupFooterAbbreviation() {
  let footerObs = null;
  let attachedFooter = null;

  function firstWord(text) {
    const m = (text || '').trim().match(/^\S+/);
    return m ? m[0] : '';
  }

  // Idempotent: stores the original full text on the span itself, so a
  // repeat scan against an already-abbreviated label is a no-op. When
  // React swaps in a different mode label, current text no longer
  // matches `firstWord(stored)` and we re-derive.
  function abbreviate(span) {
    if (!span || span.nodeType !== 1) return;
    const cur = span.textContent;
    if (!cur) return;
    const stored = span.dataset.incipitFooterFull;
    if (stored && cur === firstWord(stored)) return;
    const first = firstWord(cur);
    if (!first) return;
    span.dataset.incipitFooterFull = cur;
    if (cur !== first) span.textContent = first;
  }

  function scanAll(root) {
    if (!root || !root.querySelectorAll) return;
    const SEL = '[data-incipit-footer-button-label]';
    if (root.matches?.(SEL)) abbreviate(root);
    root.querySelectorAll(SEL).forEach(abbreviate);
  }

  function attach(footer) {
    if (!footer || footer === attachedFooter) return;
    if (footerObs) footerObs.disconnect();
    attachedFooter = footer;
    scanAll(footer);
    footerObs = new MutationObserver(() => scanAll(footer));
    footerObs.observe(footer, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  const initial = document.querySelector('[data-incipit-input-footer]');
  if (initial) attach(initial);

  // Body-level finder is childList-only (no characterData) and so safe
  // against the IME paint bug. Its only job is to spot footer remounts.
  function nodeCouldContainFooter(node) {
    if (!node || node.nodeType !== 1) return false;
    if (nodeInsideFocusedEditor(node) || nodeInsideMessagesContainer(node)) return false;
    if (node.hasAttribute && node.hasAttribute('data-incipit-input-footer')) return true;
    const cls = classText(node);
    if (cls.indexOf('inputFooter') !== -1) return true;
    return !!(node.querySelector && node.querySelector('[data-incipit-input-footer], [class*="inputFooter"]'));
  }

  const finder = new MutationObserver(mutations => {
    let touched = false;
    for (const mutation of mutations) {
      if (mutationInsideFocusedEditor(mutation)) continue;
      if (mutationTouchesAddedNode(mutation, nodeCouldContainFooter)) { touched = true; break; }
    }
    if (!touched) return;
    const f = document.querySelector('[data-incipit-input-footer]');
    if (f && f !== attachedFooter) attach(f);
  });
  finder.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Inline keyboard symbols → SVG.
// ============================================================
// The host renders shortcut hints like `⇧ + tab to switch` using
// `<kbd>` chips that contain Unicode modifier glyphs (U+21E7, etc.).
// Cross-platform font fallback for these glyphs is unreliable: Segoe
// UI Symbol on Windows draws a thin stroke arrow that visually
// disagrees with the next-door letter `tab` (Rec Mono Linear, solid
// glyph weight). Replace the character with an inline SVG drawn at
// the same visual weight as a Latin uppercase letter so left and
// right chips read as siblings on every OS.
//
// The map is character-keyed and trivially extensible — add a new
// entry to cover ⌘ ⌥ ⌃ ⏎ ⌫ ⎋ if the host starts shipping them.
function setupKbdSymbols() {
  const SVG_MAP = {
    // ⇧ Shift (U+21E7). viewBox 12×12 matches uppercase letter
    // cap-height proportions; solid fill on currentColor so the
    // chip foreground tints both letter and arrow uniformly.
    '⇧':
      '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"' +
      ' style="display:inline-block;width:0.85em;height:0.85em;' +
      'vertical-align:-0.13em;fill:currentColor">' +
      '<path d="M6 1 L10.5 6 L8 6 L8 11 L4 11 L4 6 L1.5 6 Z"/>' +
      '</svg>',
  };

  const SEL = '[class*="menuHeaderHint"] kbd, [class*="keys_"] kbd';

  function decorate(kbd) {
    if (!kbd || kbd.nodeType !== 1) return;
    if (kbd.dataset.incipitKbdSvg === '1') return;
    const txt = (kbd.textContent || '').trim();
    if (txt.length !== 1) return;
    const svg = SVG_MAP[txt];
    if (!svg) return;
    kbd.dataset.incipitKbdSvg = '1';
    kbd.innerHTML = svg;
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches?.(SEL)) decorate(root);
    root.querySelectorAll(SEL).forEach(decorate);
  }

  scan(document.body);

  function nodeCouldContainKbdSymbol(node) {
    if (!node || node.nodeType !== 1) return false;
    if (nodeInsideFocusedEditor(node) || nodeInsideMessagesContainer(node)) return false;
    if (String(node.tagName || '').toLowerCase() === 'kbd') return true;
    const cls = classText(node);
    if (cls.indexOf('menuHeaderHint') !== -1 || cls.indexOf('keys_') !== -1) return true;
    return !!(node.querySelector && node.querySelector('kbd, [class*="menuHeaderHint"], [class*="keys_"]'));
  }

  // Body-level childList observer (no characterData → IME-paint safe).
  // Modes/history popups mount on demand, so we cannot just attach
  // once at init.
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      if (mutationInsideFocusedEditor(m)) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && nodeCouldContainKbdSymbol(n)) scan(n);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Cache badge.
// ============================================================
// Data arrives from the extension host through `webview.postMessage`.
// The badge is inserted into the input footer before the bypass control.
function setupCacheBadge() {
  if (!CFG.sessionUsage) return;
  var BADGE_CLASS = 'cceBadge';
  var TEXT_CLASS = 'cceBadgeText';
  var POPUP_CLASS = 'cceStatPopup';
  // Outline icon with descending bars for a lightweight stats metaphor.
  var ICON_SVG = '<svg class="cceBadgeIcon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="4" y1="6" x2="16" y2="6"/>' +
    '<line x1="4" y1="10" x2="13" y2="10"/>' +
    '<line x1="4" y1="14" x2="9" y2="14"/>' +
    '</svg>';
  // The "Ctx" word is dropped entirely — the badge's own leading three-bar icon
  // (ICON_SVG) already reads as the context indicator right before the value.
  // Only "Cache" gets an inline stand-in glyph: a database cylinder.
  var CACHE_GLYPH_SVG = '<svg class="cceBadgeGlyph" width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<ellipse cx="8" cy="4" rx="4.6" ry="1.9"/>' +
    '<path d="M3.4 4 V12 C3.4 13.05 5.45 13.9 8 13.9 C10.55 13.9 12.6 13.05 12.6 12 V4"/>' +
    '<path d="M3.4 8 C3.4 9.05 5.45 9.9 8 9.9 C10.55 9.9 12.6 9.05 12.6 8"/>' +
    '</svg>';
  var latest = null;       // Latest payload: ctx/hit plus recent and totals.
  var popupEl = null;
  var popupAnchor = null;  // Badge button currently anchoring the popup.
  var lastIdentityKey = null;
  var identityPublishScheduled = false;
  var identityPublishForce = false;
  var identityPublishNeedsHistory = false;
  var historyRequestScheduled = false;
  var hitRangeStart = 0;
  var hitRangeEnd = 1;
  var hitRangeRenderScheduled = false;
  var selectedHitRows = null;

  function getIncipitVsCodeApi() {
    try {
      if (typeof globalThis.__incipitGetVsCodeApi === 'function') {
        return globalThis.__incipitGetVsCodeApi();
      }
      if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
    } catch (_) {}
    return null;
  }

  function publishBadgeIdentity(force, includeHistory) {
    identityPublishScheduled = false;
    var api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') return;
    var identity = currentSessionIdentity();
    var sessionId = identity.sessionId;
    var cwd = identity.cwd;
    var key = (sessionId || '') + '\n' + (cwd || '');
    if (!force && !includeHistory && key === lastIdentityKey) return;
    var identityChanged = key !== lastIdentityKey;
    lastIdentityKey = key;
    if (identityChanged) {
      latest = null;
      hitRangeStart = 0;
      hitRangeEnd = 1;
      selectedHitRows = null;
      ensureBadge();
      if (isOpen()) { renderPopup(); positionPopup(); }
    }
    try {
      api.postMessage({
        __incipit: true,
        type: 'badge_identity_update',
        sessionId: sessionId || null,
        cwd: cwd || null,
        includeHistory: !!includeHistory,
      });
    } catch (_) {}
  }

  function scheduleBadgeIdentityPublish(force, includeHistory) {
    identityPublishForce = identityPublishForce || !!force;
    identityPublishNeedsHistory = identityPublishNeedsHistory || !!includeHistory;
    if (identityPublishScheduled) return;
    identityPublishScheduled = true;
    requestAnimationFrame(function() {
      var forceNow = identityPublishForce;
      var needsHistoryNow = identityPublishNeedsHistory;
      identityPublishForce = false;
      identityPublishNeedsHistory = false;
      publishBadgeIdentity(forceNow, needsHistoryNow);
    });
  }

  function requestBadgeHistory() {
    if (historyRequestScheduled) return;
    historyRequestScheduled = true;
    requestAnimationFrame(function() {
      historyRequestScheduled = false;
      if (isOpen()) scheduleBadgeIdentityPublish(true, true);
    });
  }

  function setupBadgeIdentityBridge() {
    registerIdentityPublisher(function(force) {
      publishBadgeIdentity(force, false);
    });
  }

  function fmtTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) {
      var k = n / 1000;
      return (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + 'k';
    }
    return String(n);
  }
  function fmtPct(p) {
    if (!Number.isFinite(p) || p < 0) return '—';
    return (p * 100).toFixed(2) + '%';
  }
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }
  function sameLocalDate(a, b) {
    return !!(a && b &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate());
  }
  function fmtChartTime(iso, rangeStartIso, rangeEndIso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var start = rangeStartIso ? new Date(rangeStartIso) : null;
    var end = rangeEndIso ? new Date(rangeEndIso) : null;
    var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (sameLocalDate(start, end)) return time;
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + time;
  }
  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return t('duration_s', { n: s });
    var m = Math.round(s / 60);
    if (m < 60) return t('duration_min', { n: m });
    var h = Math.floor(m / 60), mm = m % 60;
    return mm
      ? t('duration_h_min', { h: h, m: t('duration_min', { n: mm }) })
      : t('duration_h_exact', { h: h });
  }
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  function axisPct(p) {
    if (!Number.isFinite(p)) return '—';
    return Math.round(p * 100) + '%';
  }
  function svgNumber(n) {
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '0';
  }
  function pctNumber(n) {
    if (!Number.isFinite(n) || n <= 0) return '0';
    return String(Math.round(n * 10) / 10);
  }
  function rowTimeMs(row, fallback) {
    if (row && row.ts) {
      var t = Date.parse(row.ts);
      if (!isNaN(t)) return t;
    }
    return fallback;
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function revealVal(el, target) {
    if (el.__cceRAF) { cancelAnimationFrame(el.__cceRAF); el.__cceRAF = null; }
    if (!target) { el.textContent = ''; return; }
    var len = target.length;
    var display = new Array(len + 1).join(' ');
    // Frame-counted instead of timestamp-based: STEP=40ms vs rAF's 16.67ms
    // gave a 2-2-3-2-3 cadence that read as jitter. N frames per step keeps
    // every advance landing on a vsync edge — clean rhythm at any refresh
    // rate, slightly faster on 120Hz panels (acceptable trade for stability).
    var FRAMES_PER_STEP = 16;
    var index = 0, frameSkip = 0;
    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    function frame() {
      if (frameSkip < FRAMES_PER_STEP - 1) {
        frameSkip++;
        el.__cceRAF = requestAnimationFrame(frame);
        return;
      }
      frameSkip = 0;
      if (index - 3 >= len) {
        el.textContent = target;
        el.__cceRAF = null;
        return;
      }
      var arr = display.split('');
      for (var w = 0; w <= 3; w++) {
        var F = index - w;
        if (F >= 0 && F < len) {
          var ch = target[F];
          if (ch === ' ') arr[F] = ' ';
          else if (w === 3) arr[F] = ch;
          else if (w === 0) arr[F] = '\u258C';
          else arr[F] = pick(['.', '_', ch]);
        }
      }
      display = arr.join('');
      el.textContent = display;
      index++;
      el.__cceRAF = requestAnimationFrame(frame);
    }
    el.__cceRAF = requestAnimationFrame(frame);
  }
  // Some backends expose no prompt-cache counters at all.
  // Show `—` instead of `0%` so the UI reads as unsupported, not as a miss.
  function sessionHasNoCache(payload) {
    if (!payload || !payload.totals) return false;
    var T = payload.totals;
    return (T.cr || 0) === 0 && (T.cw || 0) === 0;
  }
  function renderText(textEl) {
    if (!textEl) return;
    var ctxStr, hitStr;
    if (!latest) {
      ctxStr = '—'; hitStr = '—';
    } else {
      ctxStr = fmtTokens(latest.ctx);
      hitStr = sessionHasNoCache(latest) ? '—' : fmtPct(latest.hit);
    }
    if (!textEl.__cceBuilt) {
      textEl.innerHTML =
        '<span class="cceBadgeVal" data-cce-val="ctx" title="' + escapeAttr(t('ctx_window')) + '"></span>' +
        '    ' +
        '<span class="cceBadgeLabel" title="' + escapeAttr(t('cache_hit_rate')) + '">' + CACHE_GLYPH_SVG + '</span> ' +
        '<span class="cceBadgeVal" data-cce-val="hit"></span>';
      textEl.__cceBuilt = true;
    }
    var ctxEl = textEl.querySelector('[data-cce-val="ctx"]');
    var hitEl = textEl.querySelector('[data-cce-val="hit"]');
    if (ctxEl && ctxEl.__cceLast !== ctxStr) {
      var firstCtx = ctxEl.__cceLast === undefined;
      ctxEl.__cceLast = ctxStr;
      if (firstCtx) ctxEl.textContent = ctxStr;
      else revealVal(ctxEl, ctxStr);
    }
    if (hitEl && hitEl.__cceLast !== hitStr) {
      var firstHit = hitEl.__cceLast === undefined;
      hitEl.__cceLast = hitStr;
      if (firstHit) hitEl.textContent = hitStr;
      else revealVal(hitEl, hitStr);
    }
  }

  function buildPopup() {
    var el = document.createElement('div');
    el.className = POPUP_CLASS;
    el.setAttribute('role', 'dialog');
    el.innerHTML =
      '<div class="cceStatOverview" data-overview></div>' +
      '<div class="cceStatSection">' +
        '<div class="cceStatHeading">' + escapeAttr(t('cache_hit_history')) + '</div>' +
        '<div class="cceHitChart" data-history></div>' +
      '</div>' +
      '<div class="cceStatDivider"></div>' +
      '<div class="cceStatSection">' +
        '<div class="cceStatHeading">' + escapeAttr(t('selected_range')) + '</div>' +
        '<div class="cceStatTotals" data-totals></div>' +
      '</div>';
    el.addEventListener('click', function(ev) { ev.stopPropagation(); });
    return el;
  }
  // The host transports cache history as bounded aggregate buckets
  // (see host-badge.cjs payloadHistoryBuckets): each carries EXACT
  // partial sums for the real requests it spans plus min/max/last hit
  // for a peak-preserving redraw. A `c === 1` bucket is one request.
  // `latest.recent` (fallback) is still the old per-request shape
  // (`{ts,ctx,hit,input,cw,cr,output}`), so map both: a per-request
  // entry is just a 1-count bucket whose lo/hi/sumHit equal its hit.
  function normalizeHistoryRow(r) {
    var hit = clamp(Number.isFinite(r.hit) ? r.hit : 0, 0, 1);
    var isBucket = Number.isFinite(r.c);
    var count = isBucket ? Math.max(1, r.c | 0) : 1;
    var ts = r.ts || '';
    return {
      count: count,
      ts: ts,
      ts0: r.t0 || ts,
      hit: hit,
      ctx: Number.isFinite(r.ctx) ? r.ctx : 0,
      lo: clamp(Number.isFinite(r.lo) ? r.lo : hit, 0, 1),
      loCtx: Number.isFinite(r.loC) ? r.loC : (Number.isFinite(r.ctx) ? r.ctx : 0),
      loTs: r.loT || ts,
      hi: clamp(Number.isFinite(r.hi) ? r.hi : hit, 0, 1),
      fresh: isBucket
        ? (Number.isFinite(r.f) ? r.f : 0)
        : (Number.isFinite(r.input) ? r.input : 0),
      write: isBucket
        ? (Number.isFinite(r.w) ? r.w : 0)
        : (Number.isFinite(r.cw) ? r.cw : (Number.isFinite(r.write) ? r.write : 0)),
      read: isBucket
        ? (Number.isFinite(r.r) ? r.r : 0)
        : (Number.isFinite(r.cr) ? r.cr : (Number.isFinite(r.read) ? r.read : 0)),
      output: isBucket
        ? (Number.isFinite(r.o) ? r.o : 0)
        : (Number.isFinite(r.output) ? r.output : 0),
      sumHit: isBucket ? (Number.isFinite(r.hs) ? r.hs : hit) : hit,
    };
  }
  function cacheHistoryRows() {
    var rows = latest && Array.isArray(latest.history) ? latest.history : null;
    if (!rows || !rows.length) rows = latest && Array.isArray(latest.recent) ? latest.recent : [];
    return rows
      .filter(function(r) {
        return r && Number.isFinite(r.hit) && r.hit >= 0;
      })
      .map(normalizeHistoryRow);
  }
  function sameBadgePayloadIdentity(a, b) {
    if (!a || !b) return false;
    var aSession = a.sessionId || '';
    var bSession = b.sessionId || '';
    var aSrc = a.src || '';
    var bSrc = b.src || '';
    return (!aSession || !bSession || aSession === bSession) &&
           (!aSrc || !bSrc || aSrc === bSrc);
  }
  function mergeRetainedHistory(payload) {
    if (!payload || Array.isArray(payload.history)) return payload;
    if (!latest || !Array.isArray(latest.history) || !sameBadgePayloadIdentity(payload, latest)) {
      return payload;
    }
    var merged = {};
    for (var key in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) merged[key] = payload[key];
    }
    merged.history = latest.history;
    return merged;
  }
  function minHitRangeFraction(count) {
    if (!Number.isFinite(count) || count <= 2) return 1;
    return Math.min(0.25, Math.max(6 / Math.max(1, count - 1), 0.015));
  }
  function normalizeHitRange(count) {
    if (!Number.isFinite(count) || count <= 1) {
      hitRangeStart = 0;
      hitRangeEnd = 1;
      return { start: 0, end: 1, min: 1 };
    }
    var min = minHitRangeFraction(count);
    var start = clamp(hitRangeStart, 0, 1);
    var end = clamp(hitRangeEnd, 0, 1);
    if (end < start) {
      var tmp = start;
      start = end;
      end = tmp;
    }
    if (end - start < min) {
      var center = clamp((start + end) / 2, min / 2, 1 - min / 2);
      start = center - min / 2;
      end = center + min / 2;
    }
    hitRangeStart = clamp(start, 0, 1 - min);
    hitRangeEnd = clamp(end, hitRangeStart + min, 1);
    return { start: hitRangeStart, end: hitRangeEnd, min: min };
  }
  function visibleHistoryRows(rows) {
    if (!rows || !rows.length) return [];
    var range = normalizeHitRange(rows.length);
    if (range.start <= 0.0001 && range.end >= 0.9999) return rows.slice();
    var maxIndex = rows.length - 1;
    var startIndex = Math.floor(range.start * maxIndex);
    var endIndex = Math.ceil(range.end * maxIndex);
    startIndex = Math.max(0, Math.min(maxIndex, startIndex));
    endIndex = Math.max(startIndex, Math.min(maxIndex, endIndex));
    return rows.slice(startIndex, endIndex + 1);
  }
  function setHitRange(start, end) {
    var rows = cacheHistoryRows();
    var count = rows.length;
    var min = minHitRangeFraction(count);
    start = clamp(start, 0, 1);
    end = clamp(end, 0, 1);
    if (end < start) {
      var t = start;
      start = end;
      end = t;
    }
    if (end - start < min) {
      if (Math.abs(start - hitRangeStart) > Math.abs(end - hitRangeEnd)) end = start + min;
      else start = end - min;
    }
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > 1) {
      start -= end - 1;
      end = 1;
    }
    start = clamp(start, 0, Math.max(0, 1 - min));
    end = clamp(end, Math.min(1, start + min), 1);
    if (Math.abs(start - hitRangeStart) < 0.0005 && Math.abs(end - hitRangeEnd) < 0.0005) return;
    hitRangeStart = start;
    hitRangeEnd = end;
    scheduleHitRangeRender();
  }
  function scheduleHitRangeRender() {
    if (hitRangeRenderScheduled) return;
    hitRangeRenderScheduled = true;
    requestAnimationFrame(function() {
      hitRangeRenderScheduled = false;
      if (!isOpen()) return;
      renderPopup();
      positionPopup();
    });
  }
  // Rows are aggregate buckets, so totals are Σ of per-bucket EXACT
  // partial sums, request count is Σ count (not rows.length), and the
  // mean is Σ sumHit / Σ count (request-weighted, not bucket-weighted).
  // For 1-count buckets this is identical to the old per-request math.
  function summarizeHistoryRows(rows) {
    rows = rows || [];
    var out = {
      requests: 0,
      fresh: 0,
      write: 0,
      read: 0,
      output: 0,
      totalContext: 0,
      latestHit: rows.length ? rows[rows.length - 1].hit : NaN,
      meanHit: NaN,
      minHit: NaN,
      durationMs: 0,
      firstTs: rows.length ? rows[0].ts0 : '',
      lastTs: rows.length ? rows[rows.length - 1].ts : '',
    };
    if (!rows.length) return out;
    var hitSum = 0;
    var minHit = 1;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.requests += r.count || 0;
      out.fresh += r.fresh || 0;
      out.write += r.write || 0;
      out.read += r.read || 0;
      out.output += r.output || 0;
      hitSum += r.sumHit || 0;
      minHit = Math.min(minHit, r.lo);
    }
    out.totalContext = out.fresh + out.write + out.read;
    out.meanHit = out.requests > 0 ? hitSum / out.requests : NaN;
    out.minHit = minHit;
    var first = Date.parse(out.firstTs);
    var last = Date.parse(out.lastTs);
    if (!isNaN(first) && !isNaN(last) && last >= first) out.durationMs = last - first;
    return out;
  }
  function rangeTimeLabel(rows) {
    if (!rows || !rows.length) return '—';
    var first = rows[0].ts0 || rows[0].ts;
    var last = rows[rows.length - 1].ts;
    if (rows.length === 1 && first === last) return fmtChartTime(first, first, last);
    return fmtChartTime(first, first, last) + ' - ' + fmtChartTime(last, first, last);
  }
  function sampledLinePoints(points, maxBuckets) {
    if (!points || points.length <= maxBuckets * 2) return points || [];
    var buckets = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var b = Math.max(0, Math.min(maxBuckets - 1, Math.floor((p.xNorm || 0) * maxBuckets)));
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(p);
    }
    var out = [];
    var seen = new Set();
    function add(p) {
      if (!p || seen.has(p.index)) return;
      seen.add(p.index);
      out.push(p);
    }
    for (var j = 0; j < buckets.length; j++) {
      var group = buckets[j];
      if (!group || !group.length) continue;
      var minY = group[0];
      var maxY = group[0];
      for (var k = 1; k < group.length; k++) {
        if (group[k].y < minY.y) minY = group[k];
        if (group[k].y > maxY.y) maxY = group[k];
      }
      add(group[0]);
      add(minY);
      add(maxY);
      add(group[group.length - 1]);
    }
    out.sort(function(a, b) { return a.index - b.index; });
    return out;
  }
  function pathFromPoints(points) {
    return (points || []).map(function(p, i) {
      return (i ? 'L' : 'M') + svgNumber(p.x) + ' ' + svgNumber(p.y);
    }).join(' ');
  }
  function renderOverview(box) {
    if (!box) return;
    var hitStr = latest && !sessionHasNoCache(latest) ? fmtPct(latest.hit) : '—';
    var ctxStr = latest ? fmtTokens(latest.ctx) : '—';
    box.innerHTML =
      '<div class="cceStatMetric">' +
        '<div class="cceStatMetricLabel">' + escapeAttr(t('current_cache')) + '</div>' +
        '<div class="cceStatMetricValue">' + hitStr + '</div>' +
      '</div>' +
      '<div class="cceStatMetric">' +
        '<div class="cceStatMetricLabel">' + escapeAttr(t('context')) + '</div>' +
        '<div class="cceStatMetricValue">' + ctxStr + '</div>' +
      '</div>';
  }
  function renderHistoryChart(box) {
    if (!box) return;
    if (!latest || sessionHasNoCache(latest)) {
      selectedHitRows = null;
      box.innerHTML = '<div class="cceStatEmpty">' + escapeAttr(t('no_cache_history')) + '</div>';
      return;
    }

    var fullRows = cacheHistoryRows();
    if (!fullRows.length) {
      selectedHitRows = null;
      box.innerHTML = '<div class="cceStatEmpty">' + escapeAttr(t('no_cache_history')) + '</div>';
      return;
    }

    var range = normalizeHitRange(fullRows.length);
    var rows = visibleHistoryRows(fullRows);
    selectedHitRows = rows;
    // Bucket-aware: the visible envelope is min(lo)/max(hi) over the
    // covered buckets, the mean is Σ sumHit / Σ count (request-weighted,
    // exact), and `lowRowIndex` is the bucket holding the global low.
    var minHit = 1, maxHit = 0, hitSum = 0, reqCount = 0, lowRowIndex = 0;
    for (var si = 0; si < rows.length; si++) {
      var sr = rows[si];
      if (sr.lo < minHit) { minHit = sr.lo; lowRowIndex = si; }
      if (sr.hi > maxHit) maxHit = sr.hi;
      hitSum += sr.sumHit || 0;
      reqCount += sr.count || 0;
    }
    if (!rows.length) { minHit = 0; maxHit = 0; }
    var mean = reqCount > 0 ? hitSum / reqCount : 0;
    var latestHit = rows.length ? rows[rows.length - 1].hit : 0;

    var spread = maxHit - minHit;
    var pad = Math.max(0.02, spread * 0.3);
    var domainMin = clamp(Math.floor((minHit - pad) * 100) / 100, 0, 1);
    var domainMax = clamp(Math.ceil((maxHit + pad) * 100) / 100, 0, 1);
    if (domainMax - domainMin < 0.06) {
      var center = (domainMax + domainMin) / 2;
      domainMin = clamp(center - 0.03, 0, 1);
      domainMax = clamp(center + 0.03, 0, 1);
      if (domainMax - domainMin < 0.06) {
        if (domainMin <= 0) domainMax = clamp(domainMin + 0.06, 0, 1);
        else domainMin = clamp(domainMax - 0.06, 0, 1);
      }
    }

    var W = 500, H = 184, padL = 36, padR = 12, padT = 30, padB = 26;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var denom = Math.max(1, rows.length - 1);
    function xAt(i) { return padL + (i / denom) * plotW; }
    function yAt(hit) {
      return padT + ((domainMax - hit) / Math.max(0.001, domainMax - domainMin)) * plotH;
    }
    // One logical point per bucket drives hover indexing + markers.
    var points = rows.map(function(r, i) {
      var xNorm = denom ? i / denom : 0;
      return { index: i, xNorm: xNorm, x: xAt(i), y: yAt(r.hit), hit: r.hit, ctx: r.ctx, ts: r.ts, count: r.count };
    });
    // Peak-preserving polyline. A 1-request bucket stays a single
    // vertex (identical to the old per-request line). A multi-request
    // bucket expands to lo→hi→last across its cell so deep cache-miss
    // crashes survive the host-side bucketing.
    var pathVertices = [];
    var cellW = plotW / Math.max(1, denom);
    var vIdx = 0;
    for (var pvi = 0; pvi < rows.length; pvi++) {
      var pvr = rows[pvi];
      var pcx = xAt(pvi);
      if (pvr.count <= 1 || (pvr.lo === pvr.hi && pvr.hi === pvr.hit)) {
        pathVertices.push({ index: vIdx++, xNorm: (pcx - padL) / plotW, x: pcx, y: yAt(pvr.hit) });
        continue;
      }
      var pxa = clamp(pcx - cellW * 0.35, padL, padL + plotW);
      var pxc = clamp(pcx + cellW * 0.35, padL, padL + plotW);
      pathVertices.push({ index: vIdx++, xNorm: (pxa - padL) / plotW, x: pxa, y: yAt(pvr.lo) });
      pathVertices.push({ index: vIdx++, xNorm: (pcx - padL) / plotW, x: pcx, y: yAt(pvr.hi) });
      pathVertices.push({ index: vIdx++, xNorm: (pxc - padL) / plotW, x: pxc, y: yAt(pvr.hit) });
    }
    var path = pathFromPoints(sampledLinePoints(pathVertices, Math.max(120, Math.floor(plotW))));
    var lowRow = rows[lowRowIndex];
    var lowPoint = (lowRow && points[lowRowIndex]) ? {
      x: points[lowRowIndex].x,
      y: yAt(lowRow.lo),
      hit: lowRow.lo,
      ctx: lowRow.loCtx,
      ts: lowRow.loTs,
    } : null;
    var latestPoint = points[points.length - 1];
    var mid = (domainMin + domainMax) / 2;
    var newestTs = rows[rows.length - 1] && rows[rows.length - 1].ts;
    var oldestTs = rows[0] && (rows[0].ts0 || rows[0].ts);
    var markers = '';
    if (lowPoint) {
      markers += '<circle class="cceHitPoint cceHitPointLow" cx="' + svgNumber(lowPoint.x) + '" cy="' + svgNumber(lowPoint.y) + '" r="3.4">' +
        '<title>' + escapeAttr(t('lowest_tip', { pct: fmtPct(lowPoint.hit), ctx: fmtTokens(lowPoint.ctx), time: fmtChartTime(lowPoint.ts, oldestTs, newestTs) })) + '</title>' +
      '</circle>';
    }
    var latestIsLow = !!(lowPoint && latestPoint &&
      Math.abs(lowPoint.x - latestPoint.x) < 0.01 &&
      Math.abs(lowPoint.y - latestPoint.y) < 0.01);
    if (latestPoint && !latestIsLow) {
      markers += '<circle class="cceHitPoint cceHitPointLatest" cx="' + svgNumber(latestPoint.x) + '" cy="' + svgNumber(latestPoint.y) + '" r="3">' +
        '<title>' + escapeAttr(t('latest_tip', { pct: fmtPct(latestPoint.hit), ctx: fmtTokens(latestPoint.ctx), time: fmtChartTime(latestPoint.ts, oldestTs, newestTs) })) + '</title>' +
      '</circle>';
    }
    var midIndex = Math.floor((rows.length - 1) / 2);
    var midPoint = points[midIndex] || points[0];
    var midTs = rows[midIndex] && rows[midIndex].ts;
    var topLabel = axisPct(domainMax);
    var midLabel = axisPct(mid);
    var bottomLabel = axisPct(domainMin);
    var axisY = H - padB;
    var midX = midPoint ? svgNumber(midPoint.x) : svgNumber(padL + plotW / 2);
    var oldestLabel = fmtChartTime(oldestTs, oldestTs, newestTs);
    var midTimeLabel = fmtChartTime(midTs, oldestTs, newestTs);
    var newestLabel = fmtChartTime(newestTs, oldestTs, newestTs);
    var fullMinHit = 1, fullMaxHit = 0;
    for (var fri = 0; fri < fullRows.length; fri++) {
      if (fullRows[fri].lo < fullMinHit) fullMinHit = fullRows[fri].lo;
      if (fullRows[fri].hi > fullMaxHit) fullMaxHit = fullRows[fri].hi;
    }
    if (!fullRows.length) { fullMinHit = 0; fullMaxHit = 0; }
    var overviewPad = Math.max(0.02, (fullMaxHit - fullMinHit) * 0.25);
    var overviewMin = clamp(fullMinHit - overviewPad, 0, 1);
    var overviewMax = clamp(fullMaxHit + overviewPad, 0, 1);
    if (overviewMax - overviewMin < 0.06) {
      var overviewCenter = (overviewMax + overviewMin) / 2;
      overviewMin = clamp(overviewCenter - 0.03, 0, 1);
      overviewMax = clamp(overviewCenter + 0.03, 0, 1);
      if (overviewMax - overviewMin < 0.06) {
        if (overviewMin <= 0) overviewMax = clamp(overviewMin + 0.06, 0, 1);
        else overviewMin = clamp(overviewMax - 0.06, 0, 1);
      }
    }
    var rangeH = 44, rangePadT = 8, rangePadB = 14;
    var rangePlotH = rangeH - rangePadT - rangePadB;
    var fullDenom = Math.max(1, fullRows.length - 1);
    function rangeYAt(hit) {
      return rangePadT + ((overviewMax - hit) / Math.max(0.001, overviewMax - overviewMin)) * rangePlotH;
    }
    // Same peak-preserving expansion for the brush mini-chart so its
    // crash dips match the main line.
    var overviewPoints = [];
    var oIdx = 0;
    for (var ori = 0; ori < fullRows.length; ori++) {
      var orw = fullRows[ori];
      var oxN = ori / fullDenom;
      var ox = padL + oxN * plotW;
      if (orw.count <= 1 || orw.lo === orw.hi) {
        overviewPoints.push({ index: oIdx++, xNorm: oxN, x: ox, y: rangeYAt(orw.hit) });
      } else {
        overviewPoints.push({ index: oIdx++, xNorm: oxN, x: ox, y: rangeYAt(orw.lo) });
        overviewPoints.push({ index: oIdx++, xNorm: oxN, x: ox, y: rangeYAt(orw.hi) });
      }
    }
    var overviewPath = pathFromPoints(sampledLinePoints(overviewPoints, 180));
    var selX1 = padL + range.start * plotW;
    var selX2 = padL + range.end * plotW;
    var selWidth = Math.max(2, selX2 - selX1);

    box.innerHTML =
      '<div class="cceHitChartShell">' +
        '<svg class="cceHitSvg" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
          '<line class="cceHitGrid" x1="' + padL + '" y1="' + svgNumber(yAt(domainMax)) + '" x2="' + (W - padR) + '" y2="' + svgNumber(yAt(domainMax)) + '"></line>' +
          '<line class="cceHitGrid" x1="' + padL + '" y1="' + svgNumber(yAt(mid)) + '" x2="' + (W - padR) + '" y2="' + svgNumber(yAt(mid)) + '"></line>' +
          '<line class="cceHitGrid" x1="' + padL + '" y1="' + svgNumber(yAt(domainMin)) + '" x2="' + (W - padR) + '" y2="' + svgNumber(yAt(domainMin)) + '"></line>' +
          '<line class="cceHitXAxis" x1="' + padL + '" y1="' + axisY + '" x2="' + (W - padR) + '" y2="' + axisY + '"></line>' +
          '<line class="cceHitXTick" x1="' + padL + '" y1="' + axisY + '" x2="' + padL + '" y2="' + (axisY + 4) + '"></line>' +
          '<line class="cceHitXTick" x1="' + midX + '" y1="' + axisY + '" x2="' + midX + '" y2="' + (axisY + 4) + '"></line>' +
          '<line class="cceHitXTick" x1="' + (W - padR) + '" y1="' + axisY + '" x2="' + (W - padR) + '" y2="' + (axisY + 4) + '"></line>' +
          '<text class="cceHitAxisLabel" x="0" y="' + svgNumber(yAt(domainMax) + 3) + '">' + topLabel + '</text>' +
          '<text class="cceHitAxisLabel" x="0" y="' + svgNumber(yAt(mid) + 3) + '">' + midLabel + '</text>' +
          '<text class="cceHitAxisLabel" x="0" y="' + svgNumber(yAt(domainMin) + 3) + '">' + bottomLabel + '</text>' +
          '<path class="cceHitLine" d="' + path + '"></path>' +
          markers +
          '<g class="cceHitHover" aria-hidden="true">' +
            '<line class="cceHitHoverLine" x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '"></line>' +
            '<circle class="cceHitHoverPoint" cx="' + padL + '" cy="' + padT + '" r="3.2"></circle>' +
          '</g>' +
        '</svg>' +
        '<div class="cceHitHoverLabel" data-hit-hover-label></div>' +
        '<div class="cceHitChartMeta">' +
          '<span>' + oldestLabel + '</span>' +
          '<span>' + midTimeLabel + '</span>' +
          '<span>' + newestLabel + '</span>' +
        '</div>' +
        '<div class="cceHitRange" data-hit-range>' +
          '<svg class="cceRangeSvg" viewBox="0 0 ' + W + ' ' + rangeH + '" aria-hidden="true">' +
            '<path class="cceRangeLine" d="' + overviewPath + '"></path>' +
            '<line class="cceRangeTrack" x1="' + padL + '" y1="' + (rangeH - 8) + '" x2="' + (W - padR) + '" y2="' + (rangeH - 8) + '"></line>' +
            '<rect class="cceRangeHit cceRangeTrackHit" data-range-part="track" x="' + padL + '" y="0" width="' + plotW + '" height="' + rangeH + '"></rect>' +
            '<rect class="cceRangeWindow" data-range-part="move" x="' + svgNumber(selX1) + '" y="5" width="' + svgNumber(selWidth) + '" height="28" rx="4"></rect>' +
            '<line class="cceRangeHandle" x1="' + svgNumber(selX1) + '" y1="4" x2="' + svgNumber(selX1) + '" y2="34"></line>' +
            '<line class="cceRangeHandle" x1="' + svgNumber(selX2) + '" y1="4" x2="' + svgNumber(selX2) + '" y2="34"></line>' +
            '<rect class="cceRangeHit cceRangeMoveHit" data-range-part="move" x="' + svgNumber(selX1 + 8) + '" y="0" width="' + svgNumber(Math.max(0, selWidth - 16)) + '" height="36"></rect>' +
            '<rect class="cceRangeHit cceRangeHandleHit" data-range-part="start" x="' + svgNumber(selX1 - 8) + '" y="0" width="16" height="36"></rect>' +
            '<rect class="cceRangeHit cceRangeHandleHit" data-range-part="end" x="' + svgNumber(selX2 - 8) + '" y="0" width="16" height="36"></rect>' +
          '</svg>' +
        '</div>' +
      '</div>' +
      '<div class="cceHitStats">' +
        '<div class="cceHitStat"><span>' + escapeAttr(t('latest')) + '</span><strong>' + fmtPct(latestHit) + '</strong></div>' +
        '<div class="cceHitStat"><span>' + escapeAttr(t('mean')) + '</span><strong>' + fmtPct(mean) + '</strong></div>' +
        '<div class="cceHitStat"><span>' + escapeAttr(t('lowest')) + '</span><strong>' + fmtPct(minHit) + '</strong></div>' +
      '</div>';

    bindHitChartHover(box, points, {
      width: W,
      padLeft: padL,
      padRight: padR,
      padTop: padT,
      padBottom: padB,
      plotWidth: plotW,
      rangeStart: oldestTs,
      rangeEnd: newestTs,
    });
    bindHitRangeSlider(box, {
      width: W,
      padLeft: padL,
      padRight: padR,
      plotWidth: plotW,
      count: fullRows.length,
    });
  }
  function bindHitChartHover(box, points, dims) {
    if (!box || !points || !points.length) return;
    var svg = box.querySelector('.cceHitSvg');
    var shell = box.querySelector('.cceHitChartShell');
    var line = box.querySelector('.cceHitHoverLine');
    var dot = box.querySelector('.cceHitHoverPoint');
    var label = box.querySelector('[data-hit-hover-label]');
    if (!svg || !shell || !line || !dot || !label) return;
    if (!label.__cceHitHoverBuilt) {
      label.innerHTML =
        '<span class="cceHitHoverPct" data-hit-hover-pct></span>' +
        '<span class="cceHitHoverTime" data-hit-hover-time></span>';
      label.__cceHitHoverBuilt = true;
    }
    var pctEl = label.querySelector('[data-hit-hover-pct]');
    var timeEl = label.querySelector('[data-hit-hover-time]');

    var raf = 0;
    var lastEvent = null;

    function hideHover() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      lastEvent = null;
      svg.removeAttribute('data-hit-hovering');
      label.removeAttribute('data-active');
    }

    function applyHover(evt) {
      raf = 0;
      if (!evt) return;
      var rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var xSvg = clamp(
        ((evt.clientX - rect.left) / rect.width) * dims.width,
        dims.padLeft,
        dims.width - dims.padRight,
      );
      var denom = Math.max(1, points.length - 1);
      var index = Math.round(((xSvg - dims.padLeft) / Math.max(1, dims.plotWidth)) * denom);
      index = Math.max(0, Math.min(points.length - 1, index));
      var p = points[index];
      if (!p) return;

      var x = svgNumber(p.x);
      var y = svgNumber(p.y);
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);

      if (pctEl) pctEl.textContent = fmtPct(p.hit);
      if (timeEl) timeEl.textContent = fmtChartTime(p.ts, dims.rangeStart, dims.rangeEnd);
      svg.setAttribute('data-hit-hovering', '1');
      label.setAttribute('data-active', '1');

      var shellRect = shell.getBoundingClientRect();
      var xPx = (p.x / dims.width) * rect.width + (rect.left - shellRect.left);
      var labelWidth = label.offsetWidth || 54;
      xPx = clamp(xPx, labelWidth / 2 + 6, shellRect.width - labelWidth / 2 - 6);
      label.style.left = Math.round(xPx) + 'px';
    }

    function scheduleHover(evt) {
      lastEvent = evt;
      if (raf) return;
      raf = requestAnimationFrame(function() { applyHover(lastEvent); });
    }

    svg.addEventListener('pointermove', scheduleHover);
    svg.addEventListener('pointerleave', hideHover);
    svg.addEventListener('pointercancel', hideHover);
  }
  function bindHitRangeSlider(box, dims) {
    if (!box || !dims || dims.count <= 1) return;
    var svg = box.querySelector('.cceRangeSvg');
    if (!svg) return;
    var drag = null;
    function eventFrac(evt) {
      var rect = drag && drag.rect ? drag.rect : svg.getBoundingClientRect();
      if (!rect.width) return hitRangeStart;
      var xSvg = ((evt.clientX - rect.left) / rect.width) * dims.width;
      return clamp((xSvg - dims.padLeft) / Math.max(1, dims.plotWidth), 0, 1);
    }
    function moveWindowTo(center, width) {
      var half = width / 2;
      var start = center - half;
      var end = center + half;
      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > 1) {
        start -= end - 1;
        end = 1;
      }
      setHitRange(start, end);
    }
    function onMove(evt) {
      if (!drag) return;
      evt.preventDefault();
      var frac = eventFrac(evt);
      if (drag.part === 'start') {
        setHitRange(frac, drag.end);
      } else if (drag.part === 'end') {
        setHitRange(drag.start, frac);
      } else {
        moveWindowTo(drag.center + (frac - drag.origin), drag.width);
      }
    }
    function onUp() {
      drag = null;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    }
    svg.addEventListener('pointerdown', function(evt) {
      var target = evt.target;
      var part = target && target.getAttribute ? target.getAttribute('data-range-part') : '';
      var frac = eventFrac(evt);
      var width = Math.max(minHitRangeFraction(dims.count), hitRangeEnd - hitRangeStart);
      if (!part || part === 'track') {
        moveWindowTo(frac, width);
        part = 'move';
      }
      var rect = svg.getBoundingClientRect();
      drag = {
        part: part,
        rect: { left: rect.left, width: rect.width },
        origin: frac,
        start: hitRangeStart,
        end: hitRangeEnd,
        center: (hitRangeStart + hitRangeEnd) / 2,
        width: hitRangeEnd - hitRangeStart,
      };
      evt.preventDefault();
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  }
  function tokenBarWidth(value, max) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
    return Math.max(1.6, (value / max) * 100);
  }
  function renderSessionFlow(box) {
    if (!box) return;
    if (!latest || !latest.totals) {
      box.innerHTML = '<div class="cceStatEmpty">—</div>';
      return;
    }

    var rows = selectedHitRows && selectedHitRows.length ? selectedHitRows : cacheHistoryRows();
    var S = summarizeHistoryRows(rows);
    if (!S.requests) {
      box.innerHTML = '<div class="cceStatEmpty">—</div>';
      return;
    }
    var promptTotal = S.fresh + S.write + S.read;
    var freshPct = promptTotal > 0 ? (S.fresh / promptTotal) * 100 : 0;
    var writePct = promptTotal > 0 ? (S.write / promptTotal) * 100 : 0;
    var readPct = promptTotal > 0 ? (S.read / promptTotal) * 100 : 0;
    var requestLabel = tRequests(S.requests);
    var durationLabel = S.durationMs > 0 ? ' · ' + fmtDuration(S.durationMs) : '';
    function metric(label, value, kind) {
      return '<div class="cceSelectedMetric cceSelectedMetric-' + kind + '">' +
        '<span>' + label + '</span>' +
        '<strong>' + value + '</strong>' +
      '</div>';
    }

    box.innerHTML =
      '<div class="cceFlowContext cceSelectedRange">' +
        '<div class="cceFlowHeader">' +
          '<span>' + escapeAttr(t('selected_range')) + '</span>' +
          '<strong>' + requestLabel + durationLabel + '</strong>' +
        '</div>' +
        '<div class="cceFlowRangeTime">' + rangeTimeLabel(rows) + '</div>' +
        '<div class="cceContextStack" aria-hidden="true">' +
          '<span class="cceContextSeg cceContextSeg-fresh" style="width:' + pctNumber(freshPct) + '%"></span>' +
          '<span class="cceContextSeg cceContextSeg-write" style="width:' + pctNumber(writePct) + '%"></span>' +
          '<span class="cceContextSeg cceContextSeg-read" style="width:' + pctNumber(readPct) + '%"></span>' +
        '</div>' +
        '<div class="cceFlowLegend">' +
          '<span><i class="cceLegendFresh"></i>' + escapeAttr(t('fresh')) + ' ' + fmtTokens(S.fresh) + '</span>' +
          '<span><i class="cceLegendWrite"></i>' + escapeAttr(t('write')) + ' ' + fmtTokens(S.write) + '</span>' +
          '<span><i class="cceLegendRead"></i>' + escapeAttr(t('read')) + ' ' + fmtTokens(S.read) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="cceSelectedGrid">' +
        metric(t('cache_read'), fmtTokens(S.read), 'read') +
        metric(t('cache_write'), fmtTokens(S.write), 'write') +
        metric(t('output'), fmtTokens(S.output), 'output') +
        metric(t('fresh_input'), fmtTokens(S.fresh), 'fresh') +
      '</div>';
  }
  function renderPopup() {
    if (!popupEl) return;
    renderOverview(popupEl.querySelector('[data-overview]'));
    renderHistoryChart(popupEl.querySelector('[data-history]'));
    var totalsBox = popupEl.querySelector('[data-totals]');
    renderSessionFlow(totalsBox);
  }
  function positionPopup() {
    if (!popupEl || !popupAnchor) return;
    var r = popupAnchor.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 8;
    // Clamp the rendered border-box, not just max-width. CSS uses
    // border-box too, so padding cannot push the popup outside the viewport.
    var safeWidth = Math.min(560, Math.max(220, vw - margin * 2));
    popupEl.style.width = safeWidth + 'px';
    popupEl.style.maxWidth = safeWidth + 'px';
    // Read both metrics together, then write left+bottom together. The
    // old read→write→read→write order forced two synchronous layouts
    // for every scroll event while the popup was open.
    var w = popupEl.offsetWidth;
    var h = popupEl.offsetHeight;
    var left = Math.round(r.left);
    if (left + w > vw - margin) left = vw - margin - w;
    if (left < margin) left = margin;
    var bottom = Math.round(vh - r.top + 6);
    var maxBottom = Math.max(margin, vh - h - margin);
    if (bottom > maxBottom) bottom = maxBottom;
    if (bottom < margin) bottom = margin;
    popupEl.style.left = left + 'px';
    popupEl.style.bottom = bottom + 'px';
  }
  function openPopup(anchor) {
    popupAnchor = anchor;
    if (!popupEl) {
      popupEl = buildPopup();
      document.body.appendChild(popupEl);
    }
    popupEl.classList.add('cceStatOpen');
    anchor.classList.add('cceBadgeActive');
    renderPopup();
    positionPopup();
    requestBadgeHistory();
  }
  function closePopup() {
    if (!popupEl) return;
    popupEl.classList.remove('cceStatOpen');
    if (popupAnchor) popupAnchor.classList.remove('cceBadgeActive');
    popupAnchor = null;
  }
  function isOpen() {
    return !!(popupEl && popupEl.classList.contains('cceStatOpen'));
  }

  function ensureBadge() {
    var hosts = document.querySelectorAll(SEL.inputFooterHost);
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      if (!host) continue;
      var badge = host.querySelector(':scope > .' + BADGE_CLASS);
      if (!badge) {
        badge = document.createElement('button');
        badge.type = 'button';
        badge.className = BADGE_CLASS;
        badge.innerHTML = ICON_SVG + '<span class="' + TEXT_CLASS + '"></span>';
        badge.addEventListener('click', function(ev) {
          ev.stopPropagation();
          if (isOpen() && popupAnchor === ev.currentTarget) {
            closePopup();
          } else {
            openPopup(ev.currentTarget);
          }
        });
        host.insertBefore(badge, host.firstChild);
      }
      var textEl = badge.querySelector('.' + TEXT_CLASS);
      renderText(textEl);
    }
  }

  window.addEventListener('message', function(ev) {
    var d = ev && ev.data;
    if (!d || d.__cceBadge !== true || !d.payload) return;
    var current = currentSessionId();
    if (current && d.payload.sessionId && d.payload.sessionId !== current) return;
    var hasFullHistory = Array.isArray(d.payload.history);
    latest = mergeRetainedHistory(d.payload);
    ensureBadge();
    if (isOpen()) {
      if (!hasFullHistory && !d.payload.empty && d.payload.totals) requestBadgeHistory();
      renderPopup();
      positionPopup();
    }
  });

  document.addEventListener('click', function(ev) {
    if (!isOpen()) return;
    var t = ev.target;
    if (popupEl && popupEl.contains(t)) return;
    if (popupAnchor && popupAnchor.contains(t)) return;
    closePopup();
  }, true);
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && isOpen()) closePopup();
  }, true);
  // Coalesce reposition to one run per frame and keep the listeners
  // passive — scroll fires continuously (incl. middle-click autoscroll)
  // and `positionPopup` does layout reads+writes, so the raw per-event
  // version thrashed layout whenever the popup was open.
  var repositionScheduled = false;
  function scheduleReposition() {
    if (!isOpen()) return;
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(function() {
      repositionScheduled = false;
      if (isOpen()) positionPopup();
    });
  }
  window.addEventListener('resize', scheduleReposition, { passive: true });
  window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });

  // `inputFooter` can remount under React, so keep a small observer to
  // reinsert the badge. The observer is coalesced to at most one
  // `ensureBadge` call per animation frame, and it ignores mutations that
  // cannot possibly touch the footer (no `inputFooter`-class node added).
  var ensureScheduled = false;
  function scheduleEnsureBadge() {
    if (ensureScheduled) return;
    ensureScheduled = true;
    requestAnimationFrame(function() { ensureScheduled = false; ensureBadge(); });
  }
  function mutationTouchesFooter(m) {
    if (mutationInsideFocusedEditor(m)) return false;
    for (var i = 0; i < m.addedNodes.length; i++) {
      var n = m.addedNodes[i];
      if (!n || n.nodeType !== 1) continue;
      if (nodeInsideFocusedEditor(n) || nodeInsideMessagesContainer(n)) continue;
      var cls = classText(n);
      if (cls.indexOf('inputFooter') !== -1 || cls.indexOf('Footer') !== -1) return true;
      if (n.querySelector && n.querySelector('[class*="inputFooter"]')) return true;
    }
    return false;
  }

  var mo = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutationTouchesFooter(mutations[i])) { scheduleEnsureBadge(); return; }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  ensureBadge();
  setupBadgeIdentityBridge();
}

// ============================================================
// Header edit-activity chip.
// ============================================================
// A conversation-scoped, GitHub-style edit activity surface. The compact
// header chip stays tiny beside the session title; the heavier 371-cell
// heatmap is rendered only when the user opens the popup.
function setupEditActivityHeader() {
  if (!CFG.sessionUsage) return;

  var CHIP_CLASS = 'cceEditChip';
  var POPUP_CLASS = 'cceEditPopup';
  var MONTHS = CFG.language === 'zh'
    ? ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
    : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var latest = null;       // Current conversation activity, used by the header chip.
  var projectLatest = null; // Current Claude Code project activity, used by the popup header.
  var globalLatest = null;  // Claude Code global activity, used by the heatmap.
  var popupLatestSig = '';
  var popupEl = null;
  var popupAnchor = null;
  var tooltipEl = null;
  var lastIdentityKey = null;
  var identityPublishScheduled = false;
  var identityPublishForce = false;
  var identityPublishNeedsProject = false;

  function getIncipitVsCodeApi() {
    try {
      if (typeof globalThis.__incipitGetVsCodeApi === 'function') {
        return globalThis.__incipitGetVsCodeApi();
      }
      if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
    } catch (_) {}
    return null;
  }

  function publishActivityIdentity(force, includeProject) {
    identityPublishScheduled = false;
    var api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') return;
    var identity = currentSessionIdentity();
    var sessionId = identity.sessionId;
    var cwd = identity.cwd;
    var key = (sessionId || '') + '\n' + (cwd || '');
    if (!force && !includeProject && key === lastIdentityKey) return;
    var identityChanged = key !== lastIdentityKey;
    lastIdentityKey = key;
    if (identityChanged) {
      latest = null;
      projectLatest = null;
      globalLatest = null;
      popupLatestSig = '';
      ensureHeaderChip();
      if (isActivityOpen()) {
        renderActivityPopup();
        positionActivityPopup();
      }
    }
    try {
      api.postMessage({
        __incipit: true,
        type: 'edit_activity_identity_update',
        sessionId: sessionId || null,
        cwd: cwd || null,
        includeProject: !!includeProject,
      });
    } catch (_) {}
  }

  function scheduleActivityIdentityPublish(force, includeProject) {
    identityPublishForce = identityPublishForce || !!force;
    identityPublishNeedsProject = identityPublishNeedsProject || !!includeProject;
    if (identityPublishScheduled) return;
    identityPublishScheduled = true;
    requestAnimationFrame(function() {
      var forceNow = identityPublishForce;
      var needsProjectNow = identityPublishNeedsProject;
      identityPublishForce = false;
      identityPublishNeedsProject = false;
      publishActivityIdentity(forceNow, needsProjectNow);
    });
  }

  function setupActivityIdentityBridge() {
    registerIdentityPublisher(function(force) {
      publishActivityIdentity(force, false);
    });
  }

  function headerParts() {
    var header = document.querySelector('[class^="header_"]:has([class*="titleGroup"])');
    if (!header) return null;
    var titleGroup = header.querySelector('[class*="titleGroup"]');
    if (!titleGroup) return null;
    var spacer = header.querySelector('[class*="headerSpacer"]');
    return { header: header, titleGroup: titleGroup, spacer: spacer };
  }

  function directHeaderChip(header) {
    if (!header || !header.children) return null;
    for (var i = 0; i < header.children.length; i++) {
      var child = header.children[i];
      if (child && child.classList && child.classList.contains(CHIP_CLASS)) return child;
    }
    return null;
  }

  function sessionHistoryButton(header) {
    if (!header || !header.children) return null;
    for (var i = 0; i < header.children.length; i++) {
      var child = header.children[i];
      if (!child || child.tagName !== 'BUTTON') continue;
      var label = String(child.getAttribute('aria-label') || '').toLowerCase();
      var title = String(child.getAttribute('title') || '').toLowerCase();
      if (label === 'session history' || title === 'session history') return child;
    }
    return null;
  }

  function ensureHeaderChip() {
    var parts = headerParts();
    if (!parts) return null;
    var header = parts.header;
    header.setAttribute('data-incipit-edit-header', '1');
    var chip = directHeaderChip(header);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = CHIP_CLASS;
      chip.setAttribute('aria-label', t('model_edit_activity'));
      chip.innerHTML =
        '<span data-incipit-tool-added data-edit-added></span>' +
        '<span data-incipit-tool-removed data-edit-removed></span>';
      chip.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (isActivityOpen() && popupAnchor === ev.currentTarget) {
          closeActivityPopup();
        } else {
          openActivityPopup(ev.currentTarget);
        }
      });
    }
    var before = sessionHistoryButton(header);
    if (!before) {
      before = parts.spacer && parts.spacer.parentNode === header
        ? parts.spacer
        : parts.titleGroup.nextSibling;
    }
    if (before && before !== chip && before.parentNode === header) header.insertBefore(chip, before);
    else if (chip.parentNode !== header) header.appendChild(chip);
    renderActivityChip(chip);
    return chip;
  }

  function fmtCount(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(n);
  }

  function fmtFullCount(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    try { return n.toLocaleString(); } catch (_) { return String(n); }
  }

  function totals() {
    return latest && latest.totals ? latest.totals : { added: 0, removed: 0, edits: 0, activeDays: 0 };
  }

  function popupActivityPayload() {
    return globalLatest || null;
  }

  function popupTotals() {
    var payload = popupActivityPayload();
    return payload && payload.totals
      ? payload.totals
      : { added: 0, removed: 0, edits: 0, activeDays: 0, sessions: 0 };
  }

  function renderActivityChip(chip) {
    if (!chip) return;
    var sessionId = currentSessionId();
    chip.hidden = !sessionId && !latest;
    var T = totals();
    var added = '+' + fmtCount(T.added);
    var removed = '\u2212' + fmtCount(T.removed);
    var addEl = chip.querySelector('[data-edit-added]');
    var remEl = chip.querySelector('[data-edit-removed]');
    if (addEl && addEl.textContent !== added) addEl.textContent = added;
    if (remEl && remEl.textContent !== removed) remEl.textContent = removed;
    chip.title = t('model_edits_title', {
      added: fmtFullCount(T.added),
      removed: fmtFullCount(T.removed),
      edits: fmtFullCount(T.edits)
    });
  }

  function activityPayloadSignature(payload) {
    if (!payload || !payload.totals) return '';
    var T = payload.totals;
    var days = Array.isArray(payload.days) ? payload.days : [];
    var daySig = '';
    for (var i = 0; i < days.length; i++) {
      var d = days[i] || {};
      daySig += ';' + (d.day || '') + ',' + (d.added || 0) + ',' + (d.removed || 0) + ',' + (d.edits || 0);
    }
    return [
      payload.scope || '',
      payload.status || '',
      T.added || 0,
      T.removed || 0,
      T.edits || 0,
      T.sessions || 0,
      T.projects || 0,
      T.activeDays || 0,
      days.length,
      daySig
    ].join('|');
  }

  function setPopupActivityPayload(payload) {
    if (!payload) return false;
    if (payload.currentProject || payload.global) {
      projectLatest = payload.currentProject || projectLatest;
      globalLatest = payload.global || globalLatest;
    } else {
      globalLatest = payload;
    }
    var sig = activityPayloadSignature(projectLatest) + '##' + activityPayloadSignature(globalLatest);
    if (sig && sig === popupLatestSig) return false;
    popupLatestSig = sig;
    return true;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function dayKeyFromDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  function parseDayKey(key) {
    var m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function fmtDayTitle(key) {
    var d = parseDayKey(key);
    if (!d || isNaN(d.getTime())) return key || '';
    if (CFG.language === 'zh') {
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function activityDayMap() {
    var map = Object.create(null);
    var payload = popupActivityPayload();
    var days = payload && Array.isArray(payload.days) ? payload.days : [];
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if (!d || !d.day) continue;
      map[d.day] = {
        day: d.day,
        added: Number(d.added) || 0,
        removed: Number(d.removed) || 0,
        edits: Number(d.edits) || 0,
      };
    }
    return map;
  }

  function heatLevel(value, max) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
    return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(value) / Math.sqrt(max) * 4)));
  }

  function buildHeatmap() {
    var map = activityDayMap();
    var today = startOfLocalDay(new Date());
    var start = addDays(today, -today.getDay() - 53 * 7);
    var end = addDays(today, 6 - today.getDay());
    var weeks = [];
    var maxChanged = 0;
    for (var w = 0; w < 54; w++) {
      var week = [];
      for (var dow = 0; dow < 7; dow++) {
        var date = addDays(start, w * 7 + dow);
        var key = dayKeyFromDate(date);
        var item = map[key] || { day: key, added: 0, removed: 0, edits: 0 };
        var changed = item.added + item.removed;
        if (date <= today && changed > maxChanged) maxChanged = changed;
        week.push({ date: date, key: key, item: item, future: date > today || date > end });
      }
      weeks.push(week);
    }
    return { weeks: weeks, maxChanged: maxChanged };
  }

  function cellTip(cell) {
    var item = cell.item || {};
    return t('cell_tip', {
      date: fmtDayTitle(cell.key),
      added: fmtFullCount(item.added),
      removed: fmtFullCount(item.removed),
      edits: fmtFullCount(item.edits)
    });
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderActivityHeatmap() {
    var H = buildHeatmap();
    var split = 27;
    var bands = [H.weeks.slice(0, split), H.weeks.slice(split)];

    function renderBand(weeks) {
      var monthHtml = '';
      var weeksHtml = '';
      for (var w = 0; w < weeks.length; w++) {
        var week = weeks[w];
        var label = '';
        for (var d = 0; d < week.length; d++) {
          if (week[d].date.getDate() === 1) {
            label = MONTHS[week[d].date.getMonth()];
            break;
          }
        }
        if (w === 0 && !label) label = MONTHS[week[0].date.getMonth()];
        monthHtml += '<span>' + label + '</span>';
        weeksHtml += '<div class="cceEditWeek">';
        for (var i = 0; i < week.length; i++) {
          var cell = week[i];
          var changed = cell.item.added + cell.item.removed;
          var level = cell.future ? 0 : heatLevel(changed, H.maxChanged);
          var tip = cell.future ? '' : cellTip(cell);
          weeksHtml +=
            '<span class="cceEditCell' + (cell.future ? ' cceEditCellFuture' : '') + '"' +
            ' data-level="' + level + '"' +
            ' data-date="' + cell.key + '"' +
            ' data-tip="' + escapeAttr(tip) + '"' +
            ' aria-label="' + escapeAttr(tip) + '"></span>';
        }
        weeksHtml += '</div>';
      }

      return (
        '<div class="cceEditBand" style="--cce-edit-weeks:' + weeks.length + '">' +
          '<div class="cceEditMonths">' + monthHtml + '</div>' +
          '<div class="cceEditHeatmapBody">' +
            '<div class="cceEditWeekdays" aria-hidden="true">' +
              '<span></span><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span>' +
            '</div>' +
            '<div class="cceEditWeeks">' + weeksHtml + '</div>' +
          '</div>' +
        '</div>'
      );
    }

    return (
      '<div class="cceEditHeatmap">' +
        renderBand(bands[0]) +
        renderBand(bands[1]) +
      '</div>'
    );
  }

  function renderActivityPopup() {
    if (!popupEl) return;
    var G = popupTotals();
    var P = projectLatest && projectLatest.totals
      ? projectLatest.totals
      : { added: 0, removed: 0, edits: 0, activeDays: 0, sessions: 0 };
    var hasEdits = (G.edits || 0) > 0;
    var hasGlobal = !!globalLatest;
    var indexing = globalLatest && globalLatest.status === 'indexing';
    var projectName = projectLatest && projectLatest.projectName
      ? projectLatest.projectName
      : t('current_project');
    var facts = hasGlobal
      ? '<span>' + escapeAttr(t('global_tool_edits', { n: fmtFullCount(G.edits) })) + '</span>' +
        '<span>' + escapeAttr(t('conversations', { n: fmtFullCount(G.sessions || 0) })) + '</span>' +
        '<span>' + escapeAttr(t('recorded_projects', { n: fmtFullCount(G.projects || 0) })) + '</span>' +
        '<span>' + escapeAttr(t('active_days', { n: fmtFullCount(G.activeDays) })) + '</span>'
      : '<span>' + escapeAttr(t('loading_index')) + '</span>';
    popupEl.innerHTML =
      '<div class="cceEditShell">' +
        '<div class="cceEditProjectSummary">' +
          '<div class="cceEditProjectLabel">' + escapeAttr(t('current_project')) + '</div>' +
          '<div class="cceEditProjectName" title="' + escapeAttr(projectName) + '">' + escapeAttr(projectName) + '</div>' +
          '<div class="cceEditTotal">' +
            '<span data-incipit-tool-added>+' + fmtFullCount(P.added) + '</span>' +
            '<span data-incipit-tool-removed>\u2212' + fmtFullCount(P.removed) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="cceEditRule"></div>' +
        '<div class="cceEditHead">' +
          '<div class="cceEditTitleBlock">' +
            '<div class="cceEditKicker">' + escapeAttr(t('all_conversations_kicker')) + '</div>' +
            '<div class="cceEditScope">' + escapeAttr(t('across_recorded_projects')) + '</div>' +
          '</div>' +
          (indexing ? '<div class="cceEditStatus">' + escapeAttr(t('indexing')) + '</div>' : '') +
        '</div>' +
        '<div class="cceEditFacts">' +
          facts +
        '</div>' +
        renderActivityHeatmap() +
        '<div class="cceEditLegend">' +
          '<span>' + escapeAttr(hasEdits ? t('less') : t('no_model_edits')) + '</span>' +
          '<span class="cceEditLegendCells" aria-hidden="true">' +
            '<i data-level="0"></i><i data-level="1"></i><i data-level="2"></i><i data-level="3"></i><i data-level="4"></i>' +
          '</span>' +
          '<span>' + escapeAttr(t('more')) + '</span>' +
        '</div>' +
      '</div>' +
      '';
  }

  function buildActivityPopup() {
    var el = document.createElement('div');
    el.className = POPUP_CLASS;
    el.setAttribute('role', 'dialog');
    el.addEventListener('click', function(ev) { ev.stopPropagation(); });
    el.addEventListener('pointermove', handleActivityPointerMove);
    el.addEventListener('pointerleave', hideActivityTooltip);
    return el;
  }

  function ensureActivityTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'cceEditTooltip';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function handleActivityPointerMove(ev) {
    var cell = ev.target && ev.target.closest ? ev.target.closest('.cceEditCell') : null;
    if (!cell || !popupEl || !popupEl.contains(cell)) {
      hideActivityTooltip();
      return;
    }
    var tip = cell.getAttribute('data-tip') || '';
    if (!tip) {
      hideActivityTooltip();
      return;
    }
    var tt = ensureActivityTooltip();
    if (tt.textContent !== tip) tt.textContent = tip;
    tt.setAttribute('data-active', '1');
    var margin = 8;
    var x = ev.clientX + 12;
    var y = ev.clientY - 30;
    var w = tt.offsetWidth || 160;
    var h = tt.offsetHeight || 24;
    if (x + w > window.innerWidth - margin) x = window.innerWidth - margin - w;
    if (y + h > window.innerHeight - margin) y = window.innerHeight - margin - h;
    if (x < margin) x = margin;
    if (y < margin) y = margin;
    tt.style.left = Math.round(x) + 'px';
    tt.style.top = Math.round(y) + 'px';
  }

  function hideActivityTooltip() {
    if (tooltipEl) tooltipEl.removeAttribute('data-active');
  }

  function positionActivityPopup() {
    if (!popupEl || !popupAnchor) return;
    var r = popupAnchor.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 8;
    var safeWidth = Math.min(420, Math.max(320, vw - margin * 2));
    popupEl.style.width = safeWidth + 'px';
    popupEl.style.maxWidth = safeWidth + 'px';
    var w = popupEl.offsetWidth;
    var h = popupEl.offsetHeight;
    var left = Math.round(r.left);
    if (left + w > vw - margin) left = vw - margin - w;
    if (left < margin) left = margin;
    var top = Math.round(r.bottom + 8);
    if (top + h > vh - margin) top = Math.round(r.top - h - 8);
    if (top < margin) top = margin;
    popupEl.style.left = left + 'px';
    popupEl.style.top = top + 'px';
  }

  function openActivityPopup(anchor) {
    popupAnchor = anchor;
    if (!popupEl) {
      popupEl = buildActivityPopup();
      document.body.appendChild(popupEl);
    }
    popupEl.classList.add('cceEditOpen');
    anchor.classList.add('cceEditChipActive');
    renderActivityPopup();
    positionActivityPopup();
    scheduleActivityIdentityPublish(true, true);
  }

  function closeActivityPopup() {
    if (!popupEl) return;
    popupEl.classList.remove('cceEditOpen');
    if (popupAnchor) popupAnchor.classList.remove('cceEditChipActive');
    popupAnchor = null;
    hideActivityTooltip();
  }

  function isActivityOpen() {
    return !!(popupEl && popupEl.classList.contains('cceEditOpen'));
  }

  window.addEventListener('message', function(ev) {
    var d = ev && ev.data;
    if (!d || d.__incipitEditActivity !== true || !d.payload) return;
    var current = currentSessionId();
    if (current && d.payload.sessionId && d.payload.sessionId !== current) return;
    var popupChanged = false;
    var hadProjectBefore = !!projectLatest;
    if (d.payload.projectOnly) {
      if (d.payload.project) popupChanged = setPopupActivityPayload(d.payload.project);
    } else {
      latest = d.payload.conversation || d.payload;
      if (d.payload.project) popupChanged = setPopupActivityPayload(d.payload.project);
    }
    var chip = ensureHeaderChip();
    renderActivityChip(chip);
    if (isActivityOpen() && popupChanged) {
      renderActivityPopup();
      if (!hadProjectBefore) positionActivityPopup();
    }
  });

  document.addEventListener('click', function(ev) {
    if (!isActivityOpen()) return;
    var t = ev.target;
    if (popupEl && popupEl.contains(t)) return;
    if (popupAnchor && popupAnchor.contains(t)) return;
    closeActivityPopup();
  }, true);
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && isActivityOpen()) closeActivityPopup();
  }, true);
  // Same coalescing rationale as the cache popup above.
  var activityRepositionScheduled = false;
  function scheduleActivityReposition() {
    if (!isActivityOpen()) return;
    if (activityRepositionScheduled) return;
    activityRepositionScheduled = true;
    requestAnimationFrame(function() {
      activityRepositionScheduled = false;
      if (isActivityOpen()) positionActivityPopup();
    });
  }
  window.addEventListener('resize', scheduleActivityReposition, { passive: true });
  window.addEventListener('scroll', scheduleActivityReposition, { capture: true, passive: true });

  var ensureScheduled = false;
  function scheduleEnsureHeaderChip() {
    if (ensureScheduled) return;
    ensureScheduled = true;
    requestAnimationFrame(function() {
      ensureScheduled = false;
      ensureHeaderChip();
    });
  }

  function mutationTouchesHeader(m) {
    if (mutationInsideFocusedEditor(m)) return false;
    for (var i = 0; i < m.addedNodes.length; i++) {
      var n = m.addedNodes[i];
      if (!n || n.nodeType !== 1) continue;
      if (nodeInsideFocusedEditor(n) || nodeInsideMessagesContainer(n)) continue;
      var cls = classText(n);
      if (n.tagName === 'BUTTON') {
        var label = String(n.getAttribute('aria-label') || '').toLowerCase();
        var title = String(n.getAttribute('title') || '').toLowerCase();
        if (label === 'session history' || title === 'session history') return true;
      }
      if (cls.indexOf('header_') !== -1 || cls.indexOf('titleGroup') !== -1) return true;
      if (n.querySelector && n.querySelector('[class^="header_"], [class*="titleGroup"], button[aria-label="Session history"], button[title="Session history"]')) return true;
    }
    return false;
  }

  var mo = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutationTouchesHeader(mutations[i])) { scheduleEnsureHeaderChip(); return; }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  ensureHeaderChip();
  setupActivityIdentityBridge();
}


// ============================================================
// Notes (snippets) + reject reminder bubble.
// ============================================================
// A sticky-note icon mounts just LEFT of the cache badge in the footer host.
// Left-click opens a panel of user snippets (Project / Global tabs); clicking
// a snippet inserts its text into the composer WITHOUT sending and closes the
// panel. The same icon grows a reminder bubble after a change-review reject,
// offering a plain-fact English prompt that also inserts (not sends).
//
// Insertion calls the host composer's OWN `setInputText` imperative method,
// reached via a one-shot React-fiber lookup from the contenteditable. The
// composer is controlled (the visible mentionMirror renders from React state),
// so the only reliable insert is the host's setter that updates DOM + state
// together. We do NOT write the contenteditable ourselves or observe it (memo
// 2026-04-15 / 2026-06-06), and we do NOT use execCommand (it collapses newlines
// and never syncs state in this plaintext-only editor). Storage (load/save) still
// round-trips to host-badge; only insertion is local. See insertText() for why.
function setupNotes() {
  var NOTE_BTN_CLASS = 'cceNoteBtn';
  var CACHE_BADGE_CLASS = 'cceBadge'; // sibling we anchor immediately to the right of
  // Document-with-text-lines glyph: a "notes" metaphor distinct from the cache
  // badge's borderless descending bars.
  var NOTE_ICON_SVG = '<svg class="cceNoteIcon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3.3" y="2.8" width="13.4" height="14.4" rx="2.2"/>' +
    '<line x1="6.4" y1="7" x2="13.6" y2="7"/>' +
    '<line x1="6.4" y1="10" x2="13.6" y2="10"/>' +
    '<line x1="6.4" y1="13" x2="11" y2="13"/>' +
    '</svg>';

  var panelEl = null;
  var panelAnchor = null;
  var activeScope = 'global';                 // 'global' | 'project'
  var notesByScope = { global: [], project: [] };
  var notesLoaded = { global: false, project: false };
  var editingId = null;                       // note id, '__new__', or null
  var notesSeq = 0;
  var loadPending = {};
  var savePending = {};

  function notesApi() {
    try {
      if (typeof globalThis.__incipitGetVsCodeApi === 'function') return globalThis.__incipitGetVsCodeApi();
      if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
    } catch (_) {}
    return null;
  }

  function currentCwd() {
    return currentSessionCwd();
  }

  function nextRequestId() { return 'note-' + (++notesSeq).toString(36); }

  function postNotesRequest(type, payload, pendingMap, cb, timeoutMs) {
    var api = notesApi();
    if (!api || typeof api.postMessage !== 'function') { if (cb) cb(null); return; }
    var requestId = nextRequestId();
    if (pendingMap && cb) {
      pendingMap[requestId] = cb;
      setTimeout(function () {
        if (!pendingMap[requestId]) return;
        delete pendingMap[requestId];
        cb(null);
      }, timeoutMs || 6000);
    }
    var msg = { __incipit: true, type: type, requestId: requestId };
    for (var k in payload) { if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k]; }
    try { api.postMessage(msg); }
    catch (_) { if (pendingMap && pendingMap[requestId]) { delete pendingMap[requestId]; if (cb) cb(null); } }
    return requestId;
  }

  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || d.__incipit !== true) return;
    if (d.type === 'notes_load_response') {
      var cbL = loadPending[d.requestId];
      if (!cbL) return;
      delete loadPending[d.requestId];
      cbL(d.payload || null);
    } else if (d.type === 'notes_save_response') {
      var cbS = savePending[d.requestId];
      if (!cbS) return;
      delete savePending[d.requestId];
      cbS(d.payload || null);
    }
  });

  function loadNotes(scope, cb) {
    postNotesRequest('notes_load_request',
      { scope: scope, cwd: scope === 'project' ? currentCwd() : null },
      loadPending,
      function (payload) {
        if (payload && payload.ok && Array.isArray(payload.notes)) {
          notesByScope[scope] = payload.notes;
          notesLoaded[scope] = true;
        }
        if (cb) cb();
      });
  }

  function saveNotes(scope, cb) {
    postNotesRequest('notes_save_request',
      { scope: scope, cwd: scope === 'project' ? currentCwd() : null, notes: notesByScope[scope] },
      savePending,
      function (payload) {
        if (payload && payload.ok && Array.isArray(payload.notes)) notesByScope[scope] = payload.notes;
        if (cb) cb();
      });
  }

  // Locate the official composer contenteditable (host-owned text layer). We
  // only LOCATE it to reach its React owner — we never style or observe it.
  function findComposerInput() {
    var nodes = document.querySelectorAll('[class*="messageInput"][contenteditable]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el && el.isConnected && el.closest('[class*="messageInputContainer"]')) return el;
    }
    return null;
  }

  // Reach the host composer's OWN `setInputText` imperative method by walking the
  // React fiber up from the contenteditable to the composer component's ref.
  //
  // Why this and not a DOM write or execCommand:
  // The composer is a CONTROLLED component. What the user sees is the
  // `mentionMirror` layer, rendered purely from the composer's React state; the
  // contenteditable text itself is just the caret surface. So the only thing that
  // matters for alignment is that the React state equals the editor text.
  // `setInputText` is the host's own primitive that sets BOTH in one shot
  // (`el.textContent = q` AND the state setter) — it's what the host uses for
  // initialPrompt / prompt suggestions, and it handles multi-line cleanly
  // (plaintext-only preserves "\n"). We can't call the state setter ourselves
  // (it's a closure), so we borrow the host's method.
  // execCommand('insertText') is NOT viable here: in this plaintext-only editor
  // it collapses newlines and, crucially, does not sync the React state — the
  // host itself only uses it for single-line @mentions and then re-reads
  // textContent after 100ms to resync state. Multi-line snippets through it
  // misrender (verified 2026-06-13: jumbled via @mention, trailing empty blocks
  // via bare execCommand). This is a single click-triggered call into the host's
  // own setter — not an input observer, not state tracking, not a DOM write that
  // bypasses the model (memo 2026-04-15 / 2026-06-06 forbid those, not this).
  function hostComposerSetText(input, text) {
    try {
      var key = null, keys = Object.keys(input);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 ||
            keys[i].indexOf('__reactInternalInstance$') === 0) { key = keys[i]; break; }
      }
      if (!key) return false;
      var fiber = input[key], hops = 0;
      while (fiber && hops++ < 40) {
        var ref = fiber.ref;
        if (ref && typeof ref === 'object' && ref.current &&
            typeof ref.current.setInputText === 'function') {
          ref.current.setInputText(text);
          if (typeof ref.current.focus === 'function') ref.current.focus();
          return true;
        }
        fiber = fiber.return;
      }
    } catch (_) {}
    return false;
  }

  // The ONE insertion point. setInputText REPLACES the editor text, so to preserve
  // anything already typed we pass existing + new (reading textContent is a read,
  // not a write). Snippets/reminders are plain prose, never @references.
  function insertText(text) {
    var clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!clean.trim()) return;
    var input = findComposerInput();
    if (!input) return;
    var existing = (input.textContent || '').replace(/\s+$/, '');
    var combined = existing ? existing + '\n' + clean : clean;
    if (hostComposerSetText(input, combined)) return;
    // Graceful degradation if the host ref/method can't be reached (host shape
    // changed): native edit through the input pipeline. Single-line is fine;
    // multi-line may misrender until the next host update — surfaced loudly so a
    // drift is noticed rather than silently garbling.
    input.focus();
    try {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !input.contains(sel.anchorNode)) {
        var range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      }
    } catch (_) {}
    try { document.execCommand('insertText', false, clean); } catch (_) {}
  }

  // ---- icon mount (rides the identity heartbeat; no new body observer) ----
  function ensureNoteIcon() {
    var hosts = document.querySelectorAll(SEL.inputFooterHost);
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      if (!host) continue;
      var btn = host.querySelector(':scope > .' + NOTE_BTN_CLASS);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = NOTE_BTN_CLASS;
        btn.setAttribute('aria-label', t('notes'));
        btn.title = t('notes');
        btn.innerHTML = NOTE_ICON_SVG;
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var anchor = ev.currentTarget;
          if (isPanelOpen() && panelAnchor === anchor) closePanel();
          else openPanel(anchor);
        });
        host.insertBefore(btn, host.firstChild);
      }
      // Self-heal order: keep the note icon immediately LEFT of the cache badge
      // no matter which mounted first (both insert at firstChild on their own
      // cadence, so a fixed insert order would race).
      var badge = host.querySelector(':scope > .' + CACHE_BADGE_CLASS);
      if (badge && btn.nextElementSibling !== badge) host.insertBefore(btn, badge);
    }
  }

  // ---- panel ----
  function isPanelOpen() { return !!(panelEl && panelEl.classList.contains('cceNotesOpen')); }

  function buildPanel() {
    var el = document.createElement('div');
    el.setAttribute('data-incipit-notes-panel', '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('notes'));
    el.addEventListener('click', function (ev) { ev.stopPropagation(); });
    bindPanelDelegation(el);
    return el;
  }

  // Delegate every panel interaction to the stable panel element (memo
  // 2026-06-13: per-row handlers die on the mousedown->mouseup rebuild and the
  // click never fires). The list rebuilds on every action; the panel never does.
  function bindPanelDelegation(el) {
    el.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var tab = t.closest('[data-incipit-notes-tab]');
      if (tab && el.contains(tab)) {
        var scope = tab.getAttribute('data-incipit-notes-tab');
        if (scope && scope !== activeScope) {
          activeScope = scope;
          editingId = null;
          if (!notesLoaded[scope]) loadNotes(scope, renderPanel);
          else renderPanel();
        }
        return;
      }
      if (t.closest('[data-incipit-notes-add]')) {
        editingId = '__new__';
        renderPanel();
        focusEditor();
        return;
      }
      var editBtn = t.closest('[data-incipit-notes-edit]');
      if (editBtn) {
        var rowE = editBtn.closest('[data-incipit-notes-row]');
        editingId = rowE ? rowE.getAttribute('data-note-id') : null;
        renderPanel();
        focusEditor();
        return;
      }
      var delBtn = t.closest('[data-incipit-notes-delete]');
      if (delBtn) {
        var rowD = delBtn.closest('[data-incipit-notes-row]');
        var idD = rowD ? rowD.getAttribute('data-note-id') : null;
        if (idD) {
          notesByScope[activeScope] = (notesByScope[activeScope] || []).filter(function (n) { return n && n.id !== idD; });
          saveNotes(activeScope);
          renderPanel();
        }
        return;
      }
      if (t.closest('[data-incipit-notes-editor-cancel]')) {
        editingId = null;
        renderPanel();
        return;
      }
      if (t.closest('[data-incipit-notes-editor-save]')) {
        commitEditor();
        return;
      }
      // Inserting a snippet: the main row button. Insert text, close panel.
      var insertBtn = t.closest('[data-incipit-notes-insert]');
      if (insertBtn) {
        var rowI = insertBtn.closest('[data-incipit-notes-row]');
        var idI = rowI ? rowI.getAttribute('data-note-id') : null;
        var note = (notesByScope[activeScope] || []).find(function (n) { return n && n.id === idI; });
        if (note) { insertText(note.text); closePanel(); }
      }
    });
  }

  function focusEditor() {
    if (!panelEl) return;
    var ta = panelEl.querySelector('[data-incipit-notes-textarea]');
    if (ta) { try { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (_) {} }
  }

  function commitEditor() {
    if (!panelEl) return;
    var ta = panelEl.querySelector('[data-incipit-notes-textarea]');
    var text = ta ? String(ta.value || '') : '';
    if (!text.trim()) { editingId = null; renderPanel(); return; }
    var list = notesByScope[activeScope] || (notesByScope[activeScope] = []);
    if (editingId === '__new__') {
      list.unshift({ id: 'note-' + Date.now().toString(36) + '-' + (notesSeq++).toString(36), text: text, createdAt: Date.now() });
    } else {
      var hit = list.find(function (n) { return n && n.id === editingId; });
      if (hit) hit.text = text;
    }
    editingId = null;
    saveNotes(activeScope);
    renderPanel();
  }

  function notePreview(text) {
    var oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > 140 ? oneLine.slice(0, 139) + '…' : oneLine;
  }

  function renderPanel() {
    if (!panelEl) return;
    panelEl.textContent = '';

    var tabs = document.createElement('div');
    tabs.setAttribute('data-incipit-notes-tabs', '');
    [['project', t('notes_tab_project')], ['global', t('notes_tab_global')]].forEach(function (pair) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('data-incipit-notes-tab', pair[0]);
      if (activeScope === pair[0]) tab.setAttribute('data-active', '1');
      tab.textContent = pair[1];
      tabs.appendChild(tab);
    });
    panelEl.appendChild(tabs);

    var body = document.createElement('div');
    body.setAttribute('data-incipit-notes-list', '');

    if (editingId !== null) {
      body.appendChild(buildEditor());
    } else {
      var notes = notesByScope[activeScope] || [];
      if (!notes.length) {
        var empty = document.createElement('div');
        empty.setAttribute('data-incipit-notes-empty', '');
        empty.textContent = activeScope === 'project'
          ? (currentCwd() ? t('no_project_notes') : t('open_workspace_for_notes'))
          : t('no_notes');
        body.appendChild(empty);
      } else {
        notes.forEach(function (note) {
          if (!note || !note.id) return;
          body.appendChild(buildNoteRow(note));
        });
      }
    }
    panelEl.appendChild(body);

    if (editingId === null) {
      var footer = document.createElement('div');
      footer.setAttribute('data-incipit-notes-footer', '');
      var add = document.createElement('button');
      add.type = 'button';
      add.setAttribute('data-incipit-notes-add', '');
      add.textContent = t('new_note');
      footer.appendChild(add);
      panelEl.appendChild(footer);
    }
  }

  function buildNoteRow(note) {
    var row = document.createElement('div');
    row.setAttribute('data-incipit-notes-row', '');
    row.setAttribute('data-note-id', note.id);

    var insert = document.createElement('button');
    insert.type = 'button';
    insert.setAttribute('data-incipit-notes-insert', '');
    insert.title = t('insert_into_composer');
    insert.textContent = notePreview(note.text);
    row.appendChild(insert);

    var edit = document.createElement('button');
    edit.type = 'button';
    edit.setAttribute('data-incipit-notes-edit', '');
    edit.setAttribute('aria-label', t('edit_note'));
    edit.title = t('edit');
    edit.textContent = '✎';
    row.appendChild(edit);

    var del = document.createElement('button');
    del.type = 'button';
    del.setAttribute('data-incipit-notes-delete', '');
    del.setAttribute('aria-label', t('delete_note'));
    del.title = t('delete');
    del.textContent = '×';
    row.appendChild(del);

    return row;
  }

  function buildEditor() {
    var wrap = document.createElement('div');
    wrap.setAttribute('data-incipit-notes-editor', '');

    var ta = document.createElement('textarea');
    ta.setAttribute('data-incipit-notes-textarea', '');
    ta.rows = 5;
    ta.spellcheck = false;
    ta.placeholder = t('note_placeholder');
    if (editingId !== '__new__') {
      var hit = (notesByScope[activeScope] || []).find(function (n) { return n && n.id === editingId; });
      ta.value = hit ? hit.text : '';
    }
    // Ctrl/Cmd+Enter saves; plain Enter keeps making newlines (notes are
    // multi-line). Never re-render while typing — protects IME composition
    // and the textarea node itself (memo 2026-04-15 / 2026-06-13).
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        commitEditor();
      }
    });
    wrap.appendChild(ta);

    var actions = document.createElement('div');
    actions.setAttribute('data-incipit-notes-editor-actions', '');
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.setAttribute('data-incipit-notes-editor-cancel', '');
    cancel.textContent = t('cancel');
    var save = document.createElement('button');
    save.type = 'button';
    save.setAttribute('data-incipit-notes-editor-save', '');
    save.textContent = t('save');
    actions.appendChild(cancel);
    actions.appendChild(save);
    wrap.appendChild(actions);

    return wrap;
  }

  function positionPanel() {
    if (!panelEl || !panelAnchor) return;
    var r = panelAnchor.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 8;
    var safeWidth = Math.min(340, Math.max(220, vw - margin * 2));
    panelEl.style.width = safeWidth + 'px';
    panelEl.style.maxWidth = safeWidth + 'px';
    var w = panelEl.offsetWidth;
    var h = panelEl.offsetHeight;
    var left = Math.round(r.left);
    if (left + w > vw - margin) left = vw - margin - w;
    if (left < margin) left = margin;
    var bottom = Math.round(vh - r.top + 6);
    var maxBottom = Math.max(margin, vh - h - margin);
    if (bottom > maxBottom) bottom = maxBottom;
    if (bottom < margin) bottom = margin;
    panelEl.style.left = left + 'px';
    panelEl.style.bottom = bottom + 'px';
  }

  function openPanel(anchor) {
    panelAnchor = anchor;
    editingId = null;
    if (!panelEl) {
      panelEl = buildPanel();
      document.body.appendChild(panelEl);
    }
    // Project scope needs a workspace; if none, start on global so the panel
    // is never empty-by-default.
    if (activeScope === 'project' && !currentCwd()) activeScope = 'global';
    panelEl.classList.add('cceNotesOpen');
    anchor.classList.add('cceNoteBtnActive');
    if (!notesLoaded[activeScope]) loadNotes(activeScope, function () { renderPanel(); positionPanel(); });
    renderPanel();
    positionPanel();
  }

  function closePanel() {
    if (!panelEl) return;
    panelEl.classList.remove('cceNotesOpen');
    if (panelAnchor) panelAnchor.classList.remove('cceNoteBtnActive');
    panelAnchor = null;
    editingId = null;
  }

  document.addEventListener('click', function (ev) {
    if (!isPanelOpen()) return;
    var t = ev.target;
    if (panelEl && panelEl.contains(t)) return;
    if (panelAnchor && panelAnchor.contains(t)) return;
    closePanel();
  }, true);
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (isBubbleOpen()) { hideBubble(); return; }
    if (isPanelOpen()) closePanel();
  }, true);

  var panelRepositionScheduled = false;
  function schedulePanelReposition() {
    if (!isPanelOpen() && !isBubbleOpen()) return;
    if (panelRepositionScheduled) return;
    panelRepositionScheduled = true;
    requestAnimationFrame(function () {
      panelRepositionScheduled = false;
      if (isPanelOpen()) positionPanel();
      if (isBubbleOpen()) positionBubble();
    });
  }
  window.addEventListener('scroll', schedulePanelReposition, true);
  window.addEventListener('resize', schedulePanelReposition, true);

  // ---- reject reminder bubble ----
  var bubbleEl = null;
  var bubbleAnchor = null;
  var rejectedFiles = [];           // accumulated within the open window
  var bubbleDismissTimer = 0;
  var BUBBLE_AUTO_DISMISS_MS = 14000;

  function isBubbleOpen() { return !!(bubbleEl && bubbleEl.classList.contains('cceNoteBubbleOpen')); }

  function firstNoteIcon() { return document.querySelector('.' + NOTE_BTN_CLASS); }

  // Plain factual reminder — the user explicitly chose "just state what was
  // rejected", no prescription, no negotiation. Inserted (not sent) so the user
  // can append before sending. One line per file, described by editing tool:
  //   Write `a.ts` — newly created; now deleted.
  //   Edit `b.ts` — +12/−3 lines; restored to its previous contents.
  // Deliberately NO edit line ranges: after a revert the model sees the restored
  // old file, so new-version line numbers point at lines that no longer exist
  // and only confuse it (user decision 2026-06-13). Created files report deletion
  // (their line counts are moot once gone); existing files report the +N/−M they
  // had and that the file is back to its previous contents.
  function rejectReminderLine(f) {
    var label = (f.tool ? f.tool + ' ' : '') + '`' + f.path + '`';
    if (f.isCreated) return label + t('file_created_deleted');
    var stats = f.hasLineStats
      ? t('file_line_stats', { added: f.added || 0, removed: f.removed || 0 })
      : '';
    return label + t('file_restored', { stats: stats });
  }

  function buildRejectReminder(files) {
    var list = files.slice(0, 12);
    if (!list.length) return '';
    var lines = list.map(rejectReminderLine);
    var intro = list.length === 1
      ? t('reject_intro_one')
      : t('reject_intro_many');
    return intro + '\n' + lines.join('\n');
  }

  function addRejectedFiles(files) {
    if (!Array.isArray(files)) return;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || typeof f.path !== 'string' || !f.path) continue;
      var entry = {
        path: f.path,
        tool: typeof f.tool === 'string' ? f.tool : '',
        isCreated: f.isCreated === true,
        added: typeof f.added === 'number' ? f.added : 0,
        removed: typeof f.removed === 'number' ? f.removed : 0,
        hasLineStats: f.hasLineStats === true,
      };
      var found = -1;
      for (var j = 0; j < rejectedFiles.length; j++) {
        if (rejectedFiles[j].path === entry.path) { found = j; break; }
      }
      // dedup by path: same file rejected again replaces the prior entry
      // (last tool/line stats win), keeping original order.
      if (found === -1) rejectedFiles.push(entry);
      else rejectedFiles[found] = entry;
    }
  }

  function buildBubble() {
    var el = document.createElement('div');
    el.setAttribute('data-incipit-notes-bubble', '');
    el.setAttribute('role', 'status');
    el.addEventListener('click', function (ev) { ev.stopPropagation(); });

    var text = document.createElement('div');
    text.setAttribute('data-incipit-notes-bubble-text', '');
    el.appendChild(text);

    var actions = document.createElement('div');
    actions.setAttribute('data-incipit-notes-bubble-actions', '');
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.setAttribute('data-incipit-notes-bubble-dismiss', '');
    dismiss.textContent = t('dismiss');
    dismiss.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); hideBubble(); });
    var insert = document.createElement('button');
    insert.type = 'button';
    insert.setAttribute('data-incipit-notes-bubble-insert', '');
    insert.textContent = t('insert');
    insert.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      insertText(buildRejectReminder(rejectedFiles));
      hideBubble();
    });
    actions.appendChild(dismiss);
    actions.appendChild(insert);
    el.appendChild(actions);
    return el;
  }

  function positionBubble() {
    if (!bubbleEl || !bubbleAnchor) return;
    var r = bubbleAnchor.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 8;
    var w = bubbleEl.offsetWidth;
    var h = bubbleEl.offsetHeight;
    var left = Math.round(r.left);
    if (left + w > vw - margin) left = vw - margin - w;
    if (left < margin) left = margin;
    var bottom = Math.round(vh - r.top + 8);
    var maxBottom = Math.max(margin, vh - h - margin);
    if (bottom > maxBottom) bottom = maxBottom;
    if (bottom < margin) bottom = margin;
    bubbleEl.style.left = left + 'px';
    bubbleEl.style.bottom = bottom + 'px';
  }

  function showRejectBubble() {
    var anchor = firstNoteIcon();
    if (!anchor) return;
    if (!rejectedFiles.length) return;
    bubbleAnchor = anchor;
    if (!bubbleEl) {
      bubbleEl = buildBubble();
      document.body.appendChild(bubbleEl);
    }
    var textEl = bubbleEl.querySelector('[data-incipit-notes-bubble-text]');
    if (textEl) textEl.textContent = buildRejectReminder(rejectedFiles);
    bubbleEl.classList.add('cceNoteBubbleOpen');
    anchor.classList.add('cceNoteBtnNudge');
    positionBubble();
    if (bubbleDismissTimer) clearTimeout(bubbleDismissTimer);
    bubbleDismissTimer = setTimeout(hideBubble, BUBBLE_AUTO_DISMISS_MS);
  }

  function hideBubble() {
    if (bubbleDismissTimer) { clearTimeout(bubbleDismissTimer); bubbleDismissTimer = 0; }
    rejectedFiles = [];
    if (!bubbleEl) return;
    bubbleEl.classList.remove('cceNoteBubbleOpen');
    if (bubbleAnchor) bubbleAnchor.classList.remove('cceNoteBtnNudge');
    bubbleAnchor = null;
  }

  // enhance_legacy dispatches this after a SUCCESSFUL change-review reject, with
  // the per-file details (path, tool, isCreated, added, removed, hasLineStats)
  // captured before the host removed them. Cross-file via a window CustomEvent so
  // the two modules stay decoupled.
  window.addEventListener('incipit:change-review-rejected', function (ev) {
    var detail = ev && ev.detail;
    var files = detail && Array.isArray(detail.files) ? detail.files : null;
    if (!files || !files.length) return;
    ensureNoteIcon();
    addRejectedFiles(files);
    showRejectBubble();
  });
  document.addEventListener('click', function (ev) {
    if (!isBubbleOpen()) return;
    var t = ev.target;
    if (bubbleEl && bubbleEl.contains(t)) return;
    hideBubble();
  }, true);

  registerIdentityPublisher(function () { ensureNoteIcon(); });
  ensureNoteIcon();
}

export function initFooterBadge() {
  setupEditActivityHeader();
  setupCacheBadge();
  setupFooterAbbreviation();
  setupKbdSymbols();
  setupNotes();
}
