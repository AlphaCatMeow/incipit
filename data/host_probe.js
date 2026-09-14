'use strict';
import { observeTranscriptLayout } from './transcript_layout.js';

export const ATTR = Object.freeze({
  attachedFiles: 'data-incipit-attached-files',
  attachedFilesTop: 'data-incipit-attached-files-top',
  commandItem: 'data-incipit-command-item',
  commandItemActive: 'data-incipit-command-item-active',
  commandLabel: 'data-incipit-command-label',
  commandList: 'data-incipit-command-list',
  commandRef: 'data-incipit-command-ref',
  compactMessage: 'data-incipit-compact-message',
  systemMessage: 'data-incipit-system-message',
  composerRoot: 'data-incipit-composer-root',
  composerShell: 'data-incipit-composer-shell',
  composerWrapper: 'data-incipit-composer-wrapper',
  turn: 'data-incipit-turn',
  permissionSurface: 'data-incipit-permission-surface',
  dropdown: 'data-incipit-dropdown',
  effortLabel: 'data-incipit-effort-label',
  effortLevelInline: 'data-incipit-effort-level-inline',
  footerButtonLabel: 'data-incipit-footer-button-label',
  inputFooter: 'data-incipit-input-footer',
  inputFooterHost: 'data-incipit-input-footer-host',
  interruptedMessage: 'data-incipit-interrupted-message',
  markdownRoot: 'data-incipit-markdown-root',
  menuItem: 'data-incipit-menu-item',
  menuItemLabel: 'data-incipit-menu-item-label',
  menuItemDescription: 'data-incipit-menu-item-description',
  menuPopup: 'data-incipit-menu-popup',
  message: 'data-incipit-message',
  messagesContainer: 'data-incipit-messages-container',
  sendButton: 'data-incipit-send-button',
  sendIcon: 'data-incipit-send-icon',
  showMore: 'data-incipit-host-show-more',
  spinnerContainer: 'data-incipit-spinner-container',
  spinnerIcon: 'data-incipit-spinner-icon',
  spinnerRow: 'data-incipit-spinner-row',
  stickyMessage: 'data-incipit-sticky-message',
  thinking: 'data-incipit-thinking',
  thinkingToggle: 'data-incipit-thinking-toggle',
  thinkingContent: 'data-incipit-thinking-content',
  thinkingSummary: 'data-incipit-thinking-summary',
  thinkingStatic: 'data-incipit-thinking-static',
  toolArgs: 'data-incipit-tool-args',
  toolBody: 'data-incipit-tool-body',
  toolCommand: 'data-incipit-tool-command',
  toolName: 'data-incipit-tool-name',
  toolNameSecondary: 'data-incipit-tool-name-secondary',
  toolPath: 'data-incipit-tool-path',
  toolSecondary: 'data-incipit-tool-secondary',
  toolSummary: 'data-incipit-tool-summary',
  toolUse: 'data-incipit-tool-use',
  truncationGradient: 'data-incipit-truncation-gradient',
  usageLabel: 'data-incipit-usage-label',
  userAttachments: 'data-incipit-user-attachments',
  userBubble: 'data-incipit-user-bubble',
  userContent: 'data-incipit-user-content',
  userExpandable: 'data-incipit-user-expandable',
  userLayoutWrapper: 'data-incipit-user-layout-wrapper',
  userMessageContainer: 'data-incipit-user-message-container',
  stopIcon: 'data-incipit-stop-icon',
});

export const SEL = Object.freeze(
  Object.fromEntries(Object.entries(ATTR).map(([key, attr]) => [key, `[${attr}]`])),
);

