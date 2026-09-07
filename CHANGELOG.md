# Changelog

[中文版 →](CHANGELOG.zh.md)

## 0.2.0 — 2026-09-07

The transcript is the release. Tool calls, thinking and diffs used to stack up as separate cards; they now read as one activity column, the way a transcript should. Most of what follows comes out of that — plus a set of installer fixes that close a way incipit could leave your Claude Code panel blank.

### Transcript

- Tool calls, thinking and their previews form a single activity rail: one glyph per step, a connector between them, and a header that folds the whole run — *Read 7 files, edited 5 files · 1 failed*. Each row carries the action in the right tense, the file's basename, its +/− counts and the host's own result line. Running steps blink; failed ones turn red.
- Assistant prose between tool calls stays ordinary text and ends the run, so folding a group hides only the mechanics — never something Claude said to you.
- Thinking blocks the host renders empty or redacted now join the rail and fold with their group instead of standing alone.
- The reading column is measured in characters rather than pixels, so it keeps its measure at any font size, and a sidebar-width pane keeps real air on both sides.
- Folds and hover always animate — 220ms folds, 180ms hover — and never on the streaming path.

### Diff previews

- One bordered viewport with whole-line add/delete tints that reach the border. The header, the notice block and the repeated title are gone; paging and *Full diff* live on a single footer line.
- Historical diffs are computed on demand from the recorded patch, with paging, caches, and an explicit state when there is genuinely nothing to show.
- Edit counts appear the moment a tool runs and are replaced by the real patch when it lands; a result not written to disk yet is retried instead of waited on forever.
- Syntax highlighting is shared with prose, loads languages on demand, and no longer starts a worker the panel's CSP would block.

### Agents and workflows

- Nested agent activity and workflow progress are visible for the first time: read-only agent history bound to the session, observed task events, and phase-based workflow views with explicit terminal states.

### Usage badge

- The cache popup is rebuilt around its chart. The axis now reports the selected range's own highest and lowest hit rate and a dashed rule its mean, so the stat cards that repeated those numbers are gone; the range summary is one line above one bar covering every billed token class. About half its former height, and readable down to a 234px sidebar.

### Scrolling and input

- The transcript follows new output only while you have not scrolled away yourself; middle-button, wheel and keyboard browsing are all respected rather than fought.
- Fixed the ghost line at the bottom of a long composer input, where the visible text drifted a line above the caret and Backspace could not remove it. (A Chromium/host interaction — reproduced on an unpatched Claude Code.)

### Installing and restoring

- Host bundles are written atomically, and both are patched and proven parseable before either one reaches disk. A killed process, a power loss or a virus scanner holding a file mid-write can no longer leave a truncated bundle and a blank Claude Code panel.
- The @-mention bridge is re-anchored onto Claude Code 2.1.231 and later, restoring companion file references on current builds.
- Host route fingerprints registered for Claude Code 2.1.220, 2.1.231, 2.1.251 and 2.1.258.

### Removed

- incipit no longer measures or rewrites the *Thought for Ns* label. Claude Code derives it from a runtime-only clock and stores no duration anywhere, so any number incipit showed for a block loaded from history was its own invention. The label is now left exactly as the host renders it.

### Upgrading

```bash
npm install -g incipit@latest
incipit apply
```

Then run **Reload Window** in VS Code.

---

From 0.2.0 on, releases are built and published from CI on a signed tag, with npm provenance attached. Releases before 0.2.0 are recorded in the git history.
