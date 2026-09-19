'use strict';

const INSERT_COMMAND = 'incipit.claudeCode.insertAtMention';
const SKIPPED_SCHEMES = new Set(['git', 'output', 'debug', 'comment', 'search-editor',
  '_claude_fs_left', '_claude_fs_right', '_claude_vscode_fs_left', '_claude_vscode_fs_right']);

/** Capture the editor before asynchronous delivery can move focus to the chat. */
function getEditorMention(vscode, wholeFile) {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (!document || document.isUntitled || SKIPPED_SCHEMES.has(document.uri.scheme)) {
    throw new Error('Open a saved editor file before referencing it in Claude Code.');
  }
  const selection = editor.selection && !editor.selection.isEmpty ? editor.selection :
    editor.selections?.find(value => value && !value.isEmpty);
  if (!wholeFile && !selection) throw new Error('Select editor text before referencing it in Claude Code.');
  // Absolute paths remain unambiguous when the chat cwd differs from the active
  // workspace folder, including multi-root and remote workspaces.
  const filePath = document.uri.fsPath;
  if (!filePath) throw new Error('This editor does not expose a file path for Claude Code.');
  if (/[#"\r\n\0]/.test(filePath)) throw new Error('Claude Code cannot represent this file path as an unambiguous @-mention.');
  let mention = '@' + filePath.replace(/\\/g, '/');
  if (!wholeFile) {
    const first = selection.start.line + 1;
    const last = selection.end.line + (selection.end.character === 0 && selection.end.line > selection.start.line ? 0 : 1);
    mention += '#' + first + (last !== first ? '-' + last : '');
  }
  return mention;
}

/** Register direct editor actions in the Claude extension's own command scope. */
function registerEditorReferences(vscode, subscriptions) {
  let sending = false;
  for (const [name, wholeFile] of [['referenceSelection', false], ['referenceFile', true]]) {
    subscriptions.push(vscode.commands.registerCommand('incipit.claudeCode.' + name, async () => {
      if (sending) return false;
      try {
        const mention = getEditorMention(vscode, wholeFile);
        sending = true;
        const accepted = await vscode.commands.executeCommand(INSERT_COMMAND, mention);
        if (accepted !== true) throw new Error('Claude Code did not accept the reference. Reload the chat and try again.');
        return true;
      } catch (error) {
        vscode.window.showWarningMessage(error.message || 'Could not insert the reference in Claude Code.');
        return false;
      } finally { sending = false; }
    }));
  }
}

module.exports = { registerEditorReferences, getEditorMention };