const STATIC_PROBES = Object.freeze([
  ['[class*="attachedFilesContainerAbove"]', ATTR.attachedFilesTop],
  ['[class*="attachedFilesContainer"]', ATTR.attachedFiles],
  ['[class*="commandItem"]', ATTR.commandItem],
  ['[class*="activeCommandItem"]', ATTR.commandItemActive],
  ['[class*="commandLabel"]', ATTR.commandLabel],
  ['[class*="commandList"]', ATTR.commandList],
  ['[class*="commandRef"]', ATTR.commandRef],
  ['details[class*="compact_"]', ATTR.compactMessage],
  ['[class*="messagesContainer_"] [class*="metaMessage_"]', ATTR.systemMessage],
  ['[class*="messagesContainer_"] [class*="divider_"]:has(> [class*="wave_"])', ATTR.systemMessage],
  ['[class*="messagesContainer_"] > [class*="turn_"]', ATTR.turn],
  ['[class*="chatContainer_"] > [class*="inputContainer_"]', ATTR.composerShell],
  ['[class*="inputWrapper_"]:has([class*="messageInput_"][contenteditable])', ATTR.composerWrapper],
  ['[class*="chatContainer_"] > [class*="inputContainer_"] > [class*="permissionsContainer_"]', ATTR.permissionSurface],
  ['fieldset[class*="inputContainer_"]', ATTR.composerRoot],
  ['[class*="inputContainer_"]:has(> [class*="inputContainerBackground"])', ATTR.composerRoot],
  ['[class*="dropdown"]', ATTR.dropdown],
  ['[class*="dropdown_"]', ATTR.dropdown],
  ['[class*="filePath"]', ATTR.toolPath],
  ['[class*="footerButton"] span', ATTR.footerButtonLabel],
  ['[class*="inputFooter"]', ATTR.inputFooter],
  ['[class*="menuItem_"]', ATTR.menuItem],
  ['[class*="menuItemLabel"]', ATTR.menuItemLabel],
  ['[class*="menuItemDescription"]', ATTR.menuItemDescription],
  ['[class*="menuPopup"]', ATTR.menuPopup],
  ['[class*="messagesContainer_"]', ATTR.messagesContainer],
  ['[class*="root_"]', ATTR.markdownRoot],
  ['[class*="spinnerRow"]', ATTR.spinnerRow],
  ['[class*="stickyHeader"]', ATTR.stickyMessage],
  ['[class*="thinkingContent"]', ATTR.thinkingContent],
  ['[class*="timelineMessage"]', ATTR.message],
  ['[class*="toolArgs"]', ATTR.toolArgs],
  ['[class*="toolBody_"]', ATTR.toolBody],
  ['[class*="toolCommand"]', ATTR.toolCommand],
  ['[class*="toolName"]', ATTR.toolName],
  ['[class*="toolNameTextSecondary"]', ATTR.toolNameSecondary],
  ['[class*="toolPath"]', ATTR.toolPath],
  ['[class*="secondaryLine_"]', ATTR.toolSecondary],
  ['[class*="toolSummary"]', ATTR.toolSummary],
  ['[class*="toolUse_"]', ATTR.toolUse],
  ['[class*="truncationGradient"]', ATTR.truncationGradient],
  ['[class*="usageLabel"]', ATTR.usageLabel],
  ['[class*="userMessageContainer"]', ATTR.userMessageContainer],
  ['[class*="Attachments"]', ATTR.userAttachments],
  ['details[class*="thinking"]', ATTR.thinking],
  ['summary[class*="thinkingSummary"]', ATTR.thinkingSummary],
  // Empty or redacted thinking renders as a static div with the same summary
  // class and no disclosure; it joins the activity rail but never toggles.
  ['div[class*="thinking_"]', ATTR.thinkingStatic],
  ['div[class*="thinkingSummary"]', ATTR.thinkingSummary],
]);

const CSS_ALWAYS_WARMUP_MS = 5000;

