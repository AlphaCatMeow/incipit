'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CLAUDE_CODE_EXTENSION_PREFIX = 'anthropic.claude-code-';
const WORKBENCH_RESTORE_ROOT = path.join(
  os.homedir(),
  '.incipit',
  'workbench-restore-points-v1',
);
const OVERLAY_SENTINEL_ROOT = path.join(
  os.homedir(),
  '.incipit',
  'editor-selection-overlay-v1',
);
const HOST_IDENTITY_ROOT = path.join(
  os.homedir(),
  '.incipit',
  'editor-hosts-v1',
);
const WORKBENCH_MAIN_REL = path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js');
const PATCH_START = '/* incipit editor selection overlay start */';
const PATCH_END = '/* incipit editor selection overlay end */';
const COMMAND_BRIDGE_NAME = '__INCIPIT_EDITOR_SELECTION_OVERLAY_COMMAND__';
const COMMAND_BRIDGE_RE = /;globalThis\.__INCIPIT_EDITOR_SELECTION_OVERLAY_COMMAND__=\(__incipitCommand,\.\.\.__incipitArgs\)=>this\.executeCommand\(__incipitCommand,\.\.\.__incipitArgs\)/g;
const COMMAND_BRIDGE_ANCHOR_RE =
  /this\._extensionService\.whenInstalledExtensionsRegistered\(\)\.then\([A-Za-z_$][\w$]*=>this\._extensionHostIsReady=[A-Za-z_$][\w$]*\),this\._starActivation=null/g;
const OVERLAY_BLOCK_RE =
  /\r?\n?\/\* incipit editor selection overlay start \*\/[\s\S]*?\/\* incipit editor selection overlay end \*\/\r?\n?/g;
const DEFAULT_OVERLAY_BODY_FONT =
  "'Reading', 'IBM Plex Serif', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, serif";

