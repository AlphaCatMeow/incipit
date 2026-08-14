'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const CONFIG_SECTION = 'incipitClaudeReference';
const COMMAND_REFERENCE_SELECTION = 'incipitClaudeReference.referenceSelection';
const COMMAND_REFERENCE_ACTIVE_SELECTION = 'incipitClaudeReference.referenceActiveSelection';
const COMMAND_REFERENCE_ACTIVE_FILE = 'incipitClaudeReference.referenceActiveFile';
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_INSERT_COMMAND = 'incipit.claudeCode.insertAtMention';
const OVERLAY_SENTINEL_ROOT = path.join(os.homedir(), '.incipit', 'editor-selection-overlay-v1');
const HOST_IDENTITY_ROOT = path.join(os.homedir(), '.incipit', 'editor-hosts-v1');
const INCIPIT_CONFIG_PATH = path.join(os.homedir(), '.incipit', 'config.json');

function labelSelection() {
  return `◆ ${vscode.l10n.t('Selection')}`;
}

function labelWholeFile() {
  return `▣ ${vscode.l10n.t('File')}`;
}

const SKIPPED_SCHEMES = new Set([
  'comment',
  'debug',
  'git',
  'output',
  'search-editor',
  '_claude_fs_left',
  '_claude_fs_right',
  '_claude_vscode_fs_left',
  '_claude_vscode_fs_right'
]);

function activate(context) {
  const codeLensEvents = new vscode.EventEmitter();
  let refreshTimer = null;
  let overlayCache = { checkedAt: 0, available: false };
  let overlayDesiredCache = { checkedAt: 0, desired: false };

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      codeLensEvents.fire();
    }, 35);
  };

  const provider = {
    onDidChangeCodeLenses: codeLensEvents.event,
    provideCodeLenses(document) {
      if (!getConfig().enabled) return [];
      if (overlayDesired()) return [];
      if (overlayAvailable()) return [];
      if (!canReferenceDocument(document)) return [];
      if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) return [];

      const editor = vscode.window.activeTextEditor;
      if (!editor || !sameUri(editor.document.uri, document.uri)) return [];

      const selection = getPrimarySelection(editor);
      if (!selection || selection.isEmpty) return [];

      const range = codeLensRange(document, selection);
      return [
        createCodeLens({
          range,
          title: labelSelection(),
          command: COMMAND_REFERENCE_ACTIVE_SELECTION
        }),
        createCodeLens({
          range,
          title: labelWholeFile(),
          command: COMMAND_REFERENCE_ACTIVE_FILE
        })
      ];
    }
  };

  context.subscriptions.push(
    codeLensEvents,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: 'file' }, { scheme: 'vscode-remote' }],
      provider
    ),
    vscode.commands.registerCommand(COMMAND_REFERENCE_SELECTION, async (payload) => {
      await referenceMention(payload);
    }),
    vscode.commands.registerCommand(COMMAND_REFERENCE_ACTIVE_SELECTION, async () => {
      await referenceActiveEditor({ wholeFile: false });
    }),
    vscode.commands.registerCommand(COMMAND_REFERENCE_ACTIVE_FILE, async () => {
      await referenceActiveEditor({ wholeFile: true });
    }),
    vscode.window.onDidChangeTextEditorSelection(scheduleRefresh),
    vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
    vscode.workspace.onDidChangeTextDocument(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) scheduleRefresh();
    }),
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) }
  );

  writeHostIdentity(context);
  scheduleRefresh();

  function overlayDesired() {
    const now = Date.now();
    if (now - overlayDesiredCache.checkedAt < 1000) return overlayDesiredCache.desired;
    overlayDesiredCache = { checkedAt: now, desired: readEditorOverlayDesired() };
    return overlayDesiredCache.desired;
  }

  function overlayAvailable() {
    const now = Date.now();
    if (now - overlayCache.checkedAt < 1000) return overlayCache.available;
    overlayCache = { checkedAt: now, available: readOverlaySentinel() };
    return overlayCache.available;
  }
}

function deactivate() {}

function getConfig() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: config.get('enabled', true)
  };
}

function canReferenceDocument(document) {
  if (!document || document.isUntitled) return false;
  if (SKIPPED_SCHEMES.has(document.uri.scheme)) return false;
  return true;
}

function getPrimarySelection(editor) {
  if (!editor) return null;
  if (editor.selection && !editor.selection.isEmpty) return editor.selection;
  return (editor.selections || []).find((selection) => selection && !selection.isEmpty) || null;
}

function codeLensRange(document, selection) {
  const lastLine = document.lineCount - 1;
  const line = Math.max(0, Math.min(selection.start.line, lastLine));
  return new vscode.Range(line, 0, line, 0);
}