const CSS_CAPABILITIES = Object.freeze([
  { attr: ATTR.markdownRoot, name: 'runtime.cssClass.markdownRoot', presence: 'always', selectors: ['[class*="root_"]'], featureOwner: 'markdown' },
  { attr: ATTR.messagesContainer, name: 'runtime.cssClass.messagesContainer', presence: 'always', selectors: ['[class*="messagesContainer_"]'], featureOwner: 'messages' },
  { attr: ATTR.inputFooter, name: 'runtime.cssClass.inputFooter', presence: 'always', selectors: ['[class*="inputFooter"]'], featureOwner: 'composer' },
  { attr: ATTR.composerRoot, name: 'runtime.cssClass.composerRoot', presence: 'always', selectors: ['fieldset[class*="inputContainer_"]', '[class*="inputContainer_"]:has(> [class*="inputContainerBackground"])'], featureOwner: 'composer' },
  { attr: ATTR.composerShell, name: 'runtime.cssClass.composerShell', presence: 'always', selectors: ['[class*="chatContainer_"] > [class*="inputContainer_"]'], featureOwner: 'composer' },
  { attr: ATTR.composerWrapper, name: 'runtime.cssClass.composerWrapper', presence: 'afterSeen', selectors: ['[class*="inputWrapper_"]:has([class*="messageInput_"][contenteditable])'], featureOwner: 'composer' },
  { attr: ATTR.permissionSurface, name: 'runtime.cssClass.permissionSurface', presence: 'afterSeen', selectors: ['[class*="permissionsContainer_"]'], featureOwner: 'composer' },
  { attr: ATTR.turn, name: 'runtime.cssClass.turn', presence: 'afterSeen', selectors: ['[class*="messagesContainer_"] > [class*="turn_"]'], featureOwner: 'messages' },
  { attr: ATTR.compactMessage, name: 'runtime.cssClass.compactMessage', presence: 'afterSeen', selectors: ['details[class*="compact_"]'], featureOwner: 'messages' },
  { attr: ATTR.systemMessage, name: 'runtime.cssClass.systemMessage', presence: 'afterSeen', selectors: ['[class*="metaMessage_"]', '[class*="divider_"]:has(> [class*="wave_"])'], featureOwner: 'messages' },
  { attr: ATTR.sendButton, name: 'runtime.cssClass.sendButton', presence: 'always', selectors: ['[class*="sendButton"]'], featureOwner: 'composer' },

  { attr: ATTR.message, name: 'runtime.cssClass.message', presence: 'afterSeen', selectors: ['[class*="timelineMessage"]'], featureOwner: 'messages' },
  { attr: ATTR.userMessageContainer, name: 'runtime.cssClass.userMessageContainer', presence: 'afterSeen', selectors: ['[class*="userMessageContainer"]'], featureOwner: 'user_bubble' },
  { attr: ATTR.userBubble, name: 'runtime.cssClass.userBubble', presence: 'afterSeen', selectors: ['[class*="userMessage_"]'], featureOwner: 'user_bubble' },
  { attr: ATTR.userContent, name: 'runtime.cssClass.userContent', presence: 'afterSeen', selectors: ['[class*="expandableContainer"] [class*="content_"]'], featureOwner: 'user_bubble' },
  { attr: ATTR.thinking, name: 'runtime.cssClass.thinking', presence: 'afterSeen', selectors: ['details[class*="thinking"]'], featureOwner: 'thinking' },
  { attr: ATTR.thinkingSummary, name: 'runtime.cssClass.thinkingSummary', presence: 'afterSeen', selectors: ['summary[class*="thinkingSummary"]'], featureOwner: 'thinking' },
  { attr: ATTR.thinkingContent, name: 'runtime.cssClass.thinkingContent', presence: 'afterSeen', selectors: ['[class*="thinkingContent"]'], featureOwner: 'thinking' },
  { attr: ATTR.thinkingToggle, name: 'runtime.cssClass.thinkingToggle', presence: 'afterSeen', selectors: ['[class*="thinkingToggle"]'], featureOwner: 'thinking' },
  { attr: ATTR.toolUse, name: 'runtime.cssClass.toolUse', presence: 'afterSeen', selectors: ['[class*="toolUse_"]'], featureOwner: 'tool_use' },
  { attr: ATTR.toolBody, name: 'runtime.cssClass.toolBody', presence: 'afterSeen', selectors: ['[class*="toolBody_"]'], featureOwner: 'tool_use' },
  { attr: ATTR.toolArgs, name: 'runtime.cssClass.toolArgs', presence: 'afterSeen', selectors: ['[class*="toolArgs"]'], featureOwner: 'tool_use' },
  { attr: ATTR.toolCommand, name: 'runtime.cssClass.toolCommand', presence: 'afterSeen', selectors: ['[class*="toolCommand"]'], featureOwner: 'tool_use' },
  { attr: ATTR.toolName, name: 'runtime.cssClass.toolName', presence: 'afterSeen', selectors: ['[class*="toolName"]'], featureOwner: 'tool_use' },
  { attr: ATTR.toolPath, name: 'runtime.cssClass.toolPath', presence: 'afterSeen', selectors: ['[class*="filePath"]', '[class*="toolPath"]'], featureOwner: 'tool_use' },
  { attr: ATTR.toolSecondary, name: 'runtime.cssClass.toolSecondary', presence: 'afterSeen', selectors: ['[class*="secondaryLine_"]'], featureOwner: 'tool_use' },
  { attr: ATTR.toolSummary, name: 'runtime.cssClass.toolSummary', presence: 'afterSeen', selectors: ['[class*="toolSummary"]'], featureOwner: 'tool_use' },
  { attr: ATTR.spinnerRow, name: 'runtime.cssClass.spinnerRow', presence: 'afterSeen', selectors: ['[class*="spinnerRow"]'], featureOwner: 'streaming' },
  { attr: ATTR.spinnerContainer, name: 'runtime.cssClass.spinnerContainer', presence: 'afterSeen', selectors: ['[class*="spinnerRow"] [class*="container_"]'], featureOwner: 'streaming' },
  { attr: ATTR.spinnerIcon, name: 'runtime.cssClass.spinnerIcon', presence: 'afterSeen', selectors: ['[class*="spinnerRow"] [class*="icon_"]'], featureOwner: 'streaming' },
  { attr: ATTR.usageLabel, name: 'runtime.cssClass.usageLabel', presence: 'afterSeen', selectors: ['[class*="usageLabel"]'], featureOwner: 'session_usage' },
  { attr: ATTR.effortLabel, name: 'runtime.cssClass.effortLabel', presence: 'afterSeen', selectors: ['[class*="effortLabel"]'], featureOwner: 'effort' },
  { attr: ATTR.footerButtonLabel, name: 'runtime.cssClass.footerButtonLabel', presence: 'afterSeen', selectors: ['[class*="footerButton"] span'], featureOwner: 'footer' },
  { attr: ATTR.showMore, name: 'runtime.cssClass.showMore', presence: 'afterSeen', selectors: ['[class*="collapseButton"]', '[class*="buttonContainer"]', '[class*="showMore"]'], featureOwner: 'message_controls' },

  { attr: ATTR.dropdown, name: 'runtime.cssClass.dropdown', presence: 'whileVisible', selectors: ['[class*="dropdown"]', '[class*="dropdown_"]'], featureOwner: 'command_menu' },
  { attr: ATTR.commandList, name: 'runtime.cssClass.commandList', presence: 'whileVisible', selectors: ['[class*="commandList"]'], ownerRoot: '[class*="dropdown"], [class*="dropdown_"]', featureOwner: 'command_menu' },
  { attr: ATTR.commandItem, name: 'runtime.cssClass.commandItem', presence: 'whileVisible', selectors: ['[class*="commandItem"]'], ownerRoot: '[class*="commandList"]', featureOwner: 'command_menu' },
  { attr: ATTR.commandLabel, name: 'runtime.cssClass.commandLabel', presence: 'whileVisible', selectors: ['[class*="commandLabel"]'], ownerRoot: '[class*="commandItem"]', featureOwner: 'command_menu' },
  { attr: ATTR.menuPopup, name: 'runtime.cssClass.menuPopup', presence: 'whileVisible', selectors: ['[class*="menuPopup"]'], featureOwner: 'menu' },
  { attr: ATTR.menuItem, name: 'runtime.cssClass.menuItem', presence: 'whileVisible', selectors: ['[class*="menuItem_"]'], ownerRoot: '[class*="menuPopup"]', featureOwner: 'menu' },
  { attr: ATTR.menuItemLabel, name: 'runtime.cssClass.menuItemLabel', presence: 'whileVisible', selectors: ['[class*="menuItemLabel"]'], ownerRoot: '[class*="menuItem_"]', featureOwner: 'menu' },
]);