function sanitizeCssFontFamilyValue(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[;{}`\r\n]/.test(trimmed)) return null;
  return trimmed.replace(/\$\{/g, '');
}

function overlayVisualTheme(theme = {}) {
  const warmWhite = theme && theme.palette === 'warm-white';
  const inkBlack = theme && theme.palette === 'ink-black';
  const rawBody = theme.bodyFontFamily && theme.bodyFontFamily.css;
  let bodyFont = sanitizeCssFontFamilyValue(rawBody) || DEFAULT_OVERLAY_BODY_FONT;
  if (warmWhite && theme.bodyBold === true) {
    bodyFont = `'PaperReading', ${bodyFont}`;
  }
  if (warmWhite) {
    return {
      background: '#ffffff',
      foreground: '#0d0d0d',
      hoverBackground: '#f8f8f6',
      hoverForeground: '#0d0d0d',
      shadow: '0 3px 10px rgba(0, 0, 0, 0.16)',
      fontFamily: bodyFont,
    };
  }
  if (inkBlack) {
    return {
      background: '#1a1b1c',
      foreground: '#fbfbfc',
      hoverBackground: '#212121',
      hoverForeground: '#fbfbfc',
      shadow: '0 2px 8px rgba(0, 0, 0, 0.22)',
      fontFamily: bodyFont,
    };
  }
  return {
    background: '#2c2c2a',
    foreground: '#f8f8f6',
    hoverBackground: '#333330',
    hoverForeground: '#f8f8f6',
    shadow: '0 2px 8px rgba(0, 0, 0, 0.22)',
    fontFamily: bodyFont,
  };
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

function canonicalPath(input) {
  if (!input) return '';
  const resolved = path.resolve(input);
  let real = resolved;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (_) {}
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function hostKeyForAppRoot(appRoot) {
  return crypto.createHash('sha256').update(canonicalPath(appRoot)).digest('hex').slice(0, 20);
}

function sentinelPathForHostKey(hostKey) {
  return path.join(OVERLAY_SENTINEL_ROOT, `${hostKey}.json`);
}

function writeSentinel(target) {
  fs.mkdirSync(OVERLAY_SENTINEL_ROOT, { recursive: true });
  atomicWrite(
    sentinelPathForHostKey(target.hostKey),
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      active: true,
      hostKey: target.hostKey,
      appRoot: target.appRoot,
      workbenchPath: target.workbenchPath,
      product: target.product,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8'),
  );
}

function removeSentinel(target) {
  if (!target || !target.hostKey) return;
  try { fs.unlinkSync(sentinelPathForHostKey(target.hostKey)); } catch (_) {}
}

function atomicWrite(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (exc) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw exc;
  }
}

function extensionRootForTarget(target) {
  const extensionDir = target && target.extensionDir;
  if (!extensionDir) return '';
  const base = path.basename(extensionDir).toLowerCase();
  if (
    base.startsWith(CLAUDE_CODE_EXTENSION_PREFIX) &&
    path.basename(path.dirname(extensionDir)).toLowerCase() === 'extensions'
  ) {
    return path.dirname(extensionDir);
  }
  return extensionDir;
}

// Gate for the *no-companion fallback scan* only (env + companion
// host-identity are tried first and bypass this). It admits targets whose
// Workbench is the upstream VS Code build shape:
//   - Stable    `~/.vscode/extensions`            product "Code"
//   - Insiders  `~/.vscode-insiders/extensions`   product "Code - Insiders"
//   - VSCodium / Code - OSS  `~/.vscode-oss/extensions`  (same-source OSS
//     rebuilds — NOT reshaped forks; their command-service shape matches
//     the official minified anchor)
// Reshaped forks (Cursor / Windsurf / Antigravity / Kiro) are not admitted
// here: empirically their workbench does not contain incipit's command
// bridge anchor (verified 0 matches on Kiro 0.12 + Antigravity 1.107), so
// the patch would fail anyway. This is NOT a prohibition — if a companion
// pins such a host the overlay still *attempts* and safely degrades; the
// real protection is the anchor verification + the degrade safety net, not
// this gate. resolveWorkbenchTarget's uniqueness/degrade contract is
// unchanged: ambiguous or unfound Workbench still degrades.
function isOfficialVSCodeTarget(target) {
  const extensionDir = canonicalPath(extensionRootForTarget(target));
  const settingsPath = canonicalPath(target && target.settingsPath);
  if (/(?:^|[\\/])\.vscode[\\/]extensions$/.test(extensionDir)) return true;
  if (/(?:^|[\\/])\.vscode-insiders[\\/]extensions$/.test(extensionDir)) return true;
  if (/(?:^|[\\/])\.vscode-oss[\\/]extensions$/.test(extensionDir)) return true;
  return (
    /(?:^|[\\/])(?:code(?: - insiders)?|vscodium|code - oss)[\\/]extensions$/.test(extensionDir) &&
    /(?:^|[\\/])(?:code(?: - insiders)?|vscodium|code - oss)[\\/]user[\\/]settings\.json$/.test(settingsPath)
  );
}

function safeReadJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

function readProductInfo(appRoot) {
  const pkg = safeReadJson(path.join(appRoot, 'package.json')) || {};
  const product = safeReadJson(path.join(appRoot, 'product.json')) || {};
  return {
    name: product.nameLong || product.nameShort || pkg.name || 'VS Code',
    applicationName: product.applicationName || pkg.name || 'code',
    version: pkg.version || product.version || 'unknown',
  };
}

function workbenchPathForAppRoot(appRoot) {
  return path.join(appRoot, WORKBENCH_MAIN_REL);
}

function appRootLooksLikeWorkbench(appRoot) {
  const workbenchPath = workbenchPathForAppRoot(appRoot);
  if (!fs.existsSync(workbenchPath)) return false;
  return !!(safeReadJson(path.join(appRoot, 'package.json')) || safeReadJson(path.join(appRoot, 'product.json')));
}

function appRootLooksSupported(appRoot) {
  if (!appRootLooksLikeWorkbench(appRoot)) return false;
  const product = readProductInfo(appRoot);
  const app = String(product.applicationName || '').toLowerCase();
  const name = String(product.name || '');
  return (
    app === 'code' || app === 'code-insiders' || app === 'codium' || app === 'code-oss' ||
    name === 'Visual Studio Code' || name === 'Visual Studio Code - Insiders' ||
    name === 'Code' || name === 'Code - Insiders' ||
    name === 'VSCodium' || name === 'Code - OSS'
  );
}

function addAppRootCandidate(out, appRoot, options = {}) {
  const allowAnyWorkbench = options.allowAnyWorkbench === true;
  if (!appRoot) return;
  const accepted = allowAnyWorkbench ? appRootLooksLikeWorkbench(appRoot) : appRootLooksSupported(appRoot);
  if (!accepted) return;
  const key = canonicalPath(appRoot);
  if (!out.some(item => item.key === key)) out.push({ key, appRoot: path.resolve(appRoot) });
}

function resolvedWorkbenchTargetFromAppRoot(appRoot) {
  const product = readProductInfo(appRoot);
  return {
    ok: true,
    appRoot,
    workbenchPath: workbenchPathForAppRoot(appRoot),
    product,
    hostKey: hostKeyForAppRoot(appRoot),
  };
}

function portableAppRootForTarget(target) {
  const extensionsDir = extensionRootForTarget(target);
  if (!extensionsDir || path.basename(extensionsDir) !== 'extensions') return null;
  const dataDir = path.dirname(extensionsDir);
  if (!fs.existsSync(path.join(dataDir, 'user-data'))) return null;
  const appRoot = path.join(path.dirname(dataDir), 'resources', 'app');
  return appRootLooksLikeWorkbench(appRoot) ? path.resolve(appRoot) : null;
}

function addInstallRootCandidates(out, installRoot) {
  if (!installRoot) return;
  addAppRootCandidate(out, path.join(installRoot, 'resources', 'app'));
  let entries = [];
  try { entries = fs.readdirSync(installRoot, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    addAppRootCandidate(out, path.join(installRoot, entry.name, 'resources', 'app'));
  }
}

function pathEntries() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .map(item => item && item.trim())
    .filter(Boolean);
}

function normalizeCliScriptReference(raw, scriptDir) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (process.platform === 'win32') {
    value = value.replace(/^%~dp0/i, scriptDir + path.sep);
  }
  if (!path.isAbsolute(value)) {
    value = path.resolve(scriptDir, value);
  }
  return path.normalize(value);
}

function appRootFromCliReference(raw, scriptDir) {
  const value = normalizeCliScriptReference(raw, scriptDir);
  if (!value) return null;
  const normalized = value.replace(/[\\/]+/g, '/');
  const match = normalized.match(/^(.*\/resources\/app)(?:\/out\/cli\.js)?$/i);
  if (!match) return null;
  return path.normalize(match[1]);
}

function addCliScriptCandidates(out, scriptPath) {
  if (!scriptPath || !fs.existsSync(scriptPath)) return;
  let stat;
  try { stat = fs.statSync(scriptPath); } catch (_) { return; }
  if (!stat.isFile()) return;

  let text = '';
  try { text = fs.readFileSync(scriptPath, 'utf8'); } catch (_) { return; }
  const scriptDir = path.dirname(scriptPath);
  const refs = new Set();
  const patterns = [
    /["']([^"'\r\n]*resources[\\/]+app[\\/]+out[\\/]+cli\.js)["']/ig,
    /(["']?)([^"'\r\n]*resources[\\/]+app)\1/ig,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      refs.add(match[2] || match[1]);
    }
  }
  for (const ref of refs) {
    addAppRootCandidate(out, appRootFromCliReference(ref, scriptDir));
  }
}

// Both official channels ship a CLI shim with the same basename pattern:
// Stable => code(.cmd) / Code.exe, Insiders => code-insiders(.cmd) /
// "Code - Insiders.exe". Each shim still resolves to its own
// `resources/app`, so probing both keeps per-target precision.
const VSCODE_CLI_BASENAMES = ['code', 'code-insiders'];
const VSCODE_EXE_BASENAMES = ['code.exe', 'Code.exe', 'code-insiders.exe', 'Code - Insiders.exe'];

function addPathBasedCandidates(out) {
  if (process.platform !== 'win32') return;
  for (const entry of pathEntries()) {
    const base = path.basename(entry).toLowerCase();
    for (const cli of VSCODE_CLI_BASENAMES) {
      addCliScriptCandidates(out, path.join(entry, `${cli}.cmd`));
      addCliScriptCandidates(out, path.join(entry, cli));
    }
    const hasCliShim = VSCODE_CLI_BASENAMES.some(cli =>
      fs.existsSync(path.join(entry, `${cli}.cmd`)) ||
      fs.existsSync(path.join(entry, `${cli}.exe`)) ||
      fs.existsSync(path.join(entry, cli)),
    );
    const hasExe = VSCODE_EXE_BASENAMES.some(exe => fs.existsSync(path.join(entry, exe)));
    if (base === 'bin' && hasCliShim) {
      addInstallRootCandidates(out, path.dirname(entry));
    } else if (hasExe) {
      addInstallRootCandidates(out, entry);
    }
  }
}

function addPlatformCandidates(out) {
  // Probe both official channels' default install roots. If a user has BOTH
  // Stable and Insiders installed and no companion-written host identity /
  // env hint pins the exact one, resolveWorkbenchTarget sees >1 candidate
  // and degrades (ambiguous) rather than guessing — the safe, intended path.
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    for (const dir of ['Microsoft VS Code', 'Microsoft VS Code Insiders', 'VSCodium']) {
      addInstallRootCandidates(out, local && path.join(local, 'Programs', dir));
      addInstallRootCandidates(out, programFiles && path.join(programFiles, dir));
      addInstallRootCandidates(out, programFilesX86 && path.join(programFilesX86, dir));
    }
    return;
  }
  if (process.platform === 'darwin') {
    // Probe both the system /Applications and the user-local ~/Applications
    // (drag-install / Homebrew Cask --appdir). The companion host-identity
    // path is install-method-agnostic; this is only the no-companion last
    // resort.
    const appNames = [
      'Visual Studio Code.app',
      'Visual Studio Code - Insiders.app',
      'VSCodium.app',
    ];
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const appName of appNames) {
        addAppRootCandidate(out, path.join(base, appName, 'Contents', 'Resources', 'app'));
      }
    }
    return;
  }
  for (const id of ['code', 'code-insiders', 'codium', 'code-oss']) {
    addAppRootCandidate(out, `/usr/share/${id}/resources/app`);
    addAppRootCandidate(out, `/usr/lib/${id}/resources/app`);
    addAppRootCandidate(out, `/snap/${id}/current/usr/share/${id}/resources/app`);
  }
}

function addEnvironmentCandidates(out) {
  addAppRootCandidate(out, process.env.INCIPIT_WORKBENCH_APP_ROOT, { allowAnyWorkbench: true });
}

function readHostIdentities() {
  if (!fs.existsSync(HOST_IDENTITY_ROOT)) return [];
  let entries = [];
  try { entries = fs.readdirSync(HOST_IDENTITY_ROOT, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const data = safeReadJson(path.join(HOST_IDENTITY_ROOT, entry.name));
    if (data) out.push(data);
  }
  return out;
}

function addHostIdentityCandidates(out, target) {
  const targetExtensionDir = canonicalPath(target && target.extensionDir);
  const targetExtensionRoot = canonicalPath(extensionRootForTarget(target));
  if (!targetExtensionDir || !targetExtensionRoot) return;
  for (const identity of readHostIdentities()) {
    const claudeExtensionPath = canonicalPath(identity && identity.claudeExtensionPath);
    if (!claudeExtensionPath) continue;
    const claudeExtensionRoot = canonicalPath(extensionRootForTarget({ extensionDir: claudeExtensionPath }));
    if (claudeExtensionPath !== targetExtensionDir && claudeExtensionRoot !== targetExtensionRoot) continue;
    addAppRootCandidate(out, identity.appRoot, { allowAnyWorkbench: true });
  }
}

function addRestorePointCandidates(out) {
  for (const manifestFile of collectWorkbenchManifestPaths()) {
    const manifest = safeReadJson(manifestFile);
    const resolved = resolvedWorkbenchTargetFromManifest(manifest);
    if (!resolved || !resolved.appRoot) continue;
    addAppRootCandidate(out, resolved.appRoot);
  }
}

function unsupportedResult(reason, candidates = []) {
  return {
    ok: false,
    status: 'unsupported',
    reason,
    candidates: candidates.map(item => item.appRoot || item).filter(Boolean),
  };
}

function resolveWorkbenchTarget(target) {
  const exactCandidates = [];
  addEnvironmentCandidates(exactCandidates);
  addHostIdentityCandidates(exactCandidates, target);
  if (exactCandidates.length === 1) {
    return resolvedWorkbenchTargetFromAppRoot(exactCandidates[0].appRoot);
  }
  if (exactCandidates.length > 1) {
    return unsupportedResult('ambiguous-workbench', exactCandidates);
  }

  const portableAppRoot = portableAppRootForTarget(target);
  if (portableAppRoot) {
    return resolvedWorkbenchTargetFromAppRoot(portableAppRoot);
  }
  if (!isOfficialVSCodeTarget(target)) {
    return unsupportedResult('only-official-vscode');
  }
  const candidates = [];
  addEnvironmentCandidates(candidates);
  addHostIdentityCandidates(candidates, target);
  addPathBasedCandidates(candidates);
  addPlatformCandidates(candidates);
  addRestorePointCandidates(candidates);
  if (candidates.length === 0) {
    return unsupportedResult('workbench-not-found');
  }
  if (candidates.length > 1) {
    return unsupportedResult('ambiguous-workbench', candidates);
  }
  const appRoot = candidates[0].appRoot;
  return resolvedWorkbenchTargetFromAppRoot(appRoot);
}

function overlayResolutionFailureMessage(resolved) {
  const reason = resolved && resolved.reason ? resolved.reason : 'unknown';
  const reasonText = {
    'only-official-vscode': '当前 Claude Code 目标不是官方 VS Code Stable/Insiders，无法安全确认编辑器程序文件',
    'workbench-not-found': '没有找到 VS Code Stable/Insiders 的 Workbench 程序文件',
    'ambiguous-workbench': '找到了多个可能的 Workbench 程序文件，无法安全唯一选择',
  }[reason] || reason;
  const candidates = Array.isArray(resolved && resolved.candidates) && resolved.candidates.length
    ? ` 候选: ${resolved.candidates.join(' | ')}`
    : '';
  return `编辑器浮层无法被安全应用：${reasonText}。${candidates}`;
}

// Preflight runs before any files are written. The editor overlay is an
// opt-in experimental feature that patches the editor's Workbench; if it is
// enabled but the Workbench cannot be uniquely + safely confirmed we DO NOT
// abort the whole apply (that punished the user's entire setup for one
// experimental extra). Instead we report a `degraded` result: the caller
// applies everything else, skips ONLY the overlay, and surfaces a mandatory
// red notice. This supersedes the original 2026-05-12 "fail closed the whole
// apply" rule while preserving its intent — the degrade is loud and explicit,
// never a silent behavior swap, and the user's saved config is left intact.
function preflightWorkbenchOverlayForTarget(claudeTarget, enabled) {
  if (!enabled) return { status: 'off', enabled: false };
  const resolved = resolveWorkbenchTarget(claudeTarget);
  if (!resolved.ok) {
    return {
      status: 'degraded',
      enabled: false,
      requested: true,
      reason: resolved.reason || 'unknown',
      candidates: Array.isArray(resolved.candidates) ? resolved.candidates : [],
      message: overlayResolutionFailureMessage(resolved),
    };
  }
  return resolved;
}

function restorePointDir(target) {
  const version = String(target.product && target.product.version || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.join(WORKBENCH_RESTORE_ROOT, target.hostKey, version);
}

function manifestPath(target) {
  return path.join(restorePointDir(target), 'manifest.json');
}

function backupFilePath(target) {
  return path.join(restorePointDir(target), 'workbench.desktop.main.js');
}

function readRestorePoint(target) {
  const manifest = safeReadJson(manifestPath(target));
  if (!manifest || manifest.schemaVersion !== 1) return null;
  if (canonicalPath(manifest.workbenchPath) !== canonicalPath(target.workbenchPath)) return null;
  if (manifest.hostKey !== target.hostKey) return null;
  const backupPath = manifest.backupPath || backupFilePath(target);
  if (!fs.existsSync(backupPath)) return null;
  return { manifest, backupPath, restorePointDir: restorePointDir(target) };
}

function writeRestorePoint(target, originalBytes, source) {
  const dir = restorePointDir(target);
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = backupFilePath(target);
  atomicWrite(backupPath, originalBytes);
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source,
    hostKey: target.hostKey,
    appRoot: target.appRoot,
    workbenchPath: target.workbenchPath,
    product: target.product,
    originalSha256: sha256Bytes(originalBytes),
    originalSize: originalBytes.length,
    backupPath,
  };
  atomicWrite(manifestPath(target), Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
  return { manifest, backupPath, restorePointDir: dir, status: 'created' };
}

function hasWorkbenchPatch(content) {
  return content.includes(PATCH_START) || content.includes(COMMAND_BRIDGE_NAME);
}

function stripWorkbenchPatch(content) {
  return content
    .replace(OVERLAY_BLOCK_RE, '\n')
    .replace(COMMAND_BRIDGE_RE, '');
}

function patchCommandBridge(content) {
  if (content.includes(COMMAND_BRIDGE_NAME)) return [content, false];
  const matches = content.match(COMMAND_BRIDGE_ANCHOR_RE) || [];
  if (matches.length !== 1) {
    throw new Error('VS Code Workbench command service shape changed; editor overlay bridge was not patched.');
  }
  return [
    content.replace(
      COMMAND_BRIDGE_ANCHOR_RE,
      `$&;globalThis.${COMMAND_BRIDGE_NAME}=(__incipitCommand,...__incipitArgs)=>this.executeCommand(__incipitCommand,...__incipitArgs)`,
    ),
    true,
  ];
}

function buildOverlayBlock(theme) {
  const visual = overlayVisualTheme(theme);
  return `
${PATCH_START}
;(() => {
  try {
    if (globalThis.__incipitEditorSelectionOverlayInstalled) return;
    if (typeof document !== 'object' || typeof window !== 'object') return;
    globalThis.__incipitEditorSelectionOverlayInstalled = true;

    const COMMAND_SELECTION = 'incipitClaudeReference.referenceActiveSelection';
    const COMMAND_FILE = 'incipitClaudeReference.referenceActiveFile';
    const COMMAND_CLAUDE_VISIBLE = 'incipit.claudeCode.hasVisibleWebview';
    const ROOT_ID = 'incipit-editor-selection-overlay';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const MIN_RECT = 3;
    const CLAUDE_VISIBILITY_TTL = 500;
    let root = null;
    let scheduled = false;
    let visible = false;
    let primaryButtonSelecting = false;
    let claudeVisible = false;
    let claudeVisibilityCheckedAt = 0;
    let claudeVisibilityPending = false;

    function logFailure(error) {
      try { console.warn('[incipit] editor overlay disabled', error); } catch (_) {}
    }

    function safe(fn) {
      try { return fn(); } catch (error) { logFailure(error); return undefined; }
    }

    function ready(fn) {
      const run = () => safe(fn);
      if (document.body) setTimeout(run, 0);
      else window.addEventListener('DOMContentLoaded', run, { once: true });
    }

    function ensureRoot() {
      if (root && root.isConnected) return root;
      const style = document.createElement('style');
      style.id = ROOT_ID + '-style';
      style.textContent = \`
      #\${ROOT_ID} {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2600;
        pointer-events: none;
        opacity: 0;
        transform: translate3d(-9999px, -9999px, 0);
        transition: opacity 80ms ease-out;
        contain: layout style paint;
      }
      #\${ROOT_ID}[data-visible="true"] { opacity: 1; }
      #\${ROOT_ID} .incipit-overlay-frame {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0;
        border: 0;
        background: transparent;
      }
      #\${ROOT_ID} button {
        pointer-events: auto;
        height: 26px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 0 8px;
        border: 0;
        border-radius: 6px;
        background: ${visual.background};
        color: ${visual.foreground};
        box-shadow: ${visual.shadow};
        font-family: ${visual.fontFamily};
        font-size: 12px;
        font-weight: 400;
        line-height: 1;
        letter-spacing: 0;
        white-space: nowrap;
        cursor: pointer;
      }
      #\${ROOT_ID} button:hover {
        background: ${visual.hoverBackground};
        color: ${visual.hoverForeground};
      }
      #\${ROOT_ID} button:active { transform: translateY(1px); }
      #\${ROOT_ID} svg {
        width: 13px;
        height: 13px;
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.25;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    \`;
      if (!document.getElementById(style.id)) {
        const styleHost = document.head || document.documentElement || document.body;
        styleHost.appendChild(style);
      }
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.setAttribute('aria-hidden', 'true');
      const frame = document.createElement('div');
      frame.className = 'incipit-overlay-frame';
      frame.appendChild(createButton(
        COMMAND_SELECTION,
        'Reference selection',
        'Selection',
        ['M8 1.8 14.2 8 8 14.2 1.8 8Z', 'M5.5 8h5'],
      ));
      frame.appendChild(createButton(
        COMMAND_FILE,
        'Reference file',
        'File',
        ['M4.2 2.2h5.2l2.4 2.4v9.2H4.2Z', 'M9.4 2.2v2.4h2.4', 'M6.2 8h3.6M6.2 10.5h3.6'],
      ));
      root.appendChild(frame);
      root.addEventListener('mousedown', stopEditorBlur, true);
      root.addEventListener('pointerdown', stopEditorBlur, true);
      root.addEventListener('click', event => {
        const button = event.target && event.target.closest && event.target.closest('button[data-command]');
        if (!button) return;
        stopEditorBlur(event);
        executeWorkbenchCommand(button.getAttribute('data-command'));
      }, true);
      document.body.appendChild(root);
      return root;
    }

    function createButton(command, title, label, paths) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-command', command);
      button.title = title;
      button.appendChild(createIcon(paths));
      const span = document.createElement('span');
      span.textContent = label;
      button.appendChild(span);
      return button;
    }

    function createIcon(paths) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      for (const d of paths) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      }
      return svg;
    }

    function stopEditorBlur(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    function executeWorkbenchCommand(command) {
      const bridge = globalThis.${COMMAND_BRIDGE_NAME};
      if (typeof bridge !== 'function') return;
      try {
        Promise.resolve(bridge(command)).catch(error => console.warn('[incipit] editor overlay command failed', error));
      } catch (error) {
        console.warn('[incipit] editor overlay command failed', error);
      }
    }

    function refreshClaudeVisibility(force) {
      const bridge = globalThis.${COMMAND_BRIDGE_NAME};
      const now = Date.now();
      if (typeof bridge !== 'function') {
        claudeVisible = false;
        claudeVisibilityCheckedAt = now;
        return;
      }
      if (claudeVisibilityPending) return;
      if (!force && now - claudeVisibilityCheckedAt < CLAUDE_VISIBILITY_TTL) return;
      claudeVisibilityPending = true;
      Promise.resolve(bridge(COMMAND_CLAUDE_VISIBLE))
        .then(value => {
          claudeVisible = value === true;
          claudeVisibilityCheckedAt = Date.now();
          if (!claudeVisible) hide();
          else schedule();
        })
        .catch(() => {
          claudeVisible = false;
          claudeVisibilityCheckedAt = Date.now();
          hide();
        })
        .finally(() => {
          claudeVisibilityPending = false;
        });
    }

    function activeEditor() {
      const active = document.activeElement && document.activeElement.closest && document.activeElement.closest('.monaco-editor');
      if (active) return active;
      const focusedChild = document.querySelector('.monaco-editor .focused');
      if (focusedChild) return focusedChild.closest('.monaco-editor');
      return document.querySelector('.monaco-editor.focused');
    }

    function selectionRect(editor) {
      if (!editor) return null;
      const editorRect = editor.getBoundingClientRect();
      if (editorRect.width <= 0 || editorRect.height <= 0) return null;
      const rects = Array.from(editor.querySelectorAll('.selected-text'))
        .map(node => node.getBoundingClientRect())
        .filter(rect =>
          rect.width >= MIN_RECT &&
          rect.height >= MIN_RECT &&
          rect.bottom >= editorRect.top &&
          rect.top <= editorRect.bottom &&
          rect.right >= editorRect.left &&
          rect.left <= editorRect.right
        )
        .sort((a, b) => (a.top - b.top) || (a.left - b.left));
      return rects[0] || null;
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function hide() {
      if (!root || !visible) return;
      visible = false;
      root.dataset.visible = 'false';
      root.style.transform = 'translate3d(-9999px, -9999px, 0)';
    }

    function update() {
      scheduled = false;
      if (primaryButtonSelecting) return hide();
      const bridge = globalThis.${COMMAND_BRIDGE_NAME};
      if (typeof bridge !== 'function') return hide();
      refreshClaudeVisibility(false);
      if (!claudeVisible) return hide();
      const editor = activeEditor();
      const rect = selectionRect(editor);
      if (!editor || !rect) return hide();
      const overlay = ensureRoot();
      overlay.dataset.visible = 'true';
      visible = true;
      const editorRect = editor.getBoundingClientRect();
      const width = overlay.offsetWidth || 174;
      const height = overlay.offsetHeight || 31;
      let top = rect.top - height - 6;
      if (top < editorRect.top + 4) top = rect.bottom + 6;
      const left = clamp(rect.left, editorRect.left + 10, Math.max(editorRect.left + 10, editorRect.right - width - 10));
      overlay.style.transform = \`translate3d(\${Math.round(left)}px, \${Math.round(top)}px, 0)\`;
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : cb => setTimeout(cb, 16);
      raf(() => safe(update));
    }

    function eventInEditor(event) {
      const target = event && event.target;
      return !!(target && target.closest && target.closest('.monaco-editor'));
    }

    function focusedEditorElement() {
      return document.activeElement && document.activeElement.closest
        ? document.activeElement.closest('.monaco-editor')
        : null;
    }

    function nodeTouchesEditor(node) {
      if (!node || node.nodeType !== 1) return false;
      return !!(
        node.closest && node.closest('.monaco-editor') ||
        node.matches && node.matches('.monaco-editor') ||
        node.querySelector && node.querySelector('.monaco-editor')
      );
    }

    function mutationTouchesEditor(mutation) {
      if (!mutation) return false;
      if (nodeTouchesEditor(mutation.target)) return true;
      for (const node of mutation.addedNodes || []) {
        if (nodeTouchesEditor(node)) return true;
      }
      for (const node of mutation.removedNodes || []) {
        if (nodeTouchesEditor(node)) return true;
      }
      return false;
    }

    function scheduleForEvent(event) {
      if (visible || eventInEditor(event)) schedule();
    }

    function scheduleForSelection() {
      if (visible || focusedEditorElement()) schedule();
    }

    function handleMouseDown(event) {
      if (!event || event.button !== 0 || !eventInEditor(event)) return;
      primaryButtonSelecting = true;
      hide();
    }

    function handleMouseUp(event) {
      if (event && event.button !== 0) return;
      if (primaryButtonSelecting) {
        primaryButtonSelecting = false;
        schedule();
        return;
      }
      schedule();
    }

    ready(() => {
      ensureRoot();
      refreshClaudeVisibility(true);
      schedule();
      const observer = new MutationObserver(mutations => {
        if (visible) { schedule(); return; }
        for (const mutation of mutations) {
          if (mutationTouchesEditor(mutation)) { schedule(); return; }
        }
      });
      // Keep the Workbench-wide observer childList-only. Selection movement is
      // already covered by selectionchange/mouse/keyboard/scroll events; a
      // body-level class/style observer turns every editor chrome repaint into
      // overlay work and couples this experiment to Monaco's private classes.
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('selectionchange', scheduleForSelection, true);
      document.addEventListener('mousedown', handleMouseDown, true);
      window.addEventListener('resize', () => { if (visible) schedule(); }, true);
      window.addEventListener('scroll', scheduleForEvent, true);
      window.addEventListener('mouseup', handleMouseUp, true);
      document.addEventListener('scroll', scheduleForEvent, true);
      document.addEventListener('keyup', scheduleForEvent, true);
      document.addEventListener('mouseup', handleMouseUp, true);
      document.addEventListener('focusin', scheduleForEvent, true);
      setInterval(() => { if (visible || focusedEditorElement()) schedule(); }, 900);
    });
  } catch (error) {
    try { console.warn('[incipit] editor overlay failed during bootstrap', error); } catch (_) {}
  }
})();
${PATCH_END}
`;
}

function ensureRestorePoint(target, currentContent, currentBytes) {
  const existing = readRestorePoint(target);
  if (existing) return { ...existing, status: 'existing' };
  if (hasWorkbenchPatch(currentContent)) {
    throw new Error('VS Code Workbench already contains incipit editor overlay, but no Workbench restore point exists.');
  }
  return writeRestorePoint(target, currentBytes || Buffer.from(currentContent, 'utf8'), 'current-workbench');
}

function applyWorkbenchOverlayForTarget(claudeTarget, enabled, theme = {}) {
  const resolved = resolveWorkbenchTarget(claudeTarget);
  if (!enabled) {
    if (!resolved.ok) {
      const known = restoreKnownWorkbenchOverlays();
      return { ...known, reason: resolved.reason || null };
    }
    const current = restoreWorkbenchOverlayResolved(resolved, { disabledApply: true });
    const known = restoreKnownWorkbenchOverlays({ excludeHostKey: resolved.hostKey });
    if (known.status === 'restored') {
      return { ...known, currentWorkbench: current };
    }
    return current;
  }
  if (!resolved.ok) {
    throw new Error(overlayResolutionFailureMessage(resolved));
  }

  const currentBytes = fs.readFileSync(resolved.workbenchPath);
  const content = currentBytes.toString('utf8');
  const point = ensureRestorePoint(resolved, content, currentBytes);
  const base = stripWorkbenchPatch(content);
  if (sha256Text(base) !== point.manifest.originalSha256) {
    throw new Error('VS Code Workbench no longer matches the saved official restore point; overlay patch was not applied.');
  }
  let patched = base;
  let bridgeChanged = false;
  [patched, bridgeChanged] = patchCommandBridge(patched);
  patched = patched.replace(/\s+$/, '') + buildOverlayBlock(theme);
  const changed = patched !== content;
  if (changed) atomicWrite(resolved.workbenchPath, Buffer.from(patched, 'utf8'));
  writeSentinel(resolved);
  return {
    status: changed ? 'patched' : 'already-current',
    enabled: true,
    workbenchPath: resolved.workbenchPath,
    appRoot: resolved.appRoot,
    hostKey: resolved.hostKey,
    product: resolved.product,
    restorePointDir: point.restorePointDir,
    bridgeChanged,
  };
}

function restoreWorkbenchOverlayResolved(resolved, options = {}) {
  const point = readRestorePoint(resolved);
  const content = fs.existsSync(resolved.workbenchPath)
    ? fs.readFileSync(resolved.workbenchPath, 'utf8')
    : '';
  const patched = hasWorkbenchPatch(content);
  if (!point) {
    if (patched) {
      throw new Error('No Workbench restore point found for the incipit editor overlay.');
    }
    removeSentinel(resolved);
    return {
      status: options.disabledApply ? 'off' : 'already-official',
      enabled: false,
      workbenchPath: resolved.workbenchPath,
      appRoot: resolved.appRoot,
      hostKey: resolved.hostKey,
      product: resolved.product,
    };
  }
  if (!patched) {
    const currentSha = sha256Text(content);
    if (currentSha !== point.manifest.originalSha256) {
      throw new Error('VS Code Workbench has no incipit overlay marker and does not match the saved restore point; leaving it unchanged.');
    }
    removeSentinel(resolved);
    return {
      status: options.disabledApply ? 'off' : 'already-official',
      enabled: false,
      workbenchPath: resolved.workbenchPath,
      appRoot: resolved.appRoot,
      hostKey: resolved.hostKey,
      product: resolved.product,
      restorePointDir: point.restorePointDir,
    };
  }
  const stripped = stripWorkbenchPatch(content);
  if (sha256Text(stripped) !== point.manifest.originalSha256) {
    throw new Error('VS Code Workbench overlay marker was found, but stripping it does not reproduce the saved official file.');
  }
  const original = fs.readFileSync(point.backupPath);
  if (sha256Bytes(original) !== point.manifest.originalSha256) {
    throw new Error('Workbench restore point bytes failed sha256 verification.');
  }
  atomicWrite(resolved.workbenchPath, original);
  removeSentinel(resolved);
  return {
    status: 'restored',
    enabled: false,
    workbenchPath: resolved.workbenchPath,
    appRoot: resolved.appRoot,
    hostKey: resolved.hostKey,
    product: resolved.product,
    restorePointDir: point.restorePointDir,
  };
}

function collectWorkbenchManifestPaths(root = WORKBENCH_RESTORE_ROOT, depth = 0) {
  if (depth > 4 || !fs.existsSync(root)) return [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === 'manifest.json') {
      out.push(full);
    } else if (entry.isDirectory()) {
      out.push(...collectWorkbenchManifestPaths(full, depth + 1));
    }
  }
  return out;
}

function resolvedWorkbenchTargetFromManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) return null;
  if (!manifest.hostKey || !manifest.workbenchPath) return null;
  return {
    ok: true,
    appRoot: manifest.appRoot || path.resolve(path.dirname(manifest.workbenchPath), '..', '..', '..', '..'),
    workbenchPath: manifest.workbenchPath,
    product: manifest.product || { version: 'unknown' },
    hostKey: manifest.hostKey,
  };
}

function restoreKnownWorkbenchOverlays(options = {}) {
  const restored = [];
  const skipped = [];
  const errors = [];
  const excludeHostKey = options.excludeHostKey || null;
  for (const manifestFile of collectWorkbenchManifestPaths()) {
    const manifest = safeReadJson(manifestFile);
    const backupPath = manifest && (manifest.backupPath || path.join(path.dirname(manifestFile), 'workbench.desktop.main.js'));
    const resolved = resolvedWorkbenchTargetFromManifest(manifest);
    if (!resolved || (excludeHostKey && resolved.hostKey === excludeHostKey)) continue;
    if (!fs.existsSync(backupPath)) {
      skipped.push({ hostKey: resolved.hostKey, reason: 'missing-backup' });
      continue;
    }
    if (!fs.existsSync(resolved.workbenchPath)) {
      removeSentinel(resolved);
      skipped.push({ hostKey: resolved.hostKey, reason: 'missing-workbench' });
      continue;
    }
    let content = '';
    try { content = fs.readFileSync(resolved.workbenchPath, 'utf8'); } catch (exc) {
      skipped.push({ hostKey: resolved.hostKey, reason: exc.message });
      continue;
    }
    if (!hasWorkbenchPatch(content)) {
      removeSentinel(resolved);
      skipped.push({ hostKey: resolved.hostKey, reason: 'not-patched' });
      continue;
    }
    try {
      const result = restoreWorkbenchOverlayResolved(resolved, { disabledApply: true });
      if (result.status === 'restored') restored.push(result);
      else skipped.push({ hostKey: resolved.hostKey, reason: result.status });
    } catch (exc) {
      errors.push(`${resolved.workbenchPath}: ${exc.message}`);
    }
  }
  if (errors.length) {
    throw new Error(`Could not restore all known Workbench editor overlays. ${errors.join(' | ')}`);
  }
  return {
    status: restored.length ? 'restored' : 'off',
    enabled: false,
    restored: restored.length,
    skipped: skipped.length,
    restoredWorkbenches: restored,
  };
}

function restoreWorkbenchOverlayForTarget(claudeTarget) {
  const resolved = resolveWorkbenchTarget(claudeTarget);
  if (!resolved.ok) {
    const known = restoreKnownWorkbenchOverlays();
    if (known.status === 'restored') return { ...known, reason: resolved.reason || null };
    return { status: 'unsupported', enabled: false, reason: resolved.reason || null, candidates: resolved.candidates || [] };
  }
  const current = restoreWorkbenchOverlayResolved(resolved);
  const known = restoreKnownWorkbenchOverlays({ excludeHostKey: resolved.hostKey });
  if (known.status === 'restored') {
    return { ...known, currentWorkbench: current };
  }
  return current;
}

module.exports = {
  WORKBENCH_RESTORE_ROOT,
  OVERLAY_SENTINEL_ROOT,
  applyWorkbenchOverlayForTarget,
  preflightWorkbenchOverlayForTarget,
  restoreWorkbenchOverlayForTarget,
  resolveWorkbenchTarget,
  isOfficialVSCodeTarget,
  appRootLooksSupported,
  hostKeyForAppRoot,
  sentinelPathForHostKey,
  stripWorkbenchPatch,
  __test: {
    overlayVisualTheme,
  },
};
