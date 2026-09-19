# Incipit: Claude Selection Reference

Optional VS Code CodeLens companion for Claude Code.

When the active editor has a non-empty selection, it normally shows two clickable CodeLens actions above the selection's first line: `◆ Selection` and `▣ File`. Clicking either action opens Claude Code if needed and inserts a visible official `@file#x-y` or `@file` reference in the composer.

If incipit's Workbench editor overlay is enabled in the CLI config, this extension hides CodeLens. The overlay calls `incipit.claudeCode.referenceSelection` and `incipit.claudeCode.referenceFile`, registered inside the patched Claude Code extension. It does not require this companion to be installed.

## Local Test

From the repository root:

```powershell
code --extensionDevelopmentPath="$PWD\companion\claude-selection-reference"
```

Or copy this folder into your VS Code extensions directory and reload VS Code:

```powershell
$dst = "$env:USERPROFILE\.vscode\extensions\incipit.claude-selection-reference-0.0.1"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item companion\claude-selection-reference\* $dst -Recurse -Force
```

Select text in an editor, then click `◆ Selection` or `▣ File`.

## Notes

- It does not write Claude Code transcripts.
- It does not call `session.send`.
- It reuses the incipit-patched Claude command bridge (`incipit.claudeCode.insertAtMention`), so it does not depend on Claude Code's own `insertAtMention` callback accepting arguments.
- The experimental overlay is installed by the incipit CLI, not by this companion extension.