const CSS_CAPABILITY_BY_ATTR = new Map(CSS_CAPABILITIES.map(def => [def.attr, def]));

let observer = null;
let fullRescanScheduled = false;
let localizedRescanScheduled = false;
let isComposing = false;
let compositionListenersAttached = false;
let cssCapabilityRuntimeStarted = false;
let cssWarmupTimer = 0;
let cssVisibleCheckScheduled = false;
let cssVisibilityListenerAttached = false;
const cssCapabilityStatus = new Map();

const SIBLING_REGION_SELECTOR = [
  '[class*="inputFooter"]',
  '[class*="userMessageContainer"]',
  '[class*="sendButton"]',
  '[class*="effortRow"]',
  '[class*="effortLabel"]',
].join(', ');

const dirtyFooters = new Set();
const dirtyUserContainers = new Set();
const dirtySendButtons = new Set();
const dirtyEffortLabels = new Set();

function clearDirtyRegions() {
  dirtyFooters.clear();
  dirtyUserContainers.clear();
  dirtySendButtons.clear();
  dirtyEffortLabels.clear();
}

function scheduleFullRescan() {
  if (fullRescanScheduled) return;
  fullRescanScheduled = true;
  requestAnimationFrame(() => {
    fullRescanScheduled = false;
    if (document.body) tagHostTree(document.body);
    clearDirtyRegions();
  });
}

function hasDirtyRegions() {
  return !!(
    dirtyFooters.size ||
    dirtyUserContainers.size ||
    dirtySendButtons.size ||
    dirtyEffortLabels.size
  );
}

function markDirtyRegion(node) {
  let el = node;
  if (el && el.nodeType !== 1) el = el.parentElement;
  if (!el || !el.closest) return;
  const region = el.closest(SIBLING_REGION_SELECTOR);
  if (!region) return;
  const classes = typeof region.className === 'string' ? region.className : '';
  if (classes.includes('inputFooter')) dirtyFooters.add(region);
  else if (classes.includes('userMessageContainer')) dirtyUserContainers.add(region);
  else if (classes.includes('sendButton')) dirtySendButtons.add(region);
  else if (classes.includes('effortRow') || classes.includes('effortLabel')) dirtyEffortLabels.add(region);
}

// Sibling-aware rescan: per-mutation `tagHostTree(addedNode)` already covers
// static first-mount tagging. The remaining work is only for regions whose
// meaning depends on siblings or replace-in-place children: footer host
// candidate, user message interruption state, send/stop icon state, and
// effort-label fallback attrs. Keep this localized; a full-body rescan here
// turns streaming text mutations in long conversations into O(N) selector work.
function scheduleSiblingRescan() {
  if (fullRescanScheduled || localizedRescanScheduled || !hasDirtyRegions()) return;
  localizedRescanScheduled = true;
  requestAnimationFrame(() => {
    localizedRescanScheduled = false;
    const footers = Array.from(dirtyFooters);
    const users = Array.from(dirtyUserContainers);
    const sends = Array.from(dirtySendButtons);
    const efforts = Array.from(dirtyEffortLabels);
    clearDirtyRegions();
    for (const el of footers) if (el.isConnected) syncFooterHosts(el);
    for (const el of users) if (el.isConnected) syncUserMessageNodes(el);
    for (const el of sends) if (el.isConnected) syncSendButtons(el);
    for (const el of efforts) if (el.isConnected) syncEffortLabels(el);
    scheduleVisibleCssCapabilityCheck();
  });
}