function createCodeLens({ range, title, command }) {
  return new vscode.CodeLens(range, {
    command,
    title,
    arguments: []
  });
}

function buildMention(uri, selection) {
  const relativePath = relativeMentionPath(uri);
  if (!relativePath) return null;
  if (!selection) return `@${relativePath}`;

  const { startLine, endLine } = selectedLineRange(selection);
  if (startLine === endLine) return `@${relativePath}#${startLine}`;
  return `@${relativePath}#${startLine}-${endLine}`;
}

function relativeMentionPath(uri) {
  if (!uri) return null;
  const input = uri.scheme === 'file' ? uri.fsPath : uri;
  const relative = vscode.workspace.asRelativePath(input, false);
  if (!relative || typeof relative !== 'string') return null;
  return relative.replace(/\\/g, '/');
}

function selectedLineRange(selection) {
  let start = selection.start;
  let end = selection.end;

  if (end.character === 0 && end.line > start.line) {
    end = end.translate(-1, 0);
  }

  return {
    startLine: start.line + 1,
    endLine: end.line + 1
  };
}

async function referenceMention(payload) {
  const mention = payload && typeof payload.mention === 'string' ? payload.mention : null;
  if (!mention) {
    vscode.window.showWarningMessage(vscode.l10n.t('No Claude Code reference was available for this selection.'));
    return;
  }

  if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    vscode.window.showWarningMessage(vscode.l10n.t('Claude Code for VS Code is not installed.'));
    return;
  }

  try {
    await vscode.commands.executeCommand(CLAUDE_INSERT_COMMAND, mention);
  } catch (error) {
    vscode.window.showWarningMessage(
      vscode.l10n.t('Could not insert the reference in Claude Code. Run incipit apply, reload VS Code, and try again.')
    );
    throw error;
  }
}

async function referenceActiveEditor(options = {}) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !canReferenceDocument(editor.document)) {
    vscode.window.showWarningMessage(vscode.l10n.t('No editor file was available for Claude Code reference.'));
    return;
  }
  const selection = options.wholeFile ? null : getPrimarySelection(editor);
  if (!options.wholeFile && (!selection || selection.isEmpty)) {
    vscode.window.showWarningMessage(vscode.l10n.t('No editor selection was available for Claude Code reference.'));
    return;
  }
  const mention = buildMention(editor.document.uri, selection);
  await referenceMention({ mention });
}

function readOverlaySentinel() {
  const appRoot = vscode.env && typeof vscode.env.appRoot === 'string' ? vscode.env.appRoot : '';
  if (!appRoot) return false;
  const hostKey = hostKeyForAppRoot(appRoot);
  const sentinelPath = path.join(OVERLAY_SENTINEL_ROOT, `${hostKey}.json`);
  try {
    const text = fs.readFileSync(sentinelPath, 'utf8');
    const data = JSON.parse(text);
    return data && data.active === true && data.hostKey === hostKey;
  } catch (_) {
    return false;
  }
}

function readEditorOverlayDesired() {
  try {
    const text = fs.readFileSync(INCIPIT_CONFIG_PATH, 'utf8');
    const data = JSON.parse(text);
    return !!(data && data.features && data.features.editorSelectionOverlay === true);
  } catch (_) {
    return false;
  }
}

function writeHostIdentity(context) {
  const appRoot = vscode.env && typeof vscode.env.appRoot === 'string' ? vscode.env.appRoot : '';
  if (!appRoot) return;
  const claude = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!claude || !claude.extensionPath) return;
  const hostKey = hostKeyForAppRoot(appRoot);
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    hostKey,
    appName: vscode.env && vscode.env.appName || '',
    appHost: vscode.env && vscode.env.appHost || '',
    uriScheme: vscode.env && vscode.env.uriScheme || '',
    appRoot,
    companionExtensionPath: context && context.extensionPath || '',
    claudeExtensionPath: claude.extensionPath
  };
  try {
    fs.mkdirSync(HOST_IDENTITY_ROOT, { recursive: true });
    atomicWrite(
      path.join(HOST_IDENTITY_ROOT, `${hostKey}.json`),
      Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8')
    );
  } catch (_) {}
}

function atomicWrite(targetPath, data) {
  const tmp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function hostKeyForAppRoot(appRoot) {
  return crypto.createHash('sha256').update(canonicalPath(appRoot)).digest('hex').slice(0, 20);
}

function canonicalPath(input) {
  const resolved = path.resolve(input);
  let real = resolved;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (_) {}
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function sameUri(left, right) {
  return left && right && left.toString() === right.toString();
}

module.exports = {
  activate,
  deactivate
};
