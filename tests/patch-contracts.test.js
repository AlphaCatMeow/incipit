'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { __test } = require('../src/install');
const { patchContract: makePatchContract } = require('../src/patch-contract');

const DEFAULT_FEATURES = Object.freeze({
  math: true,
  sessionUsage: true,
  editorSelectionOverlay: false,
});

const DEFAULT_THEME = Object.freeze({
  bodyFontSize: 13,
  palette: 'warm-black',
  bodyBold: false,
  bodyFontFamily: {
    key: 'plex-hei',
    css: "'ReadingHei', 'IBM Plex Serif', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif",
    emphasisCss: "'EmphasisHei', var(--incipit-body-font)",
    paperFace: "'PaperReadingHei'",
  },
  codeFontFamily: {
    key: 'rec-mono',
    css: "'Rec Mono Linear', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', Consolas, Monaco, 'Courier New', monospace",
  },
});

function hasContractFiles(dir) {
  return fs.existsSync(path.join(dir, 'extension.js')) &&
    fs.existsSync(path.join(dir, 'webview', 'index.js'));
}

function collectRootsUnder(start, maxDepth, out = []) {
  if (!start || !fs.existsSync(start) || maxDepth < 0) return out;
  if (hasContractFiles(start)) {
    out.push(start);
    return out;
  }
  let entries;
  try {
    entries = fs.readdirSync(start, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    collectRootsUnder(path.join(start, entry.name), maxDepth - 1, out);
  }
  return out;
}

function collectFixtureRoots() {
  const roots = [];
  const explicit = process.env.INCIPIT_CONTRACT_FIXTURE;
  if (explicit) collectRootsUnder(path.resolve(explicit), 5, roots);

  const restoreRoot = path.join(os.homedir(), '.incipit', 'official-restore-points-v1');
  collectRootsUnder(restoreRoot, 4, roots);

  const seen = new Set();
  return roots.filter(root => {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertNoGracefulDegradation(label, lines) {
  const degraded = lines.filter(line => /降级|degraded/i.test(String(line || '')));
  assert.deepStrictEqual(degraded, [], `${label} degraded:\n${degraded.join('\n')}`);
}

function assertWebviewSemanticShape(root, patched, statusLines) {
  assert(
    statusLines.some(line => /流式代码高亮/.test(line) && /ok/.test(line)),
    `${root}: render-time code highlight contract did not report ok`,
  );
  assert(
    patched.includes('window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__('),
    `${root}: render-time highlighter call missing`,
  );
  assert(
    patched.includes('.indexOf("\\n")!==-1') && patched.includes('className:"hljs"'),
    `${root}: no-language fenced code render path missing`,
  );
  assert(
    statusLines.some(line => /宿主语义桥/.test(line) && /ok/.test(line)),
    `${root}: semantic host-state bridge contract did not report ok`,
  );
  assert(
    patched.includes('globalThis.__incipitPublishHostState=function') &&
      patched.includes('new CustomEvent("incipit:hostState"') &&
      patched.includes('var partialTail=hasPartialTail(messages);') &&
      patched.includes('pendingInput:pendingInput,partialTail:partialTail') &&
      patched.includes('prev.pendingInput!==next.pendingInput||prev.partialTail!==next.partialTail') &&
      patched.includes('__incipitPublishHostState(this,"signal")'),
    `${root}: semantic host-state bridge shape missing`,
  );
  const implicitSelection = __test.assessImplicitSelectionSendContact(patched);
  assert.strictEqual(
    implicitSelection.status,
    'patched',
    `${root}: implicit IDE selection send does not appear disabled`,
  );
  assert(
    /if\(!1&&\([^;{}]*\bthis\.lastSentSelection\b[^;{}]*\bthis\.selection\.value\b[^;{}]*\)[A-Za-z_$][\w$]*=this\.selection\.value,this\.lastSentSelection=[A-Za-z_$][\w$]*;/.test(patched),
    `${root}: implicit IDE selection send patch shape missing`,
  );
  assert(
    statusLines.some(line => /未知流事件保护/.test(line) && /(已写入|已存在|上游已容错)/.test(line)),
    `${root}: unknown stream case safety contract did not report a guarded or upstream-tolerant state`,
  );
}

function versionFromFixtureRoot(root) {
  const parts = String(root || '').split(/[\\/]+/).reverse();
  for (const part of parts) {
    const match = part.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }
  return 'unknown';
}

function parseInstallManifest(root, patched) {
  const match = patched.match(/globalThis\.__incipitInstallManifest = Object\.freeze\((\{[^\n]*\})\);/);
  assert(match, `${root}: install manifest preamble missing`);
  const manifest = JSON.parse(match[1]);
  assert.strictEqual(manifest.schemaVersion, 1, `${root}: install manifest schema version mismatch`);
  assert(Array.isArray(manifest.entries), `${root}: install manifest entries must be an array`);
  return manifest;
}

function assertInstallManifestShape(root, patched, contracts) {
  const manifest = parseInstallManifest(root, patched);
  const names = new Set(manifest.entries.map(entry => entry.name));
  for (const name of [
    'install.extensionCsp.style',
    'install.hostBadgeCommAttach',
    'install.extensionHtmlHead',
    'install.workbenchOverlay',
    'install.hostRoute',
    'install.webviewConfig',
    'install.hostStateBridge',
    'install.streamUnhandledCase',
    'install.monacoDiff.theme',
    'install.renderTimeCode',
    'install.enhanceImport',
    'install.webviewContract',
  ]) {
    assert(names.has(name), `${root}: install manifest missing ${name}`);
  }
  assert(
    manifest.entries.every(entry =>
      entry.schemaVersion === 1 &&
      entry.layer === 'install' &&
      typeof entry.status === 'string' &&
      typeof entry.priority === 'string' &&
      typeof entry.anchorReason === 'string' &&
      typeof entry.contractReason === 'string' &&
      entry.fingerprint &&
      typeof entry.fingerprint === 'object'),
    `${root}: install manifest entry shape mismatch`,
  );
  const byName = new Map(manifest.entries.map(entry => [entry.name, entry]));
  const route = byName.get('install.hostRoute');
  assert(route && route.priority === 'normal' && route.fingerprint && route.fingerprint.version,
    `${root}: install.hostRoute must include normal-priority version/content fingerprints`);
  assert.strictEqual(route.status, 'patched',
    `${root}: official restore fixture must match a known version/content route`);
  for (const highRiskName of [
    'install.implicitSelectionSend',
    'install.hostStateBridge',
    'install.streamUnhandledCase',
  ]) {
    const entry = byName.get(highRiskName);
    assert(entry, `${root}: install manifest missing high-risk ${highRiskName}`);
    assert.strictEqual(entry.priority, 'high', `${root}: ${highRiskName} must be high priority`);
    assert(entry.fingerprint && typeof entry.fingerprint === 'object',
      `${root}: ${highRiskName} must include a double-layer fingerprint payload`);
    assert.notStrictEqual(entry.anchorReason, entry.contractReason,
      `${root}: ${highRiskName} must distinguish anchorReason from contractReason`);
  }
  for (const highRiskName of [
    'install.extensionCsp.style',
    'install.extensionCsp.script',
    'install.extensionCsp.font',
    'install.hostBadgeCommAttach',
    'install.privateMessageGuard',
  ]) {
    const entry = byName.get(highRiskName);
    assert(entry, `${root}: install manifest missing high-risk extension contact ${highRiskName}`);
    assert.strictEqual(entry.priority, 'high', `${root}: ${highRiskName} must be high priority`);
    assert(entry.fingerprint && typeof entry.fingerprint === 'object',
      `${root}: ${highRiskName} must include a contact fingerprint payload`);
  }
  assert(
    Array.isArray(contracts) && contracts.length >= manifest.entries.length,
    `${root}: patchWebviewIndex must return the structured install contracts it injected`,
  );
}

function bodyObserveCalls(source) {
  const calls = [];
  let index = 0;
  while (true) {
    const hit = source.indexOf('observe(document.body', index);
    if (hit < 0) return calls;
    const end = source.indexOf(');', hit);
    calls.push(source.slice(hit, end > hit ? end + 2 : hit + 220));
    index = hit + 1;
  }
}

function assertBodyObserverPolicy(sources) {
  const attributeAllowed = {
    host_probe: ["attributeFilter: ['class', 'style', 'aria-label', 'aria-valuetext', 'title']"],
    enhance_thinking: ["attributeFilter: ['open']"],
  };
  for (const [name, source] of Object.entries(sources)) {
    for (const call of bodyObserveCalls(source)) {
      assert(
        !call.includes('characterData: true'),
        `${name}: document.body observers must never observe characterData`,
      );
      if (!call.includes('attributes: true')) continue;
      const allowed = attributeAllowed[name] || [];
      assert(
        allowed.some(needle => call.includes(needle)),
        `${name}: document.body attributes observer is not on the audited allowlist:\n${call}`,
      );
    }
  }
}

function assertRuntimeSourceContracts() {
  const hostProbe = fs.readFileSync(path.join(__dirname, '..', 'data', 'host_probe.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'data', 'claude_code_enhance.js'), 'utf8');
  const markdownPreprocess = fs.readFileSync(path.join(__dirname, '..', 'data', 'markdown_preprocess.js'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_shared.js'), 'utf8');
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
  const thinking = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_thinking.js'), 'utf8');
  const footerBadge = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_footer_badge.js'), 'utf8');
  const hostBadge = fs.readFileSync(path.join(__dirname, '..', 'data', 'host-badge.cjs'), 'utf8');
  const typography = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_typography.js'), 'utf8');
  const workbenchOverlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'workbench-overlay.js'), 'utf8');
  const theme = fs.readFileSync(path.join(__dirname, '..', 'data', 'theme.css'), 'utf8');
  const capability = fs.readFileSync(path.join(__dirname, '..', 'data', 'capability.js'), 'utf8');
  const fiberFingerprint = fs.readFileSync(path.join(__dirname, '..', 'data', 'capability', 'fingerprints', 'fiber.js'), 'utf8');
  const companionSelectionReference = fs.readFileSync(path.join(__dirname, '..', 'companion', 'claude-selection-reference', 'extension.js'), 'utf8');
  const install = fs.readFileSync(path.join(__dirname, '..', 'src', 'install.js'), 'utf8');
  const patchContractSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'patch-contract.js'), 'utf8');
  const cssWithoutComments = theme.replace(/\/\*[\s\S]*?\*\//g, '');
  const injectionSurfaceAudit = [
    [
      'extension.js patch',
      install.includes('function patchExtensionJs(') &&
        install.includes("installContractFromAssessment('install.extensionCsp.style'") &&
        install.includes("installContractFromAssessment('install.hostBadgeCommAttach'") &&
        install.includes("installContractFromAssessment('install.privateMessageGuard'"),
    ],
    [
      'webview/index.js patch',
      install.includes('function patchWebviewIndex(') &&
        install.includes("'install.implicitSelectionSend'") &&
        install.includes("'install.streamUnhandledCase'") &&
        install.includes("'install.hostStateBridge'"),
    ],
    [
      'VS Code Workbench overlay patch',
      workbenchOverlay.includes('function preflightWorkbenchOverlayForTarget(') &&
        workbenchOverlay.includes('function applyWorkbenchOverlayForTarget(') &&
        workbenchOverlay.includes('observer.observe(document.body, { childList: true, subtree: true });') &&
        install.includes("name: 'install.workbenchOverlay'"),
    ],
    [
      'webview runtime DOM/state bridge',
      capability.includes('export function defineCapability(') &&
        shared.includes("name: 'runtime.fiber.connection'") &&
        legacy.includes("name: 'runtime.fiber.toolUseBlock'") &&
        install.includes('__incipitPublishHostState'),
    ],
    [
      'companion command bridge',
      companionSelectionReference.includes("const CLAUDE_INSERT_COMMAND = 'incipit.claudeCode.insertAtMention'") &&
        install.includes('incipit.claudeCode.insertAtMention') &&
        install.includes('incipit.claudeCode.hasVisibleWebview'),
    ],
  ];

  assert(
    capability.includes("import { reportCapability, bumpPerfCounter } from './runtime_kernel.js'") &&
      capability.includes('export function defineCapability('),
    'runtime capability layer must export defineCapability on top of runtime_kernel reportCapability/bumpPerfCounter',
  );
  assert.deepStrictEqual(
    injectionSurfaceAudit.map(([name]) => name),
    [
      'extension.js patch',
      'webview/index.js patch',
      'VS Code Workbench overlay patch',
      'webview runtime DOM/state bridge',
      'companion command bridge',
    ],
    'injection surface audit must enumerate the five planned entry classes',
  );
  for (const [name, ok] of injectionSurfaceAudit) {
    assert(ok, `injection surface audit missing coverage for ${name}`);
  }
  assert(
    patchContractSource.includes('function patchContract(') &&
      patchContractSource.includes('function buildInstallManifestPreamble(') &&
      patchContractSource.includes('INSTALL_MANIFEST_SCHEMA = 1'),
    'Node install patch contract layer must expose a schema-versioned manifest preamble builder',
  );
  assert(
    install.includes('buildInstallManifestPreamble(installContracts)') &&
      install.includes("name: 'install.webviewConfig'") &&
      install.includes('buildHostRouteContract(target, extJsOriginal, webviewOriginal)') &&
      install.includes("installContractFromAssessment(") &&
      install.includes("'install.implicitSelectionSend'") &&
      install.includes("'install.streamUnhandledCase'") &&
      install.includes("'install.hostStateBridge'") &&
      install.includes("name: 'install.hostRoute'") &&
      install.includes('installContracts,'),
    'installer must collect structured install contracts including hostRoute/I1/I2, inject __incipitInstallManifest, and expose them in the apply report',
  );
  assert(
    install.includes("const LOCAL_ASSET_TREES = ['katex', 'hljs', 'fonts', 'effort-brain', 'capability', 'legacy', 'mermaid']"),
    'installer must copy capability/, legacy/, and mermaid/ webview asset subtrees',
  );
  assert(
    install.includes('function patchCspDirective(') &&
      install.includes('function assessCspDirectiveContact(') &&
      install.includes('function assessImplicitSelectionSendContact(') &&
      install.includes('function patchBadgeCommAttach(') &&
      install.includes('function assessBadgeCommAttachContact(') &&
      install.includes('function buildWorkbenchOverlayInstallContract(') &&
      install.includes("name: 'install.workbenchOverlay'") &&
      !install.includes('function patchRequiredPattern(') &&
      !install.includes('function patchUniqueReplace(') &&
      !install.includes('STYLE_CSP_PATTERN') &&
      !install.includes('BADGE_COMM_ATTACH_PATTERN') &&
      !install.includes("label: '徽章注入(comm)',\n    replace(text)") &&
      install.includes("installContractFromAssessment('install.extensionCsp.style'") &&
      install.includes("installContractFromAssessment('install.hostBadgeCommAttach'") &&
      install.includes("installContractFromAssessment('install.privateMessageGuard'"),
    'high-risk extension.js injection points must use semantic contact assessments, not naked unique regex replacement',
  );
  assert(
    install.includes('incipit.claudeCode.insertAtMention') &&
      install.includes('incipit.claudeCode.hasVisibleWebview') &&
      !install.includes("match.replace('async()=>{', 'async(__incipitMention)=>{')") &&
      !install.includes('AT_MENTION_COMMAND_LEGACY_PATCHED_PATTERN') &&
      companionSelectionReference.includes("const CLAUDE_INSERT_COMMAND = 'incipit.claudeCode.insertAtMention'") &&
      !companionSelectionReference.includes("const CLAUDE_INSERT_COMMAND = 'claude-vscode.insertAtMention'"),
    'explicit editor references must use incipit private command bridge, not patch Claude Code official insertAtMention callback arguments',
  );
  assert(
    install.includes("const DORMANT_WEBVIEW_ASSET_FILES = Object.freeze({") &&
      install.includes("legacy: new Set(['session_status.js'])") &&
      install.includes("filter(rel => !excluded.has(rel.split(path.sep).join('/')))") &&
      install.includes('syncAssetTree(srcTree, dstTree, DORMANT_WEBVIEW_ASSET_FILES[treeName])'),
    'installer must keep dormant session_status source out of apply-copied legacy assets',
  );
  assert(
    capability.includes('__incipitInstallManifest') &&
      capability.includes('publishInstallManifestCapabilities') &&
      capability.includes("reportCapability(entry.name, status") &&
      capability.includes('priority: entry.priority') &&
      capability.includes('fingerprint: safeDetail(entry.fingerprint)'),
    'webview capability layer must publish install manifest entries into the health registry',
  );
  assert(
    install.includes("[path.join('data', 'capability.js'),") &&
      install.includes("'capability.js'"),
    'installer must copy data/capability.js into the webview root assets',
  );
  assert(
    install.includes("[path.join('data', 'markdown_preprocess.js'),") &&
      bootstrap.includes("import { preprocessMarkdown } from './markdown_preprocess.js'") &&
      bootstrap.includes('raw => preprocessMarkdown(raw, { math: CFG.math })') &&
      bootstrap.includes("links: 'enabled'") &&
      markdownPreprocess.includes('export function preprocessMarkdownBareUrls') &&
      markdownPreprocess.includes('PREPROCESS_CACHE_MAX_ENTRIES') &&
      markdownPreprocess.includes('PREPROCESS_CACHE_MAX_CHARS') &&
      markdownPreprocess.includes('preprocessCache.get(text)') &&
      markdownPreprocess.includes('rememberPreprocessCache(text, math, next)') &&
      markdownPreprocess.includes('preprocessMarkdownMath(next)') &&
      markdownPreprocess.includes('fencedCodeEnd(text, i)') &&
      markdownPreprocess.includes('inlineCodeEnd(text, i)') &&
      markdownPreprocess.includes('startsAsciiFolded(text, i,'),
    'markdown preprocess must copy the cached URL-boundary normalizer and run it before the optional math pass without touching code spans',
  );
  assert(
    typography.includes('function renderTableBreakTextNodes(') &&
      typography.includes('const TABLE_BR_TEXT_RE = /<br\\s*\\/?>/i;') &&
      typography.includes('const TABLE_BR_SPLIT_RE = /<br\\s*\\/?>/ig;') &&
      typography.includes("const TABLE_BR_NODE_ATTR = 'data-incipit-table-br';") &&
      typography.includes("const TABLE_BR_SOURCE_ATTR = 'data-incipit-table-br-source';") &&
      typography.includes("scope.querySelectorAll('td, th')") &&
      typography.includes('cell.closest(SEL.markdownRoot)') &&
      typography.includes('SEL.userBubble') &&
      typography.includes('SEL.toolUse') &&
      typography.includes('SEL.thinking') &&
      typography.includes("'CODE', 'PRE'") &&
      typography.includes("document.createElement('br')") &&
      typography.includes("source.hidden = true") &&
      typography.includes("source.textContent = match[0]") &&
      typography.includes("markStreamDirty('typography', root)") &&
      typography.includes('function scheduleTableBreakScan(') &&
      typography.includes("scheduleIdleTask('typography.tableBreakScan'") &&
      typography.includes('function runTableBreakScan(') &&
      typography.includes('if (conversationIsBusy()) return') &&
      typography.includes("subscribe('assistantTurnFinalized', () => scheduleTableBreakScan") &&
      typography.includes("subscribe('streamSettled', () => scheduleTableBreakScan") &&
      typography.includes("scheduleTableBreakScan('init')") &&
      !markdownPreprocess.includes('data-incipit-table-br') &&
      !markdownPreprocess.includes('<br\\s*\\/?>'),
    'literal table <br> tokens must be a finalized/idle assistant table visual pass, not a markdown preprocess rewrite',
  );
  assert(
    fiberFingerprint.includes("REACT_FIBER_KEY_PREFIX = '__reactFiber'") &&
      !shared.includes('__reactFiber') &&
      !legacy.includes('__reactFiber'),
    'React fiber host key literal must live only under data/capability/fingerprints/',
  );
  assert(
    !legacy.includes('noteToolFoldProbe') &&
      !legacy.includes('toolFoldProbe = {') &&
      !legacy.includes('legacy.toolFoldFiberProbe'),
    'legacy tool fold fiber probe health must be replaced by runtime.fiber.toolUseBlock capability',
  );
  assert(
    legacy.includes('toolUseBlockCap = defineCapability({') &&
      legacy.includes("name: 'runtime.fiber.toolUseBlock'") &&
      legacy.includes('const result = toolUseBlockCap.read(el)'),
    'readToolUseBlock must go through the runtime.fiber.toolUseBlock capability without changing its public return shape',
  );
  for (const name of [
    'runtime.fiber.connection',
    'runtime.fiber.sessionsManager',
    'runtime.fiber.activeSessionObject',
    'runtime.fiber.appContext',
    'runtime.fiber.transcriptRecord',
    'runtime.fiber.toolUseBlock',
    'runtime.fiber.toolResultSignal',
    'runtime.fiber.diffPayload',
    'runtime.fiber.fileOpener',
  ]) {
    assert(
      shared.includes(`name: '${name}'`) || legacy.includes(`name: '${name}'`),
      `runtime fiber capability missing: ${name}`,
    );
  }
  assert(
    shared.includes('connectionCap = defineCapability({') &&
      shared.includes("name: 'runtime.fiber.connection'") &&
      shared.includes('staleAfterMs: 800') &&
      shared.includes('const result = connectionCap.read()'),
    'enhance_shared locateClaudeConnection must be the single runtime.fiber.connection capability with the shared cache',
  );
  assert(
    legacy.includes('function locateConnection()') &&
      legacy.includes('return locateClaudeConnection();') &&
      !legacy.includes('legacyConnectionCap') &&
      !legacy.includes("name: 'runtime.fiber.connection.legacy'") &&
      !legacy.includes('let cachedConnection = null') &&
      !legacy.includes('function findConnectionInValue'),
    'legacy connection helper must delegate to shared locateClaudeConnection; batch 3 deletes the private legacy cache/finder',
  );
  for (const [cap, readCall] of [
    ['sessionsManagerCap', 'sessionsManagerCap.read()'],
    ['activeSessionObjectCap', 'activeSessionObjectCap.read()'],
    ['appContextCap', 'appContextCap.read()'],
    ['transcriptRecordCap', 'transcriptRecordCap.read(el)'],
    ['diffPayloadCap', 'diffPayloadCap.read(wrapper)'],
    ['toolResultSignalCap', 'toolResultSignalCap.read({ useBlock, el })'],
    ['fileOpenerCap', 'fileOpenerCap.read(el)'],
  ]) {
    assert(
      legacy.includes(`${cap} = defineCapability({`) && legacy.includes(`const result = ${readCall}`),
      `${cap} wrapper must preserve the original public helper signature through capability.read`,
    );
  }
  const legacyModules = {
    identity: 'initLegacyIdentity',
    transcript_actions: 'initLegacyTranscriptActions',
    tool_fold: 'initLegacyToolFold',
    diff_island: 'initLegacyDiffIsland',
    fork_rewind: 'initLegacyForkRewind',
    user_bubble: 'initLegacyUserBubble',
    deferred_next: 'initLegacyDeferredNext',
    ask_refinement: 'initLegacyAskRefinement',
  };
  for (const [moduleName, initName] of Object.entries(legacyModules)) {
    const modulePath = path.join(__dirname, '..', 'data', 'legacy', `${moduleName}.js`);
    const source = fs.readFileSync(modulePath, 'utf8');
    assert(
      source.includes("import { runLegacyInit } from './registry.js'") &&
        source.includes(`export function ${initName}`) &&
        source.includes(`runLegacyInit('${moduleName}'`),
      `legacy split module ${moduleName}.js must expose an independent init with legacy.${moduleName} health`,
    );
    assert(
      legacy.includes(`./legacy/${moduleName}.js`) && legacy.includes(`${initName}(legacyContext)`),
      `enhance_legacy must import and call ${initName}`,
    );
  }
  assert(
    /initLegacyAskRefinement\(legacyContext\);\r?\n\s*initLegacyTranscriptActionDebug\(legacyContext\);/.test(legacy),
    'legacy split must preserve the old init order by running transcript debug tools after ask refinement setup',
  );
  const sessionStatus = fs.readFileSync(path.join(__dirname, '..', 'data', 'legacy', 'session_status.js'), 'utf8');
  assert(
    sessionStatus.includes('Dormant prototype (2026-06-02)') &&
      sessionStatus.includes("import { reactFiberForElement } from '../capability/fingerprints/fiber.js'") &&
      sessionStatus.includes("import { runLegacyInit } from './registry.js'") &&
      sessionStatus.includes('export function initLegacySessionStatus') &&
      sessionStatus.includes("runLegacyInit('session_status'") &&
      sessionStatus.includes('reactFiberForElement(row)') &&
      sessionStatus.includes('function sessionForRow(row)') &&
      sessionStatus.includes('function isSessionState(value)') &&
      sessionStatus.includes("isSignalLike(value.busy)") &&
      sessionStatus.includes("isSignalLike(value.pendingInput)") &&
      sessionStatus.includes("isSignalLike(value.isLoading)") &&
      sessionStatus.includes("isSignalLike(value.sessionId)"),
    'dormant session status prototype must remain available and keep its row-local SessionState design',
  );
  assert(
    sessionStatus.includes("'[class*=\"sessionsList\"]'") &&
      sessionStatus.includes("'button[class*=\"sessionItem\"]'") &&
      sessionStatus.includes("'[class*=\"sessionMeta\"]'") &&
      sessionStatus.includes("'[class*=\"sessionTime\"]'") &&
      sessionStatus.includes("'data-incipit-session-state'") &&
      sessionStatus.includes("'data-incipit-session-spinner'") &&
      sessionStatus.includes("row.querySelector('[' + SPINNER_ATTR + ']')") &&
      !sessionStatus.includes("meta.querySelector('[' + SPINNER_ATTR + ']'") &&
      sessionStatus.includes('row.insertBefore(spinner, meta)') &&
      !sessionStatus.includes('meta.insertBefore(spinner') &&
      sessionStatus.includes("return 'waiting'") &&
      sessionStatus.includes("return 'loading'") &&
      sessionStatus.includes("return 'running'"),
    'dormant session status prototype must keep the non-grid row decoration design',
  );
  for (const forbidden of [
    'interruptClaude',
    'session.send',
    '.send(',
    'loadFromServer',
    'activateSessionFromServer',
    'activeSession.value',
    'preventDefault',
    'stopPropagation',
    'addEventListener(\'click\'',
    'addEventListener("click"',
    'newest',
    'lastModifiedTime',
    'subscribeRuntime',
    'runtime_kernel',
    'MutationObserver',
    'subtree',
    'characterData',
    'addEventListener(\'scroll\'',
    'addEventListener("scroll"',
  ]) {
    assert(
      !sessionStatus.includes(forbidden),
      `dormant session status prototype must stay UI-only and avoid dangerous path: ${forbidden}`,
    );
  }
  const warmWhite = fs.readFileSync(path.join(__dirname, '..', 'data', 'warm-white-override.css'), 'utf8');
  const customModelStart = legacy.indexOf('Custom model picker.');
  const customModelEnd = legacy.indexOf('// Look up the *current* record', customModelStart);
  assert(customModelStart >= 0 && customModelEnd > customModelStart,
    'custom model picker source block must be present and bounded');
  const customModel = legacy.slice(customModelStart, customModelEnd);
  const legacyInit = legacy.match(/\n  function init\(\) \{([\s\S]*?)\n  \}\n\n  whenDOMReady\(init\);/);
  assert(legacyInit, 'legacy root init() body must be findable for dormant feature audits');
  assert(
    customModel.includes("const CUSTOM_MODEL_ACTION_ID = 'incipit-custom-model-id';") &&
      customModel.includes("const CUSTOM_MODEL_ACTION_LABEL = 'Use custom model ID...';") &&
      customModel.includes("label: 'Use custom model ID...'") &&
      customModel.includes("description: 'Set a model by full ID'") &&
      customModel.includes("}, 'Model', () => openCustomModelDialog())") &&
      customModel.includes('setupCustomModelActionDecoration();') &&
      legacyInit[1].includes('setupCustomModelPicker,') &&
      /^\s*setupCustomModelPicker\(\);/m.test(legacyInit[1]),
    'custom model picker must register one pure-text command action in the official Model section',
  );
  assert(
    customModel.includes('locateActiveSessionState()') &&
      customModel.includes('typeof session.setModel') &&
      customModel.includes('await session.setModel(makeCustomModelOption(raw))') &&
      customModel.includes("value,\n      displayName: modelDisplayNameFromId(value),\n      description: 'Custom model ID'"),
    'custom model picker must call official SessionState.setModel(modelObject) with the entered model ID',
  );
  assert(
    !legacy.includes('/model') &&
      !customModel.includes('io_message') &&
      !customModel.includes('session.send') &&
      !customModel.includes('localStorage') &&
      !customModel.includes('recentModels') &&
      !customModel.includes('recent model'),
    'custom model picker must not simulate slash input or keep recent-model state in the menu',
  );
  assert(
    theme.includes('[data-incipit-custom-model-modal]') &&
      theme.includes('[data-incipit-custom-model-action]::after') &&
      theme.includes('content: "incipit" !important') &&
      theme.includes('font-family: var(--incipit-emphasis-font) !important') &&
      theme.includes('font-style: italic !important') &&
      theme.includes('[data-incipit-custom-model-dialog]') &&
      theme.includes('[data-incipit-custom-model-input]') &&
      theme.includes('[data-incipit-custom-model-submit]') &&
      theme.includes('background: var(--ink-surface-panel) !important') &&
      theme.includes('caret-color: var(--ink-custom-model-input-caret) !important') &&
      theme.includes('[data-incipit-custom-model-input]:focus') &&
      theme.includes('box-shadow: none !important') &&
      theme.includes('background: var(--ink-custom-model-submit-bg) !important') &&
      warmWhite.includes('--ink-surface-panel: #ffffff;') &&
      warmWhite.includes('--ink-custom-model-input-caret: #a8896e;') &&
      warmWhite.includes('--ink-custom-model-submit-bg: #a8896e;'),
    'custom model modal must use scoped semantic styling, stable input focus, and palette-owned action tokens',
  );
  assert(
    !legacy.includes("./legacy/session_status.js") &&
      !legacy.includes('initLegacySessionStatus(legacyContext)') &&
      !theme.includes('[data-incipit-session-spinner]') &&
      !theme.includes('[data-incipit-session-state=') &&
      !theme.includes('@keyframes incipit-session-spin') &&
      !warmWhite.includes('[data-incipit-session-spinner]') &&
      !warmWhite.includes('[data-incipit-session-state='),
    'session status prototype must remain dormant: no legacy import/init or shipped CSS',
  );
  assert(
    legacy.includes('function setupChangeReviewFileReview()') &&
      legacy.includes('function renderChangeReviewTurnBlocks()') &&
      legacy.includes('function setupChangeReviewChannel()') &&
      !legacy.includes('function renderChangeReviewCard()') &&
      !legacy.includes('function ensureChangeReviewCard()') &&
      !legacy.includes('function changeReviewActiveTurn()') &&
      !legacy.includes('scheduleChangeReviewRender') &&
      !legacy.includes('activeTurn:') &&
      !theme.includes('[data-incipit-change-review-card]') &&
      legacyInit[1].includes('setupChangeReviewFileReview,') &&
      /^\s*setupChangeReviewFileReview\(\);/m.test(legacyInit[1]),
    'change review finalized transcript UI must remain active while composer mini bar stays removed',
  );
  assert(
    hostBadge.includes('const CHANGE_REVIEW_RUNTIME_ENABLED = true;') &&
      hostBadge.includes('function isChangeReviewRuntimeMessage(type)') &&
      hostBadge.includes('if (isChangeReviewRuntimeMessage(message.type) && !CHANGE_REVIEW_RUNTIME_ENABLED) return;') &&
      hostBadge.includes('if (CHANGE_REVIEW_RUNTIME_ENABLED) {') &&
      hostBadge.includes('const changeReviewPayload = buildCachedChangeReviewPayload(state, target, parser);') &&
      !hostBadge.includes('activeTurn:') &&
      !hostBadge.includes('visibleActiveTurn') &&
      hostBadge.includes('module.exports.__test = {') &&
      hostBadge.includes('buildChangeReviewPayload,') &&
      hostBadge.includes('resolveChangeReviewReject,'),
    'change review host runtime protocol must keep finalized review helpers but not expose active composer-review payloads',
  );
  assert(
    capability.includes('const MISS_REASONS = new Set([') &&
      capability.includes("reason: 'error'") &&
      capability.includes("reason: 'shapeMiss'") &&
      legacy.includes("return { ok: false, value: null, reason: 'notMounted' }") &&
      legacy.includes("return { ok: false, value: null, reason: 'noFiber' }") &&
      legacy.includes("return { ok: false, value: null, reason: 'shapeMiss' }") &&
      legacy.includes("return { ok: true, value: { block: outer, status: p.status }, reason: 'ok' }"),
    'runtime capability probes must return explicit ProbeResult objects with classified reasons',
  );

  assert(
    hostProbe.includes('function isUserTextContentNode') &&
      hostProbe.includes('container.querySelectorAll(\'[class*="expandableContainer"] [class*="content_"]\')'),
    'user bubble host probe must tag only the official expandable text content node',
  );
  assert(
    !hostProbe.includes('container.querySelectorAll(\'[class*="content_"]\').forEach'),
    'user bubble host probe must not tag every content_ node in the user container',
  );
  assert(
    legacy.includes('USER_TEXT_CONTENT_SELECTOR') &&
      legacy.includes('[class*="expandableContainer"] [class*="content_"]'),
    'user bubble classifier must measure the official expandable text content node',
  );
  assert(
    !legacy.includes('textLen * 10 + (el.scrollHeight || 0)'),
    'user bubble content-node selection must not force layout while scoring candidates',
  );
  assert(
    theme.includes('[data-incipit-user-bubble]:not(:has([data-incipit-interrupted-message])) [class*="expandableContainer"] [class*="content_"]') &&
      theme.includes('[data-incipit-user-bubble][data-claude-length="long"]:not([data-claude-expanded="1"]) [class*="expandableContainer"] [class*="content_"]'),
    'user bubble CSS must override the host 60px clip and preserve incipit long-message clipping',
  );
  assert(
    typography.includes('function isStreamingMountWorthScanning') &&
      typography.includes("cls.indexOf('userMessage_')") &&
      typography.includes("cls.indexOf('root_')"),
    'streaming childList gate must keep new user bubbles and markdown roots on the fast mint path via cheap className checks',
  );
  assert(
    !typography.includes('function scanUserBubbleUi'),
    'scanUserBubbleUi fast path must remain removed — it ran matches/closest/querySelectorAll on every streaming added node, almost always missing user bubbles entirely',
  );
  assert(
    !typography.includes('pendingRoots.add(document.body)'),
    'highlight.js readiness must not trigger a second document-wide copy/action sweep',
  );
  assert(
    typography.includes('function explicitHighlightLanguage(') &&
      typography.includes('function hljsCanHighlightBlock(') &&
      typography.includes('window.hljs.getLanguage(lang)') &&
      typography.includes('block.dataset.incipitHljsUnsupportedLanguage = lang') &&
      typography.includes("block.classList.add('hljs')") &&
      typography.includes('if (hljsCanHighlightBlock(block))') &&
      typography.includes('window.hljs.highlightElement(block)') &&
      typography.includes('if (isDiffIsland) applyIncipitDiffCharRangesToCode(block);'),
    'highlight.js must preflight language-* classes and skip unsupported grammars without console-warning floods, while preserving diff char overlays',
  );
  const renderTimeBusyProbe = bootstrap.slice(
    bootstrap.indexOf('function renderTimeHighlightIsBusy()'),
    bootstrap.indexOf('function noteRenderHealth('),
  );
  assert(
    renderTimeBusyProbe.includes('try { return kernelConversationIsBusy(); }') &&
      renderTimeBusyProbe.includes('catch (_) { return true; }') &&
      !renderTimeBusyProbe.includes('catch (_) { return false; }'),
    'render-time auto-highlighting must treat unknown host state as busy so large streaming code stays on the settled fallback path',
  );

  const kernel = fs.readFileSync(path.join(__dirname, '..', 'data', 'runtime_kernel.js'), 'utf8');
  assert(
    bootstrap.includes('initRuntimeKernel();') &&
      !/^\s*initRuntimeKernel\(\);\s*$/m.test(kernel),
    'runtime kernel must initialize from bootstrap, not at module evaluation time; enhance_shared now owns a fiber capability and module-level auto-init re-enters it before ESM initialization finishes',
  );
  assert(
    kernel.includes("reportCapability('runtime.hostState.semanticBridge'") &&
      !kernel.includes("reportCapability('hostState.semanticBridge'") &&
      kernel.includes('getActiveClaudeSessionId({ allowStaleState: true, skipFiber: true })') &&
      !kernel.includes("import { SEL } from './host_probe.js'"),
    'host-state semantic bridge must report as runtime.hostState.semanticBridge and must not use the fiber connection fallback internally',
  );
  assert(
    kernel.includes('cwd: null,') &&
      kernel.includes("const cwd = typeof bridge.cwd === 'string' && bridge.cwd") &&
      kernel.includes('hostState.cwd = next.cwd || null;') &&
      kernel.includes('const prevCwd = hostState.cwd;') &&
      kernel.includes('const sessionChanged = prevSessionId !== hostState.sessionId || prevCwd !== hostState.cwd;'),
    'runtime host state must preserve cwd from the semantic bridge and treat cwd changes as active-session identity changes',
  );
  assert(
    kernel.includes('export function registerBusyProbe(name, probe)') &&
      kernel.includes('function compositeBusyState(state = hostState)') &&
      kernel.includes('const COMPOSITE_BUSY_RECHECK_MS = 160;') &&
      kernel.includes('const COMPOSITE_BUSY_RECHECK_MAX_MS = 8000;') &&
      kernel.includes('let lastCompositeBusy = null;') &&
      kernel.includes('function maintainCompositeBusyRecheck(compositeBusy, reason)') &&
      kernel.includes('if (state && state.pendingInput === true) return true;') &&
      kernel.includes("const domState = sendButtonDomState();") &&
      kernel.includes("if (domState === 'stop') return true;") &&
      kernel.includes("if (domState === 'send' && nowMs() - lastRuntimeDirtyAt > 1500) return false;") &&
      kernel.includes('if (state && state.partialTail === true) return true;') &&
      kernel.includes('const compositeChanged = !sessionChanged') &&
      kernel.includes('if (compositeChanged)') &&
      kernel.includes('rawBusy: hostState.busy') &&
      kernel.includes('previousCompositeBusy: prevCompositeBusy') &&
      kernel.includes("emit('assistantTurnFinalized'"),
    'runtime kernel finalized/busy events must use composite busy transitions: bridge true/pending, DOM stop, stable-send, partial tail, registered feature probes, and low-frequency idle recheck',
  );
  assert(
    !kernel.includes('setupMutationBus') &&
      !kernel.includes('emitAddedNodeEvents') &&
      !kernel.includes('handleMutationBusRecords'),
    'runtime kernel must not run a body-subtree mutationBus — every added node paying for 6 selector tests was the streaming CPU regression',
  );
  assert(
    !kernel.includes("emit('toolUseMounted'") &&
      !kernel.includes("emit('assistantMarkdownMounted'") &&
      !kernel.includes("emit('messagesDomChanged'"),
    'runtime kernel must not emit per-node mutation events — feature modules keep their own filtered observers',
  );
  assert(
    !kernel.includes('walkFiberAnchors') &&
      !kernel.includes('locateActiveSessionState') &&
      !kernel.includes('locateSessionsManager'),
    'runtime kernel must not run its own fiber walk — bridge-less mode should fall through to consumer-local probes, not pile on a second walker',
  );
  assert(
    hostProbe.includes('const CSS_CAPABILITIES = Object.freeze([') &&
      hostProbe.includes("name: 'runtime.cssClass.userBubble'") &&
      !hostProbe.includes('function isInputContainerCandidate(node)') &&
      !hostProbe.includes("classes.includes('inputContainer_')") &&
      !hostProbe.includes("classes.includes('inputContainerBackground')") &&
      !hostProbe.includes('syncInputContainers') &&
      !hostProbe.includes('ATTR.inputContainer') &&
      !hostProbe.includes("['[class*=\"inputContainer_\"]', ATTR.inputContainer]") &&
      !hostProbe.includes("selectors: ['fieldset[class*=\"inputContainer_\"]', '[class*=\"inputContainer_\"]:has(> [class*=\"inputContainerBackground\"])']") &&
      hostProbe.includes("presence: 'whileVisible'") &&
      hostProbe.includes('CSS_ALWAYS_WARMUP_MS = 5000') &&
      hostProbe.includes('function runAlwaysCssCapabilityCheck') &&
      hostProbe.includes('function scheduleVisibleCssCapabilityCheck') &&
      hostProbe.includes("health.set('capability.' + def.name"),
    'host_probe must expose runtime.cssClass capabilities without tagging or capability-probing the composer input container subtree',
  );
  assert.strictEqual(
    (hostProbe.match(/new MutationObserver/g) || []).length,
    1,
    'CSS capability reporting must reuse the existing host_probe MutationObserver',
  );
  assert(
    hostProbe.includes('if (editorFocused && active.contains(node)) continue;') &&
      hostProbe.includes('if (editorFocused && !hasOutsideMutation) return;') &&
      hostProbe.includes('scheduleSiblingRescan();'),
    'host_probe must not tag or rescan focused contenteditable input mutations; only outside/sibling regions may wake the localized rescan',
  );
  assertBodyObserverPolicy({
    host_probe: hostProbe,
    enhance_thinking: thinking,
    enhance_footer_badge: footerBadge,
    enhance_legacy: legacy,
    enhance_typography: typography,
    workbench_overlay: workbenchOverlay,
  });
  assert(
    thinking.includes('const thinkingTimingByKey = new Map();') &&
      thinking.includes('const thinkingSummaryObservers = new Map();') &&
      thinking.includes('const THINKING_REPLACE_GRACE_MS = 1500;') &&
      thinking.includes("const isLiveThinkingLabel = (text) => /^Thinking\\.\\.\\./") &&
      thinking.includes("const isDoneThinkingLabel = (text) => /^Thought for \\d+s\\b/") &&
      thinking.includes("const nowMs = () => (window.performance && typeof window.performance.now === 'function')") &&
      thinking.includes('activeSummary: summary || null') &&
      thinking.includes('const noteThinkingSummaryDetached = (key, summary) =>') &&
      thinking.includes('existing.activeSummary === summary') &&
      thinking.includes('endMs <= existing.pendingRemountUntilMs') &&
      thinking.includes('thinkingTimingByKey.delete(key);') &&
      thinking.includes('formatThoughtDuration(timing.durationMs)') &&
      thinking.includes('observer.observe(summary, { childList: true, subtree: true, characterData: true });') &&
      thinking.includes('cleanupThinkingSummaryObservers(seenSummaries)'),
    'thinking duration must be measured only from an observed live summary to its done transition; missed historical/virtualized transitions must not synthesize wall-clock durations',
  );
  assert(
    footerBadge.includes('function nodeInsideFocusedEditor(node)') &&
      footerBadge.includes('function mutationInsideFocusedEditor(mutation)') &&
      footerBadge.includes('function nodeInsideMessagesContainer(node)') &&
      footerBadge.includes('function mutationTouchesAddedNode(mutation, predicate)') &&
      footerBadge.includes('function nodeCouldContainFooter(node)') &&
      footerBadge.includes('mutationTouchesAddedNode(mutation, nodeCouldContainFooter)') &&
      footerBadge.includes('function nodeCouldContainKbdSymbol(node)') &&
      footerBadge.includes('nodeCouldContainKbdSymbol(n)') &&
      footerBadge.includes('function mutationTouchesFooter(m)') &&
      footerBadge.includes('if (mutationInsideFocusedEditor(m)) return false;') &&
      footerBadge.includes('nodeInsideMessagesContainer(n)') &&
      footerBadge.includes('function mutationTouchesHeader(m)'),
    'footer badge/header/kbd body observers must skip focused editor and message-scroll mutations before any footer/header finder query',
  );
  assert(
    footerBadge.includes('function currentSessionIdentity()') &&
      footerBadge.includes("var key = (sessionId || '') + '\\n' + (cwd || '');") &&
      footerBadge.includes("type: 'badge_identity_update'") &&
      footerBadge.includes("type: 'edit_activity_identity_update'") &&
      (footerBadge.match(/cwd: cwd \|\| null/g) || []).length >= 2 &&
      legacy.includes('function getActiveSessionCwd()') &&
      legacy.includes("type: 'change_review_identity_update'") &&
      legacy.includes('cwd: getActiveSessionCwd() || null') &&
      hostBadge.includes('const incomingCwd = typeof message.cwd ===') &&
      hostBadge.includes('a miss fails closed') &&
      hostBadge.includes('current webviews send cwd'),
    'session usage, edit activity, and change review identity messages must carry cwd so same-session/different-entry webviews bind the real transcript instead of guessing across projects',
  );
  assert(
    legacy.includes('function mutationInsideFocusedEditor(mutation)') &&
      legacy.includes('function nodeInsideMessagesContainer(node)') &&
      legacy.includes('if (mutationInsideFocusedEditor(m)) continue;') &&
      legacy.includes('if (nodeInsideMessagesContainer(node)) return false;') &&
      legacy.includes('function mutationTouchesAskSurface(m)') &&
      legacy.includes('if (!askActive && !structural) continue;') &&
      legacy.includes('function enqueueAffectedToolUses(node, targetInsideToolUse)') &&
      legacy.includes('node.firstElementChild && node.querySelectorAll') &&
      legacy.includes('const targetInsideToolUse = !!(') &&
      !legacy.includes('for (const node of m.addedNodes) enqueueAffectedToolUses(node);') &&
      typography.includes('function mutationsAllInsideFocusedEditor(mutations)') &&
      typography.includes('if (mutationsAllInsideFocusedEditor(mutations)) return;'),
    'legacy/typography body observers must not wake scan paths for composer-internal mutations, message-scroll composer lookups, inactive Ask panels, or ordinary prose tool-use ancestor walks',
  );
  assert(
    kernel.includes('SEND_BUTTON_DOM_CACHE_MS = 32') &&
      kernel.includes('function readSendButtonDomState()') &&
      kernel.includes('if (sendButtonDomCachedAt && now - sendButtonDomCachedAt <= SEND_BUTTON_DOM_CACHE_MS)') &&
      kernel.includes("if (probeState === 'legacy-false') return false;") &&
      legacy.includes('SEND_BUTTON_DOM_CACHE_MS = 32') &&
      legacy.includes('function readSendButtonDomState()') &&
      legacy.includes('if (sendButtonDomCachedAt && now - sendButtonDomCachedAt <= SEND_BUTTON_DOM_CACHE_MS)'),
    'busy hot path must cache send/stop DOM scans for a short frame window and avoid kernel re-scanning after legacy composite false',
  );

  // ---- busy tri-state (2026-06-09): "all probes missed" must never collapse
  // to idle on a state-mutating path. The probe answers true/false/null; the
  // kernel throws instead of vouching idle off a stale bridge; mutating gates
  // ride the fail-closed predicate while visual surfaces stay fail-open.
  assert(
    /function legacyCompositeBusyProbe\(\)[\s\S]{0,2200}?if \(sessionBusy === false\) return false;\r?\n\s*return null;/.test(legacy),
    'legacyCompositeBusyProbe must be tri-state: fiber not-busy evidence returns false, an all-miss (no fiber, no send/stop DOM, no partial tail) returns null — a bare trailing `return false` reopens the silent-green-light hole',
  );
  assert(
    kernel.includes('const BRIDGE_IDLE_TRUST_MS = 30000;') &&
      kernel.includes('bridgeUpdatedAt: Number(bridge.updatedAt) || 0,') &&
      kernel.includes('hostState.bridgeUpdatedAt = Number(next.bridgeUpdatedAt) || 0;') &&
      kernel.includes('state.bridgeUpdatedAt > 0 &&') &&
      kernel.includes('Date.now() - state.bridgeUpdatedAt <= BRIDGE_IDLE_TRUST_MS)') &&
      kernel.includes("throw new Error('host state bridge unavailable')") &&
      install.includes('updatedAt:Date.now()'),
    'kernel conversationIsBusy may let the bridge vouch for idle only while the bridge object is fresh (producer Date.now() clock); stale or timestamp-less bridges with no composite evidence must throw',
  );
  assert(
    legacy.includes('function conversationBusyTriState()') &&
      legacy.includes('return conversationBusyTriState() === true;') &&
      legacy.includes('function conversationBusyOrUnknown()') &&
      legacy.includes('return conversationBusyTriState() !== false;') &&
      legacy.includes('function blockMutationWhileBusyOrUnknown()'),
    'legacy must expose the tri-state resolver plus the fail-open (visual) and fail-closed (mutating) predicates',
  );
  assert.strictEqual(
    (legacy.match(/if \(blockMutationWhileBusyOrUnknown\(\)\) return;/g) || []).length,
    6,
    'all six user-triggered mutating entries (fork, rewind-only, rerun-with-rewind, fork-with-rewind, save-and-rerun, inline save) must gate through the fail-closed mutation blocker',
  );
  assert(
    /function requestTranscriptMutation\(op, payload, options\)[\s\S]{0,900}?conversationBusyTriState\(\)/.test(legacy) &&
      legacy.includes('local-history edit blocked'),
    'the JSONL mutation choke point must distinguish busy from unknown and reject both with distinct messages',
  );
  assert(
    legacy.includes("if (conversationBusyOrUnknown()) return 'busy';") &&
      legacy.includes('if (!conversationBusyOrUnknown() && (checked || !o.rollbackToken ||'),
    'rerun hand-off quiesce (phase 1) and cut-confirm (phase 2) must treat unknown busy as busy so they time out cleanly instead of cutting under an unobservable stream',
  );
  assert(
    /function sessionIsBusy\(session\)[\s\S]{0,520}?return conversationBusyOrUnknown\(\);/.test(legacy) &&
      /function sessionBusyForDeferredCapture\(session\)[\s\S]{0,620}?return conversationBusyOrUnknown\(\);/.test(legacy) &&
      /function deferredConvBusySafe\(\)[\s\S]{0,520}?return conversationBusyOrUnknown\(\);/.test(legacy),
    'deferred capture/flush busy fallbacks must be fail-closed (unknown ⇒ busy ⇒ capture/freeze, manual Guide stays available)',
  );
  assert(
    /function busyHysteresisReady\(\)[\s\S]{0,320}?if \(conversationIsBusy\(\)\)/.test(legacy) &&
      /function sweepStreamingDisableState\(\)[\s\S]{0,220}?const busy = conversationIsBusy\(\);/.test(legacy) &&
      /function changeReviewBusySafe\(\)[\s\S]{0,560}?return conversationIsBusy\(\);/.test(legacy) &&
      /function openInlineEditor\(\{[\s\S]{0,420}?if \(conversationIsBusy\(\)\) return;/.test(legacy),
    'read-only/visual surfaces (action-row hysteresis, disable sweep, change-review render timing, editor open) must stay on the fail-open predicate so a dead probe surface degrades visually instead of bricking the UI',
  );
  assert(
    workbenchOverlay.includes('function scheduleForEvent(event)') &&
      workbenchOverlay.includes('if (visible || eventInEditor(event)) schedule();') &&
      workbenchOverlay.includes('function scheduleForSelection()') &&
      workbenchOverlay.includes('if (visible || focusedEditorElement()) schedule();') &&
      workbenchOverlay.includes('setInterval(() => { if (visible || focusedEditorElement()) schedule(); }, 900);'),
    'workbench overlay scroll/key/selection/interval hooks must be gated by visible overlay or an active editor, not all Workbench input/scroll',
  );

  assert(
    !hostBadge.includes('stream.write = function wrappedWrite'),
    'host-badge must not overwrite createWriteStream `stream.write` — that mutates host object identity; only `finish`/`close`/`end` events are subscribed',
  );
  assert(
    legacy.includes("makeTipContextMenuItem('Open in File Explorer'") &&
      legacy.includes("makeTipContextMenuItem('Copy Relative Path'") &&
      legacy.includes("makeTipContextMenuItem('Copy Absolute Path'") &&
      !legacy.includes("label.textContent = 'Open in VS Code'") &&
      !legacy.includes("data-incipit-path-tooltip-copy") &&
      !legacy.includes("data-incipit-path-tooltip-more") &&
      legacy.includes('file links in assistant markdown should') &&
      legacy.includes('opener.open(info.filePath, info.location || undefined)') &&
      legacy.includes("document.body.addEventListener('contextmenu', handleTipContextMenu, true)") &&
      legacy.includes('function openTipContextMenu(hit, evt)') &&
      legacy.includes('function requestResolvedFilePaths(info)') &&
      legacy.includes("type: 'file_path_copy_request'") &&
      legacy.includes('copyResolvedPathForFileInfo(\'relative\', info)') &&
      legacy.includes('copyResolvedPathForFileInfo(\'absolute\', info)') &&
      legacy.includes('Could not copy absolute path') &&
      !legacy.includes('return cwd ? joinWorkspacePath(cwd, filePath) : stripCurrentDirPrefix(filePath)') &&
      legacy.includes('locateActiveSessionState()') &&
      legacy.includes('the semantic bridge is degraded') &&
      legacy.includes("type: 'file_reveal_request'") &&
      legacy.includes('function sessionIdForFileAction()') &&
      legacy.includes('sessionId: sessionIdForFileAction()'),
    'link hover tooltip must stay text-only; right-click menu owns file explorer + relative/absolute path copy while markdown file-link clicks use host fileOpener.open',
  );
  assert(
    legacy.includes('function eventTargetElement(node)') &&
      legacy.includes('function closestBodyLink(node)') &&
      legacy.includes('function bodyLinkFromPoint(node, evt)') &&
      legacy.includes('function resolveTipFast(node, evt)') &&
      legacy.includes('function armTipShow(hit, snapshot)') &&
      legacy.includes('document.elementFromPoint(evt.clientX, evt.clientY)') &&
      legacy.includes('assistantMarkdownFallback') &&
      legacy.includes('!!findAssistantActionHost(scope)') &&
      legacy.includes("document.body.addEventListener('mousemove', handleTipHover, { capture: true, passive: true })") &&
      legacy.includes('stable hover over the') &&
      legacy.includes('visible link still arms the dwell timer') &&
      legacy.includes('mousemove hot path: arm one dwell probe') &&
      legacy.includes('no-hit mousemove means the pointer is') &&
      legacy.includes('TIP_HIDE_GRACE = 60') &&
      legacy.includes('setTimeout(hideTip, TIP_HIDE_GRACE)') &&
      legacy.includes('if (tipHideTimer) return') &&
      legacy.includes('tipEl.addEventListener(\'mouseenter\', cancelScheduledHide)') &&
      legacy.includes('tipEl.addEventListener(\'mouseleave\', scheduleHide)') &&
      legacy.includes('Mouse movement should never dismiss it') &&
      legacy.includes("tipEl.style.top = (above ? rect.top - h - 4 : rect.bottom + 4) + 'px'") &&
      legacy.includes('const resolved = hit || (tipPendingProbe ? resolveTip(tipPendingProbe.target, tipPendingProbe) : null)'),
    'assistant body link tooltip must use pointer-coordinate hit testing, but full link scans must run after dwell instead of on every mousemove',
  );
  const hoverStart = legacy.indexOf('function handleTipHover(evt)');
  const hoverEnd = legacy.indexOf('function positionTip()', hoverStart);
  const hoverBlock = hoverStart >= 0 && hoverEnd > hoverStart ? legacy.slice(hoverStart, hoverEnd) : '';
  assert(
    hoverBlock.includes('resolveTipFast(evt.target, evt)') &&
      hoverBlock.includes('if (tipTarget)') &&
      hoverBlock.includes('tipEl.contains(targetEl)') &&
      hoverBlock.includes('scheduleHide()') &&
      !hoverBlock.includes('resolveTip(evt.target, evt)') &&
      !hoverBlock.includes("querySelectorAll('a[href]')") &&
      !hoverBlock.includes('getClientRects()'),
    'mousemove hover handler must stay cheap and use a short non-resetting hide grace; full body-link coordinate scans belong behind the hover-intent timer',
  );
  assert(
    !/::[-\w]*scrollbar/.test(cssWithoutComments),
    'theme.css must not contain live ::-webkit-scrollbar rules; those put the main chat scroller back on the non-composited autoscroll-jitter path',
  );
  assert(
    theme.includes('--vscode-list-activeSelectionBackground: #121212 !important;') &&
      theme.includes('--vscode-list-focusBackground: #121212 !important;') &&
      theme.includes('--vscode-list-hoverBackground: #1a1a19 !important;') &&
      warmWhite.includes('--vscode-list-activeSelectionBackground: #E6E4DE !important;') &&
      warmWhite.includes('--vscode-list-focusBackground: #E6E4DE !important;') &&
      warmWhite.includes('--vscode-list-hoverBackground: #F4F2EC !important;') &&
      !theme.includes('--vscode-list-focusBackground: rgba(248, 248, 246, 0.055) !important;') &&
      !warmWhite.includes('--vscode-list-focusBackground: #F4F2EC !important;'),
    'menu selection palette must stay on the original active/focus colors; stale slash-command state is fixed in runtime cleanup, not by recoloring selection',
  );
  assert(
    legacy.includes('function setupCommandMenuTransientSelectionCleanup()') &&
      legacy.includes('function clearCommandMenuTransientSelection(root = document.body)') &&
      legacy.includes('commandMenuListsFrom(root)') &&
      legacy.includes("item.removeAttribute('aria-selected')") &&
      legacy.includes('item.removeAttribute(ATTR.commandItemActive)') &&
      legacy.includes("cls === 'active' || cls.indexOf('activeCommandItem') !== -1") &&
      legacy.includes('list.removeAttribute(\'aria-activedescendant\')') &&
      legacy.includes('commandMenuSelectionCleanupObserver.observe(document.body, { childList: true, subtree: true })') &&
      legacyInit[1].includes('setupCommandMenuTransientSelectionCleanup,') &&
      /^\s*setupCommandMenuTransientSelectionCleanup\(\);/m.test(legacyInit[1]),
    'slash command menu rows must clear stale active/aria-selected DOM state on mount; permission/dropdown menus keep their real selection state',
  );
  assert(
    theme.includes('[data-incipit-path-context-menu]') &&
      theme.includes('[data-incipit-path-context-menu-visible="1"]') &&
      theme.includes('[data-incipit-path-context-menu-item]:hover') &&
      !theme.includes('[data-incipit-path-tooltip-copy]') &&
      !theme.includes('[data-incipit-path-tooltip-more]') &&
      !theme.includes('[data-incipit-path-tooltip-menu]') &&
      fs.readFileSync(path.join(__dirname, '..', 'data', 'warm-white-override.css'), 'utf8').includes('[data-incipit-path-context-menu]'),
    'path hover surface must be text-only and both themes must style the sticky right-click context menu',
  );
  assert(
      hostBadge.includes("message.type === 'file_reveal_request'") &&
      hostBadge.includes("message.type === 'file_path_copy_request'") &&
      hostBadge.includes("type: 'file_reveal_response'") &&
      hostBadge.includes("type: 'file_path_copy_response'") &&
      hostBadge.includes("require('vscode')") &&
      hostBadge.includes('FILE_REVEAL_CWD_SCAN_BYTES = 512 * 1024') &&
      hostBadge.includes('function resolveFileRevealCwd(state, comm, message)') &&
      hostBadge.includes('function resolveFileCopyPathsForCwd(rawInput, cwd, workspaceRoots)') &&
      hostBadge.includes('vscode.workspace.workspaceFolders') &&
      hostBadge.includes('absolutePath') &&
      hostBadge.includes('relativePathFromWorkspaceRoot') &&
      hostBadge.includes('revealIdentityForMessage(state, comm, message || {})') &&
      hostBadge.includes('readTranscriptCwd(target)') &&
      hostBadge.includes('Relative file path has no Claude project cwd.') &&
      hostBadge.includes("vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolved))") &&
      hostBadge.includes('vscode.env.openExternal(vscode.Uri.file(directoryPath))') &&
      hostBadge.includes('selected: true') &&
      hostBadge.includes('selected: false') &&
      hostBadge.includes('File path is outside the active workspace.'),
    'host-badge must handle link-popover folder reveal through a real VS Code extension-host OS reveal path with openExternal fallback and workspace validation',
  );
}

function semanticBridgeFixture(effectName, constructorEffects) {
  return [
    'const session_states_update = true;',
    `function ${effectName}(fn) { fn(); }`,
    'function w0(value) { return { value }; }',
    'function p2(fn) { return { get value() { return fn(); } }; }',
    'class SessionState {',
    'connection = w0(void 0);',
    'busy = w0(false);',
    'pendingInput = w0(false);',
    'sessionId = w0(void 0);',
    'messages = w0([]);',
    'cwd = w0(void 0);',
    'summary = w0(void 0);',
    'config = p2(() => ({ claudeSettings: { errors: [] } }));',
    'dismissedSettingsErrorsKey = w0(null);',
    `constructor(){${constructorEffects}}`,
    'isOffline(){return !this.connection.value&&!!this.sessionId.value&&!this.messages.value.length&&!this.loadingPromise}',
    'loadFromServer(){}',
    'launchClaude(){}',
    '}',
  ].join('');
}

function assertHostStateBridgePatchVariants() {
  const settingsEffect = effectName =>
    `${effectName}(()=>{if((this.config.value?.claudeSettings?.errors??[]).length===0&&this.dismissedSettingsErrorsKey.value)this.dismissedSettingsErrorsKey.value=null})`;
  const variants = [
    ['legacy class-field-style helper', 'j4', settingsEffect('j4')],
    ['constructor helper rename', 'G4',
      [
        'G4(()=>{if(!this.busy.value)this.summary.value=void 0})',
        settingsEffect('G4'),
      ].join(',')],
    // 2.1.170: helper renamed again and a new effect appended after the
    // settings-error effect — the anchor must not require constructor-close
    // or isOffline adjacency.
    ['trailing sibling effect (2.1.170 shape)', 'Ao',
      `${settingsEffect('Ao')};let i;Ao(()=>{i=this.connection.value})`],
  ];

  for (const [label, effectName, effects] of variants) {
    const source = semanticBridgeFixture(effectName, effects);
    const [patched, line, assessment] = __test.patchHostStateSemanticBridge(source);
    assert(line.includes('ok'), `${label}: bridge should patch cleanly`);
    assert.strictEqual(assessment.status, 'patched', `${label}: assessment should be patched`);
    assert(
      patched.includes(`${settingsEffect(effectName)},${effectName}(()=>{globalThis.__incipitPublishHostState&&globalThis.__incipitPublishHostState(this,"signal")})`),
      `${label}: bridge must reuse the host's local signal effect helper right after the anchor effect`,
    );
    assert.doesNotThrow(
      () => new vm.Script(patched, { filename: `semantic-bridge-${label}.js` }),
      `${label}: patched bridge fixture must remain valid JavaScript`,
    );
    const [repatched, repatchedLine] = __test.patchHostStateSemanticBridge(patched);
    assert.strictEqual(repatched, patched, `${label}: second apply must be idempotent`);
    assert(repatchedLine.includes('ok'), `${label}: second apply should report ok`);
  }

  const degradedSource = [
    'const session_states_update = true;',
    'class SessionState {',
    'connection = { value: null };',
    'busy = { value: false };',
    'pendingInput = { value: false };',
    'sessionId = { value: null };',
    'messages = { value: [] };',
    'cwd = { value: null };',
    'summary = { value: null };',
    'config = { value: { claudeSettings: { errors: [] } } };',
    'dismissedSettingsErrorsKey = { value: null };',
    'isOffline(){return false}',
    'loadFromServer(){}',
    'launchClaude(){}',
    '}',
  ].join('');
  const [degraded, degradedLine, degradedAssessment] = __test.patchHostStateSemanticBridge(degradedSource);
  assert.strictEqual(degraded, degradedSource, 'anchor miss must not mutate the webview bundle');
  assert(/降级/.test(degradedLine), 'anchor miss should degrade instead of aborting apply');
  assert.strictEqual(degradedAssessment.status, 'degraded',
    'business-present anchor miss should be reported as high-priority degraded');

  const wrongSurface = 'class NotSessionState { isOffline(){} }';
  assert.throws(
    () => __test.patchHostStateSemanticBridge(wrongSurface),
    /宿主语义桥 \(semantic-bridge-contract-miss\)/,
    'missing SessionState business fingerprint must still fail closed',
  );
  console.log('patch-contracts: ok host-state bridge variants');
}

// ---- Monaco diff span anchors (2026-06-09) ----
// The Monaco option patches must anchor on the `.createDiffEditor(` business
// seed plus brace matching, and rewrite only their own option inside each
// span. These fixtures lock the drift class that killed the old anchors:
// upstream inserting or reordering neighboring options must not break any
// option patch, and legacy incipit-patched shapes must normalize.
const MONACO_STOCK_INLINE =
  '{readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!1,scrollBeyondLastLine:!1,minimap:{enabled:!1},automaticLayout:!0,theme:"vs-dark",fontSize:12,lineNumbers:"off",lightbulb:{enabled:Q.ShowLightbulbIconMode.Off},wordWrap:"on",wrappingIndent:"same",scrollbar:{vertical:"hidden",horizontal:"hidden",verticalScrollbarSize:0,handleMouseWheel:!1}}';
const MONACO_STOCK_MODAL =
  '{readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!0,scrollBeyondLastLine:!1,minimap:{enabled:!1},automaticLayout:!0,theme:"vs-dark",fontSize:12,lineNumbers:"off",wordWrap:"on",wrappingIndent:"same",scrollbar:{vertical:"auto",horizontal:"auto"}}';
const MONACO_DRIFT_INLINE =
  '{readOnly:!0,renderOverviewRuler:!1,inlayHints:{enabled:"off"},renderSideBySide:!0,theme:"vs-dark",fontSize:12,stickyScroll:{enabled:!1},lineNumbers:"off",wordWrap:"on",lightbulb:{enabled:Q.ShowLightbulbIconMode.Off},wrappingIndent:"same",scrollbar:{vertical:"hidden",horizontal:"hidden",verticalScrollbarSize:0,handleMouseWheel:!1}}';
const MONACO_DRIFT_MODAL =
  '{readOnly:!0,wordWrap:"on",renderSideBySide:!0,renderOverviewRuler:!0,theme:"vs-dark",experimental:{useTrueInlineView:!1},fontSize:12,lineNumbers:"off",wrappingIndent:"same",scrollbar:{vertical:"auto",horizontal:"auto"}}';

function monacoDiffFixture(inlineOpts, modalOpts) {
  return [
    'var Q={ShowLightbulbIconMode:{Off:"off"}};',
    'var ed={createDiffEditor:function(a,b){return{updateOptions:function(){},dispose:function(){}}}};',
    `function mountInline(o,l){var x=ed.createDiffEditor(o.current,${inlineOpts});var C=new ResizeObserver((y)=>{for(let w of y){let E=w.contentRect.width>700;l(!E),x.updateOptions({renderSideBySide:E})}});return x}`,
    `function mountModal(i){var a=ed.createDiffEditor(i.current,${modalOpts});return a}`,
  ].join('\n');
}

function applyMonacoDiffPipeline(content) {
  const lines = [];
  let updated = content;
  for (const fn of [
    __test.patchMonacoDiffTheme,
    __test.patchMonacoDiffFont,
    __test.patchMonacoDiffWordWrap,
    __test.patchMonacoDiffOverview,
    __test.patchMonacoDiffInlineLayout,
    __test.patchMonacoDiffModalLayout,
    __test.patchMonacoDiffModalScrollbar,
  ]) {
    const [next, line] = fn(updated);
    updated = next;
    lines.push(line);
  }
  return [updated, lines];
}

function countLiteral(text, literal) {
  return text.split(literal).length - 1;
}

function assertMonacoDiffSpanPatchVariants() {
  const variants = [
    ['stock 2.1.170 shape', MONACO_STOCK_INLINE, MONACO_STOCK_MODAL],
    ['inserted/reordered options drift', MONACO_DRIFT_INLINE, MONACO_DRIFT_MODAL],
  ];
  for (const [label, inlineOpts, modalOpts] of variants) {
    const source = monacoDiffFixture(inlineOpts, modalOpts);
    const spans = __test.monacoDiffEditorOptionSpans(source);
    assert.strictEqual(spans.length, 2, `${label}: expected two diff editor option spans`);
    const [patched, lines] = applyMonacoDiffPipeline(source);
    assert(lines.every(line => !/降级/.test(line)),
      `${label}: no Monaco patch may degrade: ${lines.join(' | ')}`);
    assert.strictEqual(countLiteral(patched, 'theme:(globalThis.__incipitPickMonacoDiffTheme'), 2,
      `${label}: both spans get the theme expression`);
    assert.strictEqual(countLiteral(patched, 'fontSize:12,fontFamily:"\'Rec Mono Linear\''), 2,
      `${label}: font family inserted after fontSize in both spans`);
    assert.strictEqual(countLiteral(patched, 'lineNumbers:"on",lineDecorationsWidth:0'), 2,
      `${label}: line numbers enabled in both spans`);
    assert.strictEqual(countLiteral(patched, 'lineNumbers:"off"'), 0,
      `${label}: no span keeps lineNumbers off`);
    assert.strictEqual(countLiteral(patched, 'wordWrap:"off"'), 2,
      `${label}: word wrap disabled in both spans`);
    assert.strictEqual(countLiteral(patched, 'renderOverviewRuler:!1'), 2,
      `${label}: overview ruler off in both spans`);
    assert.strictEqual(countLiteral(patched, 'renderOverviewRuler:!0'), 0,
      `${label}: no overview ruler left on`);
    assert.strictEqual(countLiteral(patched, 'renderSideBySide:!1'), 3,
      `${label}: both spans plus the forced resize handler are single-column`);
    assert(patched.includes('l(!0),x.updateOptions({renderSideBySide:!1})'),
      `${label}: inline resize handler forced single-column`);
    assert.strictEqual(countLiteral(patched, 'scrollbar:{vertical:"auto",horizontal:"auto"}'), 1,
      `${label}: modal scrollbar stays auto`);
    assert.doesNotThrow(
      () => new vm.Script(patched, { filename: `monaco-diff-${label}.js` }),
      `${label}: patched fixture must remain valid JavaScript`,
    );
    const [repatched, relines] = applyMonacoDiffPipeline(patched);
    assert.strictEqual(repatched, patched, `${label}: second pass must be idempotent`);
    assert(relines.every(line => /已存在/.test(line)),
      `${label}: second pass should report 已存在: ${relines.join(' | ')}`);
  }

  // Legacy incipit-patched shapes (pre-picker theme expression, font family
  // present but lineNumbers:"on" without decorations width, modal scrollbar
  // forced hidden) must normalize without double-patching.
  const legacyThemeExpr =
    'theme:(globalThis.__incipitConfig&&globalThis.__incipitConfig.theme&&globalThis.__incipitConfig.theme.palette==="warm-white"?"vs":"vs-dark")';
  const legacyInline = MONACO_STOCK_INLINE
    .replace('theme:"vs-dark"', legacyThemeExpr)
    .replace('fontSize:12,', 'fontSize:12,fontFamily:"\'Rec Mono Linear\', Consolas, Monaco, \'Courier New\', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0",')
    .replace('lineNumbers:"off"', 'lineNumbers:"on"');
  const legacyModal = MONACO_STOCK_MODAL
    .replace('scrollbar:{vertical:"auto",horizontal:"auto"}', 'scrollbar:{vertical:"auto",horizontal:"hidden"}');
  const legacySource = monacoDiffFixture(legacyInline, legacyModal);
  const [legacyPatched, legacyLines] = applyMonacoDiffPipeline(legacySource);
  assert(legacyLines.every(line => !/降级/.test(line)),
    `legacy shapes: no Monaco patch may degrade: ${legacyLines.join(' | ')}`);
  assert.strictEqual(countLiteral(legacyPatched, 'theme:(globalThis.__incipitPickMonacoDiffTheme'), 2,
    'legacy theme expression upgraded in both spans');
  assert.strictEqual(countLiteral(legacyPatched, 'lineNumbers:"on",lineDecorationsWidth:0'), 2,
    'legacy lineNumbers gains decorations width');
  assert.strictEqual(countLiteral(legacyPatched, 'fontFamily:"\'Rec Mono Linear\''), 2,
    'legacy font family not duplicated');
  assert.strictEqual(countLiteral(legacyPatched, 'scrollbar:{vertical:"auto",horizontal:"auto"}'), 1,
    'legacy hidden modal scrollbar restored to auto');

  // Anchor miss must degrade without mutating the bundle.
  const noEditors = 'var x = 1;';
  for (const fn of [__test.patchMonacoDiffTheme, __test.patchMonacoDiffModalScrollbar]) {
    const [unchanged, line] = fn(noEditors);
    assert.strictEqual(unchanged, noEditors, 'missing createDiffEditor must not mutate content');
    assert(/降级/.test(line), 'missing createDiffEditor must degrade');
  }
  console.log('patch-contracts: ok monaco diff span anchors');
}

function testFixture(root) {
  const extensionPath = path.join(root, 'extension.js');
  const webviewPath = path.join(root, 'webview', 'index.js');
  const extensionSource = fs.readFileSync(extensionPath, 'utf8');
  const webviewSource = fs.readFileSync(webviewPath, 'utf8');

  const [extensionPatched, extensionLines, extensionContracts] = __test.patchExtensionJs(extensionSource);
  assert.doesNotThrow(
    () => new vm.Script(extensionPatched, { filename: `${root}/extension.js` }),
    `${root}: patched extension.js has invalid JavaScript syntax`,
  );
  assertNoGracefulDegradation(`${root} extension.js`, extensionLines);
  assert(
    extensionPatched.includes('commands.registerCommand("incipit.claudeCode.insertAtMention"') &&
      extensionPatched.includes('commands.registerCommand("incipit.claudeCode.hasVisibleWebview"'),
    `${root}: extension must expose incipit private @ mention command bridge on known official hosts`,
  );
  extensionContracts.unshift(__test.buildHostRouteContract(
    { version: versionFromFixtureRoot(root) },
    extensionSource,
    webviewSource,
  ));
  const [, extensionHeadLine] = __test.patchExtensionHtmlHead(extensionPatched, DEFAULT_THEME);
  extensionContracts.push(makePatchContract({
    name: 'install.extensionHtmlHead',
    line: extensionHeadLine,
    detail: { palette: DEFAULT_THEME.palette },
  }));
  extensionContracts.push(__test.buildWorkbenchOverlayInstallContract(
    { status: 'off', enabled: false },
    false,
  ));
  const [extensionPatchedAgain] = __test.patchExtensionJs(extensionPatched);
  assert.strictEqual(extensionPatchedAgain, extensionPatched, `${root}: extension patch is not idempotent`);

  const [webviewPatched, webviewLines, webviewContracts] = __test.patchWebviewIndex(
    webviewSource,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    extensionContracts,
  );
  assert.doesNotThrow(
    () => new vm.Script(webviewPatched, { filename: `${root}/webview/index.js` }),
    `${root}: patched webview/index.js has invalid JavaScript syntax`,
  );
  assertNoGracefulDegradation(`${root} webview/index.js`, webviewLines);
  assertWebviewSemanticShape(root, webviewPatched, webviewLines);
  assertInstallManifestShape(root, webviewPatched, webviewContracts);

  const [webviewPatchedAgain, webviewLinesAgain, webviewContractsAgain] = __test.patchWebviewIndex(
    webviewPatched,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    extensionContracts,
  );
  assert.doesNotThrow(
    () => new vm.Script(webviewPatchedAgain, { filename: `${root}/webview/index.js second pass` }),
    `${root}: patched webview/index.js second pass has invalid JavaScript syntax`,
  );
  assert.strictEqual(webviewPatchedAgain, webviewPatched, `${root}: webview patch is not idempotent`);
  assertNoGracefulDegradation(`${root} webview/index.js second pass`, webviewLinesAgain);
  assertWebviewSemanticShape(root, webviewPatchedAgain, webviewLinesAgain);
  assertInstallManifestShape(root, webviewPatchedAgain, webviewContractsAgain);
}

function assertLowRiskVisualPatchDegrades(root) {
  const webviewPath = path.join(root, 'webview', 'index.js');
  const webviewSource = fs.readFileSync(webviewPath, 'utf8');
  const mutated = webviewSource.replace('theme:"vs-dark"', 'theme:"__incipit_anchor_miss"');
  assert.notStrictEqual(mutated, webviewSource, `${root}: test fixture must contain a diff theme anchor`);
  const [, webviewLines] = __test.patchWebviewIndex(
    mutated,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    [],
  );
  assert(
    webviewLines.some(line => /diff 主题/.test(line) && /降级/.test(line)),
    `${root}: low-risk diff visual patch should degrade instead of aborting apply`,
  );
}

function assertMarkdownPreprocessPatchDegrades(root) {
  const webviewPath = path.join(root, 'webview', 'index.js');
  const webviewSource = fs.readFileSync(webviewPath, 'utf8');
  const mutated = webviewSource.replace('expected `string`', 'expected `children-string`');
  assert.notStrictEqual(mutated, webviewSource, `${root}: test fixture must contain markdown handoff error text`);
  const [, webviewLines] = __test.patchWebviewIndex(
    mutated,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    [],
  );
  assert(
    webviewLines.some(line => /markdown 预处理/.test(line) && /降级/.test(line)),
    `${root}: markdown preprocess patch should degrade instead of aborting apply`,
  );
}

function assertImplicitSelectionUpstreamSafe(root) {
  const webviewPath = path.join(root, 'webview', 'index.js');
  const webviewSource = fs.readFileSync(webviewPath, 'utf8');
  const mutated = webviewSource.replace(
    /if\([A-Za-z_$][\w$]*&&![A-Za-z_$][\w$]*\(this\.lastSentSelection,this\.selection\.value\)\)[A-Za-z_$][\w$]*=this\.selection\.value,this\.lastSentSelection=[A-Za-z_$][\w$]*;/,
    'if(!1);',
  );
  assert.notStrictEqual(mutated, webviewSource, `${root}: test fixture must contain implicit selection send branch`);
  const [, webviewLines] = __test.patchWebviewIndex(
    mutated,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    [],
  );
  assert(
    webviewLines.some(line => /自动选区发送/.test(line) && /上游已禁用/.test(line)),
    `${root}: missing selection branch should be accepted only when SessionState.send no longer reads this.selection.value`,
  );
}

function assertImplicitSelectionCompareDriftStillPatches(root) {
  const webviewPath = path.join(root, 'webview', 'index.js');
  const webviewSource = fs.readFileSync(webviewPath, 'utf8');
  const mutated = webviewSource.replace(
    /if\(([A-Za-z_$][\w$]*)&&![A-Za-z_$][\w$]*\(this\.lastSentSelection,this\.selection\.value\)\)([A-Za-z_$][\w$]*)=this\.selection\.value,this\.lastSentSelection=\2;/,
    'if($1&&__incipitRenamedSelectionCompare(this.lastSentSelection,this.selection.value)===false)$2=this.selection.value,this.lastSentSelection=$2;',
  );
  assert.notStrictEqual(mutated, webviewSource, `${root}: test fixture must contain implicit selection compare branch`);
  const [patched, webviewLines] = __test.patchWebviewIndex(
    mutated,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    [],
  );
  assert(
    webviewLines.some(line => /自动选区发送/.test(line) && /已写入/.test(line)),
    `${root}: compare-helper drift should still patch the SessionState.send selection branch`,
  );
  assert.strictEqual(
    __test.assessImplicitSelectionSendContact(patched).status,
    'patched',
    `${root}: compare-helper drift patch must satisfy the implicit selection contract`,
  );
}

function assertImplicitSelectionShapeDriftFailsClosed(root) {
  const webviewPath = path.join(root, 'webview', 'index.js');
  const webviewSource = fs.readFileSync(webviewPath, 'utf8');
  const mutated = webviewSource.replaceAll('this.selection.value', 'this.selection?.value');
  assert.notStrictEqual(mutated, webviewSource, `${root}: test fixture must contain this.selection.value reads`);
  assert.throws(
    () => __test.patchWebviewIndex(
      mutated,
      DEFAULT_FEATURES,
      DEFAULT_THEME,
      'en',
      [],
    ),
    /自动选区发送/,
    `${root}: reshaped selection reads must fail closed instead of being treated as upstream-disabled`,
  );
}

function assertCspDirectiveTokenOrderDriftStillPatches(root) {
  const extensionPath = path.join(root, 'extension.js');
  const extensionSource = fs.readFileSync(extensionPath, 'utf8');
  const mutated = extensionSource
    .replace(/style-src (\$\{[^}]+\}) 'unsafe-inline'/, "style-src 'unsafe-inline' $1")
    .replace(/font-src (\$\{[^}]+\})/, 'font-src data: $1');
  assert.notStrictEqual(mutated, extensionSource, `${root}: test fixture must contain dynamic CSP directives`);
  const [patched, lines] = __test.patchExtensionJs(mutated);
  assertNoGracefulDegradation(`${root} extension.js CSP token drift`, lines);
  assert(
    /style-src 'unsafe-inline' \$\{[^}]+\} https:\/\/cdnjs\.cloudflare\.com/.test(patched) &&
      /font-src data: \$\{[^}]+\} https:\/\/cdnjs\.cloudflare\.com/.test(patched),
    `${root}: CSP patch must add required tokens without depending on original token order`,
  );
}

function assertBadgeCommIgnoresUnrelatedWebviewAssignments(root) {
  const extensionPath = path.join(root, 'extension.js');
  const extensionSource = fs.readFileSync(extensionPath, 'utf8');
  const mutated = 'function __incipitFakeWebviewCarrier(){this.webview=__fake;}\n' + extensionSource;
  const [patched, lines] = __test.patchExtensionJs(mutated);
  assertNoGracefulDegradation(`${root} extension.js unrelated webview assignment`, lines);
  assert(
    !patched.includes('this.webview=__fake;require("./webview/host-badge.cjs").attachComm(this);') &&
      (patched.match(/require\("\.\/webview\/host-badge\.cjs"\)\.attachComm\(this\);/g) || []).length === 1,
    `${root}: badge comm attach must target the semantic comm object, not every webview assignment`,
  );
}

function assertPrivateMessageGuardIgnoresLogText(root) {
  const extensionPath = path.join(root, 'extension.js');
  const extensionSource = fs.readFileSync(extensionPath, 'utf8');
  const mutated = extensionSource.replaceAll('Received message from webview:', 'Received host message:');
  assert.notStrictEqual(mutated, extensionSource, `${root}: test fixture must contain host message logging text`);
  const [patched, lines] = __test.patchExtensionJs(mutated);
  assert(
    lines.some(line => /私有消息过滤/.test(line) && /已写入/.test(line)),
    `${root}: private message guard should not depend on exact host log text`,
  );
  assert(
    /\.webview\.onDidReceiveMessage\(\(([A-Za-z_$][\w$]*)\)=>\{if\(\1&&\1\.__incipit===true\)return;[\s\S]{0,500}?[A-Za-z_$][\w$]*\?\.fromClient\(\1\)/.test(patched),
    `${root}: private incipit messages must be guarded before host fromClient dispatch`,
  );
}

function assertAtMentionBridgePatchDegrades(root) {
  const extensionPath = path.join(root, 'extension.js');
  const extensionSource = fs.readFileSync(extensionPath, 'utf8');
  const mutated = extensionSource.replaceAll('claude-vscode.insertAtMention', 'claude-vscode.insertAtMentionRenamed');
  assert.notStrictEqual(mutated, extensionSource, `${root}: test fixture must contain official insertAtMention command`);
  const [, lines] = __test.patchExtensionJs(mutated);
  assert(
    lines.some(line => /@引用命令桥/.test(line) && /降级/.test(line)),
    `${root}: incipit @ mention command bridge should degrade instead of aborting apply`,
  );
}

assertRuntimeSourceContracts();
assertHostStateBridgePatchVariants();
assertMonacoDiffSpanPatchVariants();

const fixtures = collectFixtureRoots();
if (!fixtures.length) {
  console.log('patch-contracts: skipped (no Claude Code official restore fixture found)');
  process.exit(0);
}

assertLowRiskVisualPatchDegrades(fixtures[fixtures.length - 1]);
assertMarkdownPreprocessPatchDegrades(fixtures[fixtures.length - 1]);
assertImplicitSelectionUpstreamSafe(fixtures[fixtures.length - 1]);
assertImplicitSelectionCompareDriftStillPatches(fixtures[fixtures.length - 1]);
assertImplicitSelectionShapeDriftFailsClosed(fixtures[fixtures.length - 1]);
assertCspDirectiveTokenOrderDriftStillPatches(fixtures[fixtures.length - 1]);
assertBadgeCommIgnoresUnrelatedWebviewAssignments(fixtures[fixtures.length - 1]);
assertPrivateMessageGuardIgnoresLogText(fixtures[fixtures.length - 1]);
assertAtMentionBridgePatchDegrades(fixtures[fixtures.length - 1]);

for (const fixture of fixtures) {
  testFixture(fixture);
  console.log(`patch-contracts: ok ${fixture}`);
}