function attachCompositionListeners() {
  if (compositionListenersAttached) return;
  compositionListenersAttached = true;
  // IME composition mutates the editor subtree in ways that Chromium's text
  // layout cannot tolerate any style invalidation against. Suppress the
  // observer while composing, then run a single catch-up rescan.
  document.addEventListener('compositionstart', () => { isComposing = true; }, true);
  document.addEventListener('compositionend', () => {
    isComposing = false;
    scheduleFullRescan();
  }, true);
}

function reportCssCapability(def, status, reason, detail = null) {
  if (!def || !def.name) return;
  const payload = {
    layer: 'cssClass',
    presence: def.presence,
    reason,
    featureOwner: def.featureOwner || null,
    selectors: def.selectors,
    ownerRoot: def.ownerRoot || null,
    ...(detail && typeof detail === 'object' ? detail : {}),
  };
  const key = `${def.name}:${status}:${JSON.stringify(payload)}`;
  if (cssCapabilityStatus.get(def.name) === key) return;
  cssCapabilityStatus.set(def.name, key);
  try {
    const health = globalThis.__incipitHealth;
    if (health && typeof health.set === 'function') {
      health.set('capability.' + def.name, status, payload);
    }
  } catch (_) {}
}

function noteCssCapability(attr, element = null) {
  const def = CSS_CAPABILITY_BY_ATTR.get(attr);
  if (!def) return;
  reportCssCapability(def, 'ok', 'seen', {
    attr,
    tagName: element && element.tagName ? String(element.tagName).toLowerCase() : null,
  });
}

function selectorExists(selectors) {
  for (const selector of selectors || []) {
    try {
      if (document.querySelector(selector)) return true;
    } catch (_) {}
  }
  return false;
}

function elementHasSelector(owner, selectors) {
  if (!owner) return false;
  for (const selector of selectors || []) {
    try {
      if (owner.matches?.(selector) || owner.querySelector?.(selector)) return true;
    } catch (_) {}
  }
  return false;
}

function isVisibleElement(element) {
  if (!element || element.nodeType !== 1 || element.hidden) return false;
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return !!(
    element.offsetWidth ||
    element.offsetHeight ||
    (element.getClientRects && element.getClientRects().length)
  );
}

function runAlwaysCssCapabilityCheck(reason, degradedOnMiss) {
  for (const def of CSS_CAPABILITIES) {
    if (def.presence !== 'always') continue;
    if (selectorExists(def.selectors)) {
      reportCssCapability(def, 'ok', reason || 'seen');
    } else {
      reportCssCapability(def, degradedOnMiss ? 'degraded' : 'pending', degradedOnMiss ? 'cssMiss' : 'warmup');
    }
  }
}

function runVisibleCssCapabilityCheck() {
  cssVisibleCheckScheduled = false;
  for (const def of CSS_CAPABILITIES) {
    if (def.presence !== 'whileVisible' || !def.ownerRoot) continue;
    let owner = null;
    try { owner = document.querySelector(def.ownerRoot); } catch (_) { owner = null; }
    if (!isVisibleElement(owner)) continue;
    if (elementHasSelector(owner, def.selectors)) {
      reportCssCapability(def, 'ok', 'ownerVisible', { ownerRoot: def.ownerRoot });
    } else {
      reportCssCapability(def, 'degraded', 'cssMiss', { ownerRoot: def.ownerRoot });
    }
  }
}

function scheduleVisibleCssCapabilityCheck() {
  if (cssVisibleCheckScheduled) return;
  cssVisibleCheckScheduled = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(runVisibleCssCapabilityCheck);
  else setTimeout(runVisibleCssCapabilityCheck, 0);
}

function handleCssVisibilityChange() {
  if (document.visibilityState !== 'hidden') {
    runAlwaysCssCapabilityCheck('visible', true);
    scheduleVisibleCssCapabilityCheck();
  }
}

