import { ATTR, SEL } from '../host_probe.js';
import { CFG, warn } from '../enhance_shared.js';
import { reportCapability, subscribe } from '../runtime_kernel.js';
import { runLegacyInit } from './registry.js';
import {
  buildOutlineEntries,
  createOutlineJumpController,
  resolveActiveOutlineKey,
  resolveNearestMarkerKey,
  resolveOwningUserRowKey,
  sampleOutlineEntries,
} from './conversation_outline_model.js';
import { createOutlineBookmarkStore } from './conversation_outline_store.js';

const COLLAPSE_DELAY_MS = 180;
const TOUCH_FADE_DELAY_MS = 1400;
const JUMP_FRAME_LIMIT = 6;
const HOST_FOLLOW_DISTANCE_PX = 50;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const USER_ROW_SELECTOR = [
  SEL.userMessageContainer,
  '[class*="userMessageContainer"]',
].join(', ');
const MESSAGE_ROW_SELECTOR = [
  USER_ROW_SELECTOR,
  SEL.message,
  '[class*="timelineMessage"]',
].join(', ');

const COPY = Object.freeze({
  en: Object.freeze({
    nav: 'User prompt navigation',
    pinned: 'Pinned',
    all: 'All prompts',
    pin: 'Pin prompt',
    unpin: 'Unpin prompt',
  }),
  zh: Object.freeze({
    nav: '\u7528\u6237\u6307\u4ee4\u5bfc\u822a',
    pinned: '\u5df2\u6536\u85cf',
    all: '\u5168\u90e8\u6307\u4ee4',
    pin: '\u6536\u85cf\u8fd9\u6761\u6307\u4ee4',
    unpin: '\u53d6\u6d88\u6536\u85cf',
  }),
});

function signalValue(signal) {
  try { return signal && typeof signal === 'object' && 'value' in signal ? signal.value : signal; }
  catch (_) { return null; }
}

function elementMatchesOrContains(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  try {
    return !!((node.matches && node.matches(selector)) || (node.querySelector && node.querySelector(selector)));
  } catch (_) {
    return false;
  }
}

function makePinIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 17v5', 'M5 17h14', 'M6 3h12l-1 7 3 2v2H4v-2l3-2-1-7Z']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function createOutlineController(ctx) {
  const strings = COPY[CFG.language] || COPY.en;
  let storage = null;
  try { storage = window.localStorage; } catch (_) {}
  const bookmarkStore = createOutlineBookmarkStore({ storage });

  let destroyed = false;
  let viewport = null;
  let chatContainer = null;
  let inputContainer = null;
  let root = null;
  let rail = null;
  let markerList = null;
  let panel = null;
  let entries = [];
  let sampledEntries = [];
  let currentRecords = [];
  let currentConversationId = null;
  let activeRowKey = null;
  let expanded = false;
  let coarsePointer = false;
  let touchVisible = true;
  let markerCapacity = 12;
  let mountedByRowKey = new Map();
  let anchorElements = [];
  let measuredAnchors = [];
  let userRows = [];

  let containerObserver = null;
  let previewObserver = null;
  let layoutObserver = null;
  let anchorResizeObserver = null;
  let collapseTimer = 0;
  let touchFadeTimer = 0;
  let reconcileTimer = 0;
  let refreshTimer = 0;
  let measureFrame = 0;
  let activeFrame = 0;
  let mediaQuery = null;
  let observedInputContainer = null;
  const unsubscribers = [];

  function report(status, detail = null) {
    try { reportCapability('conversationOutline', status, detail); } catch (_) {}
  }

  function currentBookmarks() {
    return currentConversationId ? bookmarkStore.get(currentConversationId) : new Set();
  }

  function pinnedRowKeys() {
    const pinnedIds = currentBookmarks();
    return new Set(entries.filter(entry => pinnedIds.has(entry.messageId)).map(entry => entry.rowKey));
  }

  function updateTouchVisibility() {
    if (!root) return;
    root.setAttribute('data-incipit-outline-touch', coarsePointer ? '1' : '0');
    root.setAttribute('data-incipit-outline-touch-visible', touchVisible || expanded ? '1' : '0');
  }

  function showTouchTemporarily() {
    if (!coarsePointer) return;
    touchVisible = true;
    updateTouchVisibility();
    if (touchFadeTimer) clearTimeout(touchFadeTimer);
    touchFadeTimer = setTimeout(() => {
      touchFadeTimer = 0;
      touchVisible = false;
      updateTouchVisibility();
    }, TOUCH_FADE_DELAY_MS);
  }

  function updatePointerModeFromEvent(event) {
    let next = null;
    if (event && typeof event.pointerType === 'string' && event.pointerType) {
      next = event.pointerType === 'touch' || event.pointerType === 'pen';
    } else if (event && /^touch/.test(event.type || '')) {
      next = true;
    } else if (event && event.type === 'wheel') {
      next = false;
    }
    if (next === null) return;
    if (next === coarsePointer) {
      if (next) showTouchTemporarily();
      return;
    }
    coarsePointer = next;
    if (coarsePointer) showTouchTemporarily();
    else {
      touchVisible = true;
      updateTouchVisibility();
    }
    calculateMarkerCapacity();
  }

  function capturePanelFocus() {
    const focused = document.activeElement;
    if (!focused || !root || !root.contains(focused)) return null;
    const item = focused.closest && focused.closest('[data-incipit-outline-item]');
    if (!item) return null;
    return {
      rowKey: item.getAttribute('data-row-key') || '',
      action: focused.hasAttribute('data-incipit-outline-pin') ? 'pin' : 'jump',
      copy: item.getAttribute('data-incipit-outline-item') || 'main',
    };
  }

  function restorePanelFocus(snapshot) {
    if (!snapshot || !root) return;
    const candidates = root.querySelectorAll('[data-incipit-outline-item]');
    let matchedItem = null;
    let fallbackItem = null;
    for (const item of candidates) {
      if (item.getAttribute('data-row-key') !== snapshot.rowKey) continue;
      if (!fallbackItem) fallbackItem = item;
      if (item.getAttribute('data-incipit-outline-item') === snapshot.copy) {
        matchedItem = item;
        break;
      }
    }
    const item = matchedItem || fallbackItem;
    if (!item) return;
    const selector = snapshot.action === 'pin'
      ? '[data-incipit-outline-pin]'
      : '[data-incipit-outline-jump]';
    const target = item.querySelector(selector);
    if (target) {
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    }
  }

  function applyActiveState() {
    if (!root) return;
    const activeMarkerKey = resolveNearestMarkerKey(entries, sampledEntries, activeRowKey);
    root.querySelectorAll('[data-row-key]').forEach(node => {
      const rowKey = node.getAttribute('data-row-key');
      const marker = node.hasAttribute('data-incipit-outline-marker');
      const active = marker ? rowKey === activeMarkerKey : rowKey === activeRowKey;
      node.setAttribute('data-active', active ? '1' : '0');
      if (marker || node.hasAttribute('data-incipit-outline-jump')) {
        const item = marker ? null : node.closest('[data-incipit-outline-item]');
        const exposesCurrent = marker || (item && item.getAttribute('data-incipit-outline-item') === 'main');
        if (active && exposesCurrent) node.setAttribute('aria-current', 'location');
        else node.removeAttribute('aria-current');
      }
    });
  }

  function scrollActivePanelIntoView() {
    if (!expanded || !panel || !activeRowKey) return;
    const buttons = panel.querySelectorAll('[data-incipit-outline-jump]');
    for (const button of buttons) {
      if (button.getAttribute('data-row-key') !== activeRowKey) continue;
      try { button.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      catch (_) { button.scrollIntoView({ block: 'center' }); }
      break;
    }
  }

  function setExpanded(next) {
    const value = !!next;
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = 0;
    }
    if (expanded === value) return;
    expanded = value;
    if (root) root.setAttribute('data-incipit-outline-expanded', expanded ? '1' : '0');
    updateTouchVisibility();
    if (expanded) requestAnimationFrame(scrollActivePanelIntoView);
  }

  function scheduleCollapse() {
    if (coarsePointer || collapseTimer) return;
    collapseTimer = setTimeout(() => {
      collapseTimer = 0;
      setExpanded(false);
    }, COLLAPSE_DELAY_MS);
  }

  function makeOutlineItem(entry, pinnedCopy) {
    const bookmarks = currentBookmarks();
    const pinned = bookmarks.has(entry.messageId);
    const item = document.createElement('div');
    item.setAttribute('data-incipit-outline-item', pinnedCopy ? 'pinned' : 'main');
    item.setAttribute('data-row-key', entry.rowKey);
    item.setAttribute('data-pinned', pinned ? '1' : '0');

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.setAttribute('data-incipit-outline-jump', '');
    jump.setAttribute('data-row-key', entry.rowKey);
    jump.textContent = entry.preview;
    jump.title = entry.preview;
    jump.addEventListener('click', event => {
      event.preventDefault();
      requestJump(entry.rowKey);
      if (coarsePointer && event.detail !== 0) setExpanded(false);
    });
    item.appendChild(jump);

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.setAttribute('data-incipit-outline-pin', '');
    pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pin.setAttribute('aria-label', pinned ? strings.unpin : strings.pin);
    pin.title = pinned ? strings.unpin : strings.pin;
    pin.appendChild(makePinIcon());
    pin.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (currentConversationId) bookmarkStore.toggle(currentConversationId, entry.messageId);
    });
    item.appendChild(pin);
    return item;
  }

  function appendSectionLabel(text) {
    const label = document.createElement('div');
    label.setAttribute('data-incipit-outline-section-label', '');
    label.textContent = text;
    panel.appendChild(label);
  }

  function renderMarkers() {
    if (!markerList) return;
    const focused = document.activeElement;
    const focusedRowKey = focused && focused.hasAttribute && focused.hasAttribute('data-incipit-outline-marker')
      ? focused.getAttribute('data-row-key')
      : null;
    markerList.replaceChildren();
    const bookmarks = currentBookmarks();
    sampledEntries = sampleOutlineEntries(entries, markerCapacity, pinnedRowKeys());
    for (const entry of sampledEntries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-incipit-outline-marker', '');
      button.setAttribute('data-row-key', entry.rowKey);
      button.setAttribute('data-pinned', bookmarks.has(entry.messageId) ? '1' : '0');
      button.setAttribute('aria-label', entry.preview);
      button.title = entry.preview;
      const bar = document.createElement('span');
      bar.setAttribute('aria-hidden', 'true');
      button.appendChild(bar);
      button.addEventListener('pointerenter', event => {
        updatePointerModeFromEvent(event);
        if (!coarsePointer) setExpanded(true);
      });
      button.addEventListener('click', event => {
        event.preventDefault();
        if (coarsePointer && event.detail !== 0 && !expanded) {
          setExpanded(true);
          return;
        }
        requestJump(entry.rowKey);
      });
      markerList.appendChild(button);
    }
    applyActiveState();
    if (focusedRowKey) {
      const fallbackRowKey = resolveNearestMarkerKey(entries, sampledEntries, focusedRowKey);
      const markers = markerList.querySelectorAll('[data-incipit-outline-marker]');
      for (const marker of markers) {
        const rowKey = marker.getAttribute('data-row-key');
        if (rowKey !== focusedRowKey && rowKey !== fallbackRowKey) continue;
        try { marker.focus({ preventScroll: true }); } catch (_) { marker.focus(); }
        break;
      }
    }
  }

  function renderPanel() {
    if (!panel) return;
    const focusSnapshot = capturePanelFocus();
    panel.replaceChildren();
    const bookmarks = currentBookmarks();
    const pinnedEntries = entries.filter(entry => bookmarks.has(entry.messageId));

    if (pinnedEntries.length) {
      appendSectionLabel(strings.pinned);
      for (const entry of pinnedEntries) panel.appendChild(makeOutlineItem(entry, true));
      const divider = document.createElement('div');
      divider.setAttribute('data-incipit-outline-divider', '');
      panel.appendChild(divider);
    }
    appendSectionLabel(strings.all);
    for (const entry of entries) panel.appendChild(makeOutlineItem(entry, false));
    applyActiveState();
    restorePanelFocus(focusSnapshot);
  }

  function renderEntries() {
    renderMarkers();
    renderPanel();
    updateVisibility();
  }

  function ensureRoot() {
    if (!chatContainer) return null;
    if (!root) {
      root = document.createElement('nav');
      root.setAttribute('data-incipit-conversation-outline', '');
      root.setAttribute('data-incipit-outline-expanded', '0');
      root.setAttribute('aria-label', strings.nav);

      rail = document.createElement('div');
      rail.setAttribute('data-incipit-outline-rail', '');
      markerList = document.createElement('div');
      markerList.setAttribute('data-incipit-outline-markers', '');
      rail.appendChild(markerList);
      root.appendChild(rail);

      panel = document.createElement('div');
      panel.setAttribute('data-incipit-outline-panel', '');
      root.appendChild(panel);

      root.addEventListener('pointerenter', updatePointerModeFromEvent);
      root.addEventListener('pointerleave', scheduleCollapse);
      root.addEventListener('focusin', () => setExpanded(true));
      root.addEventListener('focusout', event => {
        if (!root.contains(event.relatedTarget)) scheduleCollapse();
      });
      rail.addEventListener('click', event => {
        if (coarsePointer && !expanded && !(event.target.closest && event.target.closest('button'))) {
          setExpanded(true);
        }
      });
    }
    if (root.parentElement !== chatContainer) chatContainer.appendChild(root);
    updateTouchVisibility();
    renderEntries();
    updateLayout();
    return root;
  }

  function calculateMarkerCapacity() {
    if (!root) return;
    const available = Math.max(0, root.clientHeight - 24);
    const raw = Math.max(2, Math.floor(available / 9));
    const next = coarsePointer ? Math.min(12, raw) : Math.min(40, raw);
    if (next === markerCapacity) return;
    markerCapacity = next;
    renderMarkers();
  }

  function findInputContainer() {
    if (!chatContainer) return null;
    const footer = document.querySelector(SEL.inputFooter);
    return (footer && footer.closest('[class*="inputContainer_"]')) ||
      chatContainer.querySelector('[class*="inputContainer_"]');
  }

  function updateLayout() {
    if (!root || !chatContainer) return;
    inputContainer = findInputContainer();
    if (layoutObserver && inputContainer !== observedInputContainer) {
      if (observedInputContainer) {
        try { layoutObserver.unobserve(observedInputContainer); } catch (_) {}
      }
      if (inputContainer) layoutObserver.observe(inputContainer);
      observedInputContainer = inputContainer;
    }
    let bottom = 12;
    if (inputContainer) {
      const chatRect = chatContainer.getBoundingClientRect();
      const inputRect = inputContainer.getBoundingClientRect();
      bottom = Math.max(12, Math.ceil(chatRect.bottom - inputRect.top + 8));
    }
    root.style.setProperty('--incipit-outline-bottom', `${bottom}px`);
    calculateMarkerCapacity();
  }

  function updateVisibility() {
    if (!root) return;
    const session = ctx.locateActiveSessionState();
    const loading = !!signalValue(session && session.isLoading);
    const visible = !!(
      currentConversationId &&
      entries.length >= 2 &&
      viewport &&
      anchorElements.length &&
      !loading
    );
    root.hidden = !visible;
    if (visible) requestAnimationFrame(calculateMarkerCapacity);
  }

  function recordId(record, index) {
    const uuid = ctx.recordUuid(record);
    if (uuid) return uuid;
    const beta = ctx.recordBetaMessageId(record);
    return beta || `user-row-${index}`;
  }

  function refreshEntriesNow() {
    refreshTimer = 0;
    if (destroyed) return;
    reconcileContainer();
    const session = ctx.locateActiveSessionState();
    const messages = signalValue(session && session.messages);
    currentRecords = Array.isArray(messages) ? messages : [];
    const nextConversationId = ctx.getActiveSessionId() || signalValue(session && session.sessionId) || null;
    if (nextConversationId !== currentConversationId) {
      currentConversationId = nextConversationId;
      activeRowKey = null;
      jumpController.cancel();
    }

    const sourceIndexByRowKey = new Map();
    entries = buildOutlineEntries(currentRecords, {
      isUser: ctx.isOutlineUserRecord,
      getText: ctx.outlineTextForRecord,
      getRowKey(record, index) {
        const key = recordId(record, index);
        sourceIndexByRowKey.set(key, index);
        return key;
      },
      getMessageId(record, index, rowKey) {
        return ctx.recordUuid(record) || ctx.recordBetaMessageId(record) || rowKey;
      },
    });
    userRows = entries.map(entry => ({
      rowKey: entry.rowKey,
      sourceIndex: sourceIndexByRowKey.get(entry.rowKey),
    }));
    renderEntries();
    indexMountedRows();
    report(entries.length >= 2 ? 'ok' : 'pending', { entries: entries.length });
  }

  function scheduleEntryRefresh(delay = 0) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshEntriesNow, Math.max(0, delay));
  }

  function contentTop(element) {
    if (!element || !viewport) return 0;
    let top = 0;
    let node = element;
    let guard = 0;
    while (node && node !== viewport && guard++ < 40) {
      top += Number(node.offsetTop) || 0;
      node = node.offsetParent;
    }
    if (node === viewport) return top;
    const viewRect = viewport.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return viewport.scrollTop + rect.top - viewRect.top;
  }

  function measureAnchors() {
    measureFrame = 0;
    if (!viewport) return;
    measuredAnchors = anchorElements
      .filter(item => item.element && item.element.isConnected)
      .map(item => ({ rowKey: item.rowKey, top: contentTop(item.element) }))
      .sort((a, b) => a.top - b.top);
    updateActiveFromScroll();
  }

  function scheduleMeasure() {
    if (measureFrame || destroyed) return;
    measureFrame = requestAnimationFrame(measureAnchors);
  }

  function bindPreviewObserver() {
    if (previewObserver) previewObserver.disconnect();
    if (typeof MutationObserver !== 'function' || !viewport) return;
    previewObserver = new MutationObserver(() => scheduleEntryRefresh(0));
    viewport.querySelectorAll(SEL.userContent).forEach(content => {
      previewObserver.observe(content, { childList: true, subtree: true, characterData: true });
    });
  }

  function bindAnchorResizeObserver() {
    if (anchorResizeObserver) anchorResizeObserver.disconnect();
    anchorResizeObserver = null;
    if (typeof ResizeObserver !== 'function') return;
    anchorResizeObserver = new ResizeObserver(scheduleMeasure);
    const observed = new Set();
    for (const item of anchorElements) {
      if (!item.element || observed.has(item.element)) continue;
      observed.add(item.element);
      anchorResizeObserver.observe(item.element);
    }
  }

  function indexMountedRows() {
    if (!viewport || !entries.length) {
      mountedByRowKey = new Map();
      anchorElements = [];
      measuredAnchors = [];
      bindAnchorResizeObserver();
      updateVisibility();
      return;
    }

    const nextMounted = new Map();
    const nextAnchors = [];
    const seenUserKeys = new Set();
    const entryKeys = new Set(entries.map(entry => entry.rowKey));
    let rows = [];
    try { rows = Array.from(viewport.querySelectorAll(MESSAGE_ROW_SELECTOR)); } catch (_) {}
    for (const element of rows) {
      const record = ctx.transcriptRecordForElement(element);
      if (!record) continue;
      const sourceIndex = ctx.transcriptRecordIndex(currentRecords, record);
      if (sourceIndex < 0) continue;
      const owningRowKey = resolveOwningUserRowKey(userRows, sourceIndex);
      if (!owningRowKey) continue;

      if (ctx.isOutlineUserRecord(record)) {
        const ownKey = recordId(record, sourceIndex);
        if (!entryKeys.has(ownKey) || seenUserKeys.has(ownKey)) continue;
        seenUserKeys.add(ownKey);
        nextMounted.set(ownKey, element);
        nextAnchors.push({ rowKey: ownKey, element });
      } else {
        nextAnchors.push({ rowKey: owningRowKey, element });
      }
    }
    mountedByRowKey = nextMounted;
    anchorElements = nextAnchors;
    bindPreviewObserver();
    bindAnchorResizeObserver();
    scheduleMeasure();
    updateVisibility();
  }

  function updateActiveFromScroll() {
    activeFrame = 0;
    if (!viewport || !entries.length) return;
    const next = resolveActiveOutlineKey(measuredAnchors, {
      scrollTop: viewport.scrollTop,
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      anchorOffset: 8,
      bottomThreshold: 28,
    }, entries[entries.length - 1].rowKey);
    if (next === activeRowKey) return;
    activeRowKey = next;
    applyActiveState();
  }

  function scheduleActiveUpdate() {
    if (activeFrame || destroyed) return;
    activeFrame = requestAnimationFrame(updateActiveFromScroll);
  }

  function onViewportScroll() {
    scheduleActiveUpdate();
    showTouchTemporarily();
  }

  function cancelJumpForUserInput(event) {
    updatePointerModeFromEvent(event);
    jumpController.cancel();
  }

  function onKeyDown(event) {
    if (!SCROLL_KEYS.has(event.key)) return;
    const target = event.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    cancelJumpForUserInput();
  }

  function breakAutoFollow() {
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    // Claude Code derives its follow-bottom flag from a strict < 50px check
    // during render. Moving just beyond it is the host's current break-follow
    // contract; there is no exposed imperative handle in 2.1.232.
    const breakDistance = HOST_FOLLOW_DISTANCE_PX + 2;
    if (distance < breakDistance) {
      viewport.scrollTop = Math.max(0, viewport.scrollTop - (breakDistance - distance));
    }
  }

  function mountedRow(rowKey) {
    let target = mountedByRowKey.get(rowKey);
    if (!target || !target.isConnected) {
      indexMountedRows();
      target = mountedByRowKey.get(rowKey);
    }
    return target && target.isConnected ? target : null;
  }

  function alignRow(rowKey) {
    if (!viewport) return false;
    const target = mountedRow(rowKey);
    if (!target) {
      report('degraded', { reason: 'target-not-mounted' });
      return false;
    }
    const viewRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const desired = viewport.scrollTop + targetRect.top - viewRect.top - 8;
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = Math.max(0, Math.min(maxScroll, desired));
    return true;
  }

  const jumpController = createOutlineJumpController({
    maxFrames: JUMP_FRAME_LIMIT,
    beforeJump: breakAutoFollow,
    align: alignRow,
  });

  function requestJump(rowKey) {
    if (!entries.some(entry => entry.rowKey === rowKey) || !mountedRow(rowKey)) {
      report('degraded', { reason: 'target-not-mounted' });
      return false;
    }
    return jumpController.jump(rowKey);
  }

  function mutationChangesUserRows(mutation) {
    if (!mutation || mutation.type !== 'childList') return false;
    for (const node of mutation.addedNodes || []) {
      if (elementMatchesOrContains(node, USER_ROW_SELECTOR)) return true;
    }
    for (const node of mutation.removedNodes || []) {
      if (elementMatchesOrContains(node, USER_ROW_SELECTOR)) return true;
    }
    return false;
  }

  function mutationChangesMessageRows(mutation) {
    if (!mutation || mutation.type !== 'childList') return false;
    for (const node of mutation.addedNodes || []) {
      if (elementMatchesOrContains(node, MESSAGE_ROW_SELECTOR)) return true;
    }
    for (const node of mutation.removedNodes || []) {
      if (elementMatchesOrContains(node, MESSAGE_ROW_SELECTOR)) return true;
    }
    return false;
  }

  function detachViewport() {
    if (containerObserver) containerObserver.disconnect();
    if (previewObserver) previewObserver.disconnect();
    if (layoutObserver) layoutObserver.disconnect();
    if (anchorResizeObserver) anchorResizeObserver.disconnect();
    containerObserver = null;
    previewObserver = null;
    layoutObserver = null;
    anchorResizeObserver = null;
    observedInputContainer = null;
    if (viewport) {
      viewport.removeEventListener('scroll', onViewportScroll);
      viewport.removeEventListener('wheel', cancelJumpForUserInput);
      viewport.removeEventListener('touchstart', cancelJumpForUserInput);
      viewport.removeEventListener('touchmove', cancelJumpForUserInput);
      viewport.removeEventListener('pointerdown', cancelJumpForUserInput);
    }
    viewport = null;
    chatContainer = null;
    inputContainer = null;
    mountedByRowKey = new Map();
    anchorElements = [];
    measuredAnchors = [];
  }

  function attachViewport(next) {
    detachViewport();
    viewport = next;
    chatContainer = next && next.parentElement;
    if (!viewport || !chatContainer) return false;
    ensureRoot();
    viewport.addEventListener('scroll', onViewportScroll, { passive: true });
    viewport.addEventListener('wheel', cancelJumpForUserInput, { passive: true });
    viewport.addEventListener('touchstart', cancelJumpForUserInput, { passive: true });
    viewport.addEventListener('touchmove', cancelJumpForUserInput, { passive: true });
    viewport.addEventListener('pointerdown', cancelJumpForUserInput, { passive: true });

    if (typeof MutationObserver === 'function') {
      containerObserver = new MutationObserver(mutations => {
        if (mutations.some(mutationChangesUserRows)) {
          scheduleEntryRefresh(0);
          return;
        }
        if (mutations.some(mutationChangesMessageRows)) indexMountedRows();
      });
      containerObserver.observe(viewport, { childList: true, subtree: true });
    }
    if (typeof ResizeObserver === 'function') {
      layoutObserver = new ResizeObserver(() => {
        updateLayout();
        scheduleMeasure();
      });
      layoutObserver.observe(chatContainer);
      layoutObserver.observe(viewport);
      if (inputContainer) layoutObserver.observe(inputContainer);
      observedInputContainer = inputContainer;
      if (root) layoutObserver.observe(root);
    }
    showTouchTemporarily();
    indexMountedRows();
    return true;
  }

  function findViewport() {
    return document.querySelector(SEL.messagesContainer) ||
      document.querySelector('[class*="messagesContainer_"]');
  }

  function reconcileContainer() {
    if (destroyed) return false;
    const next = findViewport();
    if (next === viewport) return !!viewport;
    if (next) return attachViewport(next);
    detachViewport();
    if (root) root.hidden = true;
    return false;
  }

  function scheduleReconcile(delay = 0) {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = 0;
      if (!reconcileContainer()) return;
      scheduleEntryRefresh(0);
    }, Math.max(0, delay));
  }

  function onDocumentPointerDown(event) {
    const outside = !!(expanded && root && !root.contains(event.target));
    updatePointerModeFromEvent(event);
    if (outside) setExpanded(false);
  }

  function refreshPointerMode() {
    coarsePointer = !!(mediaQuery && mediaQuery.matches);
    if (!coarsePointer) touchVisible = true;
    updateTouchVisibility();
    calculateMarkerCapacity();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    jumpController.destroy();
    detachViewport();
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe(); } catch (_) {}
    }
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (mediaQuery) {
      try { mediaQuery.removeEventListener('change', refreshPointerMode); }
      catch (_) { try { mediaQuery.removeListener(refreshPointerMode); } catch (_) {} }
    }
    if (collapseTimer) clearTimeout(collapseTimer);
    if (touchFadeTimer) clearTimeout(touchFadeTimer);
    if (reconcileTimer) clearTimeout(reconcileTimer);
    if (refreshTimer) clearTimeout(refreshTimer);
    if (measureFrame) cancelAnimationFrame(measureFrame);
    if (activeFrame) cancelAnimationFrame(activeFrame);
    if (root) root.remove();
    root = null;
    report('pending', { reason: 'destroyed' });
  }

  unsubscribers.push(bookmarkStore.subscribe(renderEntries));
  unsubscribers.push(subscribe('sessionChanged', () => {
    activeRowKey = null;
    jumpController.cancel();
    scheduleReconcile(0);
  }));
  unsubscribers.push(subscribe('messagesChanged', () => scheduleEntryRefresh(0)));
  unsubscribers.push(subscribe('assistantTurnFinalized', scheduleMeasure));
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  try {
    mediaQuery = window.matchMedia('(hover: none), (pointer: coarse)');
    coarsePointer = mediaQuery.matches;
    try { mediaQuery.addEventListener('change', refreshPointerMode); }
    catch (_) { mediaQuery.addListener(refreshPointerMode); }
  } catch (_) {}

  scheduleReconcile(0);
  scheduleEntryRefresh(0);
  return Object.freeze({ destroy, refresh: refreshEntriesNow });
}

export function initLegacyConversationOutline(ctx) {
  let controller = null;
  runLegacyInit('conversation_outline', ctx, () => {
    const previous = globalThis.__incipitConversationOutline;
    if (previous && typeof previous.destroy === 'function') previous.destroy();
    controller = createOutlineController(ctx);
    globalThis.__incipitConversationOutline = controller;
  });
  return controller;
}