function startCssCapabilityRuntime() {
  if (cssCapabilityRuntimeStarted) return;
  cssCapabilityRuntimeStarted = true;
  runAlwaysCssCapabilityCheck('startup', false);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      runAlwaysCssCapabilityCheck('domContentLoaded', false);
      scheduleVisibleCssCapabilityCheck();
    }, { once: true });
  } else {
    runAlwaysCssCapabilityCheck('domReady', false);
  }
  cssWarmupTimer = setTimeout(() => {
    cssWarmupTimer = 0;
    runAlwaysCssCapabilityCheck('warmup', true);
    scheduleVisibleCssCapabilityCheck();
  }, CSS_ALWAYS_WARMUP_MS);
  if (!cssVisibilityListenerAttached) {
    cssVisibilityListenerAttached = true;
    document.addEventListener('visibilitychange', handleCssVisibilityChange);
  }
}

export function startHostProbe() {
  if (observer) return observer;
  if (!document.body) return null;
  attachCompositionListeners();
  startCssCapabilityRuntime();
  tagHostTree(document.body);
  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-label', 'aria-valuetext', 'title'],
  });
  return observer;
}

export function stopHostProbe() {
  if (observer) { observer.disconnect(); observer = null; }
  if (cssWarmupTimer) { clearTimeout(cssWarmupTimer); cssWarmupTimer = 0; }
  fullRescanScheduled = false;
  localizedRescanScheduled = false;
  cssVisibleCheckScheduled = false;
  cssCapabilityRuntimeStarted = false;
  clearDirtyRegions();
}

export function tagHostTree(root) {
  if (!root) return;
  // Never touch nodes inside a contenteditable editor. The chat input
  // creates `<p>` and `<span>` nodes that can match STATIC_PROBES
  // selectors, and setting data-attributes on them desynchronizes the
  // editor model from the DOM, causing character corruption (e.g. a
  // period typed after CJK text gets stranded in an unselectable region).
  if (root.nodeType === 1 && root.isContentEditable) return;
  if (root.nodeType === 1 && !root.firstElementChild && !looksLikeHostLeaf(root)) return;
  tagStaticSelectors(root);
  syncFooterHosts(root);
  syncUserMessageNodes(root);
  syncSendButtons(root);
  syncEffortLabels(root);
  syncTransientControls(root);
  syncSpinnerNodes(root);
  scheduleVisibleCssCapabilityCheck();
}

export function closestByAttr(node, attr) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return element?.closest?.(`[${attr}]`) || null;
}

// Added subtrees get tagged immediately through `tagHostTree(node)`.
// Sibling-sensitive follow-up work is dirty-region based: a mutation marks
// the nearest footer/user/send/effort ancestor, then the next frame only
// re-syncs those regions. Streaming markdown mutations therefore avoid the old
// full-body sibling scan entirely.
function handleMutations(mutations) {
  const active = document.activeElement;
  const editorFocused = active && active.isContentEditable;

  // Hard stop during IME composition. Any setAttribute against an ancestor
  // of the editor — even an idempotent one — can desynchronize Chromium's
  // text advance cache from the composition buffer, leaving phantom glyphs
  // that cannot be selected or deleted. compositionend schedules a single
  // catch-up rescan, so nothing is lost.
  if (editorFocused && isComposing) return;

  let hasOutsideMutation = false;
  const added = new Set();
  for (const mutation of mutations) {
    const targetInsideEditor = !!(editorFocused && active.contains(mutation.target));
    if (editorFocused && !targetInsideEditor) {
      hasOutsideMutation = true;
    }
    if (mutation.type === 'attributes') {
      if (!targetInsideEditor) markDirtyRegion(mutation.target);
      if (!targetInsideEditor && mutation.attributeName === 'class' && looksLikeHostLeaf(mutation.target)) tagStaticElement(mutation.target);
      continue;
    }
    if (!targetInsideEditor) markDirtyRegion(mutation.target);
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (editorFocused && active.contains(node)) continue;
      added.add(node);
      if (!(editorFocused && active.contains(node))) markDirtyRegion(node);
    }
  }
  for (const node of added) {
    let ancestor = node.parentElement;
    let covered = false;
    while (ancestor && ancestor !== document.body) {
      if (added.has(ancestor)) { covered = true; break; }
      ancestor = ancestor.parentElement;
    }
    if (!covered) tagHostTree(node);
  }
  // Skip the rescan only when ALL mutations are inside the contenteditable
  // editor. But if any mutation landed outside (e.g. send button state
  // change), we must still rescan so attributes like send-state update.
  // We use the sibling-only path here — `tagHostTree(addedNode)` above
  // already handled per-node static tagging, so the only thing left to
  // catch is sibling-aware decisions inside the sync*() functions.
  // `compositionend` still calls `scheduleFullRescan` because it suppresses
  // ALL tagging during composition and needs the catch-up to be exhaustive.
  if (editorFocused && !hasOutsideMutation) return;
  scheduleSiblingRescan();
}

function ensureAttr(el, attr, value = '') {
  if (!el || el.nodeType !== 1) return;
  if (el.getAttribute(attr) === value) {
    noteCssCapability(attr, el);
    return;
  }
  el.setAttribute(attr, value);
  noteCssCapability(attr, el);
}

const STATIC_PROBE_SELECTOR = STATIC_PROBES.map(([selector]) => selector).join(', ');
const STATIC_PROBE_RULES = STATIC_PROBES.map(([selector, attr]) => {
  const subject = selector.split(':has')[0].trim().split(/\s+>\s+|\s+/).pop();
  const match = subject.match(/\[class\*="([^"]+)"\]/);
  return { selector, attr, hint: match ? match[1] : null };
});
const HOST_CLASS_HINTS = [...new Set(STATIC_PROBE_RULES.map(rule => rule.hint).filter(Boolean)),
  'collapseButton', 'buttonContainer', 'showMore', 'sendButton', 'effortLabel', 'spinnerRow'];

function looksLikeHostLeaf(element) {
  const classes = elementClassText(element);
  return HOST_CLASS_HINTS.some(hint => classes.includes(hint)) ||
    (element.tagName === 'SPAN' && element.closest?.('[class*="footerButton"]'));
}

// Probe attributes that mirror *transient host state* rather than structure.
// The host renders the command menu's active row as
// `active ? styles.activeCommandItem : ''` (React), so this class lands on
// and comes off the same long-lived element as the pointer moves. Structural
// probes are add-only on purpose — a row never stops being a row — but a
// state mirror has to come off again, or the background it paints stays
// behind on every row the pointer ever visited and the menu ends up with a
// trail of "highlighted" rows instead of one (2026-09-15).
const TRANSIENT_STATE_ATTRS = new Set([ATTR.commandItemActive]);

function tagStaticElement(element) {
  if (element.isContentEditable) return;
  const classes = elementClassText(element);
  for (const rule of STATIC_PROBE_RULES) {
    if ((!rule.hint || classes.includes(rule.hint)) && element.matches(rule.selector)) {
      ensureAttr(element, rule.attr);
      if (rule.attr === ATTR.messagesContainer) observeTranscriptLayout(element);
    } else if (TRANSIENT_STATE_ATTRS.has(rule.attr) && element.hasAttribute(rule.attr)) {
      element.removeAttribute(rule.attr);
    }
  }
}

function tagStaticSelectors(root) {
  if (root.nodeType !== 1) return;
  // Discover the subtree once; matching each candidate in memory avoids one
  // querySelectorAll traversal per probe while preserving selector semantics.
  const candidates = [];
  if (root.matches?.(STATIC_PROBE_SELECTOR)) candidates.push(root);
  root.querySelectorAll?.(STATIC_PROBE_SELECTOR).forEach(element => candidates.push(element));
  for (const element of candidates) {
    tagStaticElement(element);
  }
}

function elementClassText(node) {
  if (!node || node.nodeType !== 1) return '';
  return typeof node.className === 'string'
    ? node.className
    : String(node.getAttribute?.('class') || '');
}

function syncFooterHosts(root) {
  forEachHost(root, SEL.inputFooter, footer => {
    const currentHost = Array.from(footer.children).findLast(isFooterHostCandidate);
    Array.from(footer.querySelectorAll(`[${ATTR.inputFooterHost}]`)).forEach(node => {
      if (node !== currentHost) node.removeAttribute(ATTR.inputFooterHost);
    });
    if (currentHost) ensureAttr(currentHost, ATTR.inputFooterHost);
  });
}

function syncUserMessageNodes(root) {
  forEachHost(root, SEL.userMessageContainer, container => {
    container.querySelectorAll('[class*="container_v2"]').forEach(node => {
      ensureAttr(node, ATTR.userLayoutWrapper);
    });
    const interrupted = container.querySelector('[class*="interruptedMessage"]');
    if (interrupted) ensureAttr(interrupted, ATTR.interruptedMessage);
    container.querySelectorAll('[class*="userMessage_"]').forEach(node => tagUserBubble(node));
    container.querySelectorAll(`[${ATTR.userContent}]`).forEach(node => {
      if (!isUserTextContentNode(node)) node.removeAttribute(ATTR.userContent);
    });
    container.querySelectorAll('[class*="expandableContainer"] [class*="content_"]').forEach(node => {
      if (isUserTextContentNode(node)) ensureAttr(node, ATTR.userContent);
    });
    container.querySelectorAll('[class*="expandableContainer"]').forEach(node => {
      ensureAttr(node, ATTR.userExpandable);
    });
  });
}

function syncSendButtons(root) {
  forEachHost(root, '[class*="sendButton"]', button => {
    ensureAttr(button, ATTR.sendButton);
    button.querySelectorAll(`[${ATTR.sendIcon}], [${ATTR.stopIcon}]`).forEach(node => {
      const classes = typeof node.className === 'string'
        ? node.className
        : String(node.getAttribute?.('class') || '');
      if (!classes.includes('sendIcon') && node.hasAttribute(ATTR.sendIcon)) {
        node.removeAttribute(ATTR.sendIcon);
      }
      if (!classes.includes('stopIcon') && node.hasAttribute(ATTR.stopIcon)) {
        node.removeAttribute(ATTR.stopIcon);
      }
    });
    button.querySelectorAll('[class*="sendIcon"]').forEach(node => {
      ensureAttr(node, ATTR.sendIcon);
    });
    button.querySelectorAll('[class*="stopIcon"]').forEach(node => {
      ensureAttr(node, ATTR.stopIcon);
    });
    const state = resolveSendState(button);
    if (state) ensureAttr(button, 'data-incipit-send-state', state);
    else if (button.hasAttribute('data-incipit-send-state')) {
      button.removeAttribute('data-incipit-send-state');
    }
  });
}

function syncEffortLabels(root) {
  forEachHost(root, '[class*="effortLabel"]', label => {
    ensureAttr(label, ATTR.effortLabel);
    const inline = label.querySelector('[class*="effortLevelInline"]');
    if (inline) ensureAttr(inline, ATTR.effortLevelInline);
    const level = resolveEffortLevel(inline || label);
    if (level) ensureAttr(label, 'data-incipit-effort-level', level);
    else label.removeAttribute('data-incipit-effort-level');
  });
}

function syncTransientControls(root) {
  const probes = [
    ['[class*="collapseButton"]', ATTR.showMore],
    ['[class*="buttonContainer"]', ATTR.showMore],
    ['[class*="showMore"]', ATTR.showMore],
  ];
  for (const [selector, attr] of probes) {
    forEachHost(root, selector, element => ensureAttr(element, attr));
  }
}

function syncSpinnerNodes(root) {
  forEachHost(root, SEL.spinnerRow, row => {
    row.querySelectorAll('[class*="container_"]').forEach(node => {
      ensureAttr(node, ATTR.spinnerContainer);
    });
    row.querySelectorAll('[class*="icon_"]').forEach(node => {
      ensureAttr(node, ATTR.spinnerIcon);
    });
  });
  forEachHost(root, SEL.thinkingSummary, summary => {
    summary.querySelectorAll('[class*="thinkingToggle"]').forEach(node => {
      ensureAttr(node, ATTR.thinkingToggle);
    });
  });
}

function forEachHost(root, selector, callback) {
  if (root.nodeType !== 1) return;
  if (root.matches?.(selector)) callback(root);
  root.querySelectorAll?.(selector).forEach(callback);
}

function isFooterHostCandidate(node) {
  return node.nodeType === 1 && typeof node.className === 'string' && node.className.includes('container_');
}

function tagUserBubble(node) {
  const classes = typeof node.className === 'string' ? node.className : '';
  if (!classes.includes('userMessage_')) return;
  if (classes.includes('Container') || classes.includes('Attachments')) return;
  ensureAttr(node, ATTR.userBubble);
}

function isUserTextContentNode(node) {
  if (!node || node.nodeType !== 1) return false;
  const classes = typeof node.className === 'string' ? node.className : '';
  if (!classes.includes('content_')) return false;
  if (node.closest(`[${ATTR.userAttachments}], [class*="Attachments"]`)) return false;
  const bubble = node.closest(`[${ATTR.userBubble}], [class*="userMessage_"]`);
  if (!bubble) return false;
  const bubbleClasses = typeof bubble.className === 'string' ? bubble.className : '';
  if (bubbleClasses.includes('Container') || bubbleClasses.includes('Attachments')) return false;
  const expandable = node.closest('[class*="expandableContainer"]');
  if (!expandable || !bubble.contains(expandable)) return false;
  const wrapper = node.closest('[class*="contentWrapper_"]');
  return !!(wrapper && expandable.contains(wrapper));
}

function resolveSendState(button) {
  if (button.querySelector('[class*="stopIcon"]')) return 'stop';
  if (button.querySelector('[class*="sendIcon"]')) return 'send';
  if (button.querySelector(`[${ATTR.stopIcon}]`)) return 'stop';
  if (button.querySelector(`[${ATTR.sendIcon}]`)) return 'send';
  return null;
}

function resolveEffortLevel(node) {
  const text = [
    node?.getAttribute?.('aria-label'),
    node?.getAttribute?.('aria-valuetext'),
    node?.getAttribute?.('title'),
    node?.textContent,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\bextra\s*high\b|\bxhigh\b/.test(text)) return 'xhigh';
  if (/\bmax\b/.test(text)) return 'max';
  if (/\bmedium\b/.test(text)) return 'medium';
  if (/\blow\b/.test(text)) return 'low';
  if (/\bhigh\b/.test(text)) return 'high';
  if (/\bauto\b/.test(text)) return 'auto';
  return '';
}
