// Cross-platform GUI folder/file picker.
//
// We deliberately do not implement an in-terminal directory navigator or
// fall back to text input. The interaction contract is "pop the OS dialog,
// take a folder or file, return its path"; on environments where no GUI dialog is
// reachable (headless Linux server, SSH session without DISPLAY, missing
// zenity AND kdialog) we report a hard error and let the caller render a
// helpful message. Future versions will expose CLI flags as the escape
// hatch for those scenarios.
//
// Implementation per platform:
//   - Windows  : PowerShell + System.Windows.Forms folder/file dialogs
//                (no external deps). The Vista-style upgrade hinges on
//                `UseDescriptionForTitle`, which only exists on .NET
//                Framework 4.8.1+ / .NET Core 3.0+; Windows PowerShell
//                5.1 binds .NET Framework and many Win10/Win11 21H2 boxes
//                still ship 4.8, so that assignment is made conditional —
//                missing => classic dialog (description as a tree label),
//                still fully functional.
//   - macOS    : `osascript` choose folder/file.
//   - Linux    : `zenity --file-selection` first, then kdialog as fallback.
//
// All three are spawned synchronously, stdout is decoded as UTF-8, and the
// path is returned as a normalized string. User-cancel returns `null`.
// Underlying tool failures throw a tagged error so callers can render the
// right diagnostic.

'use strict';

const cp = require('child_process');
const path = require('path');
const { fileURLToPath } = require('url');

class DialogUnavailableError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DialogUnavailableError';
    this.code = code;
  }
}

class DialogCancelledError extends Error {
  constructor() {
    super('User cancelled the dialog');
    this.name = 'DialogCancelledError';
  }
}

// ============================================================
// availability
// ============================================================

function isCommandAvailable(cmd) {
  try {
    if (process.platform === 'win32') {
      cp.execFileSync('where', [cmd], { stdio: 'ignore', timeout: 3000 });
    } else {
      cp.execFileSync('which', [cmd], { stdio: 'ignore', timeout: 3000 });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function hasLinuxDisplay() {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// `null` means "the GUI dialog is reachable on this platform"; a string
// means "it is not, and here is the reason (translation key)".
function dialogUnavailableReason() {
  if (process.platform === 'win32') {
    if (!isCommandAvailable('powershell')) return 'no-powershell';
    return null;
  }
  if (process.platform === 'darwin') {
    if (!isCommandAvailable('osascript')) return 'no-osascript';
    return null;
  }
  // Linux / FreeBSD / etc.
  if (!hasLinuxDisplay()) return 'no-display';
  if (!isCommandAvailable('zenity') && !isCommandAvailable('kdialog')) {
    return 'no-zenity-no-kdialog';
  }
  return null;
}

function isDialogAvailable() {
  return dialogUnavailableReason() === null;
}

// ============================================================
// platform invocations
// ============================================================

function pickFolderWindows(title) {
  // FolderBrowserDialog uses STA threading. PowerShell's default is MTA;
  // we set `[Threading.Thread]::CurrentThread.SetApartmentState` before
  // showing or it silently fails on some systems. The script is a single
  // Base64-encoded UTF-16LE blob to dodge quoting hell with non-ASCII
  // titles (Chinese is the common case here).
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = ${psQuote(title)}
if ($dlg.PSObject.Properties['UseDescriptionForTitle']) { $dlg.UseDescriptionForTitle = $true }
$dlg.ShowNewFolderButton = $false
$result = $dlg.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dlg.SelectedPath)
} else {
  exit 2
}
`.trim();
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  let out;
  try {
    out = cp.execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (exc) {
    if (exc.status === 2) return null;
    throw new Error(`PowerShell folder dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  return picked || null;
}

function pickFileWindows(title, extensions) {
  const patterns = extensions.map(ext => `*${ext}`).join(';');
  const filter = `SVG / PNG (${patterns})|${patterns}`;
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = ${psQuote(title)}
$dlg.Filter = ${psQuote(filter)}
$dlg.CheckFileExists = $true
$dlg.CheckPathExists = $true
$dlg.Multiselect = $false
$dlg.RestoreDirectory = $true
$result = $dlg.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dlg.FileName)
} else {
  exit 2
}
`.trim();
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  let out;
  try {
    out = cp.execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (exc) {
    if (exc.status === 2) return null;
    throw new Error(`PowerShell file dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  return picked || null;
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function pickFolderMacOS(title) {
  const escaped = String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `POSIX path of (choose folder with prompt "${escaped}")`;
  let out;
  try {
    out = cp.execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (exc) {
    // osascript exits 1 with stderr "User canceled." on cancel.
    const stderr = String((exc.stderr && exc.stderr.toString()) || '');
    if (/cancel/i.test(stderr)) return null;
    throw new Error(`osascript folder dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  if (!picked) return null;
  // `choose folder` returns paths with a trailing slash; strip it for
  // consistency with the Win/Linux backends.
  return stripTrailingSeparators(picked);
}

function pickFileMacOS(title, extensions) {
  const escaped = appleScriptQuote(title);
  const types = extensions.map(ext => `"${appleScriptQuote(ext.slice(1))}"`).join(', ');
  const script = `POSIX path of (choose file with prompt "${escaped}" of type {${types}})`;
  let out;
  try {
    out = cp.execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (exc) {
    const stderr = String((exc.stderr && exc.stderr.toString()) || '');
    if (/cancel/i.test(stderr)) return null;
    throw new Error(`osascript file dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  return picked || null;
}

function appleScriptQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function pickFolderLinux(title) {
  if (isCommandAvailable('zenity')) {
    return pickFolderZenity(title);
  }
  if (isCommandAvailable('kdialog')) {
    return pickFolderKDialog(title);
  }
  throw new DialogUnavailableError(
    'No GUI folder picker available (zenity / kdialog not found)',
    'no-zenity-no-kdialog',
  );
}

function pickFileLinux(title, extensions) {
  if (isCommandAvailable('zenity')) return pickFileZenity(title, extensions);
  if (isCommandAvailable('kdialog')) return pickFileKDialog(title, extensions);
  throw new DialogUnavailableError(
    'No GUI file picker available (zenity / kdialog not found)',
    'no-zenity-no-kdialog',
  );
}

function pickFolderZenity(title) {
  let out;
  try {
    out = cp.execFileSync(
      'zenity',
      ['--file-selection', '--directory', '--title', title],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (exc) {
    // zenity exits 1 on cancel.
    if (exc.status === 1) return null;
    throw new Error(`zenity folder dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  return picked || null;
}

function pickFolderKDialog(title) {
  let out;
  try {
    out = cp.execFileSync(
      'kdialog',
      ['--title', title, '--getexistingdirectory', process.env.HOME || '/'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (exc) {
    // kdialog exits 1 on cancel.
    if (exc.status === 1) return null;
    throw new Error(`kdialog folder dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  return picked || null;
}

function pickFileZenity(title, extensions) {
  const patterns = extensions.map(ext => `*${ext}`).join(' ');
  let out;
  try {
    out = cp.execFileSync(
      'zenity',
      ['--file-selection', '--title', title, `--file-filter=SVG / PNG | ${patterns}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (exc) {
    if (exc.status === 1) return null;
    throw new Error(`zenity file dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  return picked || null;
}

function pickFileKDialog(title, extensions) {
  const patterns = extensions.map(ext => `*${ext}`).join(' ');
  let out;
  try {
    out = cp.execFileSync(
      'kdialog',
      ['--title', title, '--getopenfilename', process.env.HOME || '/', `SVG / PNG (${patterns})`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (exc) {
    if (exc.status === 1) return null;
    throw new Error(`kdialog file dialog failed: ${exc.message}`);
  }
  const picked = String(out || '').trim();
  return picked || null;
}

function normalizePickedPath(value) {
  let picked = String(value || '').trim();
  if (!picked) return '';
  if (/^file:\/\//i.test(picked)) {
    try {
      picked = fileURLToPath(picked);
    } catch (_) {}
  }
  return path.normalize(stripTrailingSeparators(picked));
}

function stripTrailingSeparators(value) {
  const s = String(value || '');
  if (s === '/' || /^[A-Za-z]:[\\/]?$/.test(s)) return s;
  if (/^\/+$/.test(s)) return '/';
  return s.replace(/[\\/]+$/, '');
}

// ============================================================
// public entry
// ============================================================

// Spawn the platform's native folder picker. Returns the chosen absolute
// path on success, `null` if the user cancelled, throws a
// `DialogUnavailableError` if no picker is reachable on this host.
function pickFolder({ title }) {
  const reason = dialogUnavailableReason();
  if (reason) {
    throw new DialogUnavailableError(
      `No GUI folder picker available (reason: ${reason})`,
      reason,
    );
  }
  const promptTitle = title || 'Select a folder';
  let picked;
  if (process.platform === 'win32') {
    picked = pickFolderWindows(promptTitle);
  } else if (process.platform === 'darwin') {
    picked = pickFolderMacOS(promptTitle);
  } else {
    picked = pickFolderLinux(promptTitle);
  }
  if (picked == null) return null;
  // Normalize separators on Windows (PowerShell returns mixed slashes
  // sometimes when the user navigates via a UNC mount).
  return normalizePickedPath(picked);
}

function normalizeFileExtensions(extensions) {
  const normalized = [];
  for (const value of Array.isArray(extensions) ? extensions : []) {
    const ext = String(value || '').trim().toLowerCase();
    if (!/^\.[a-z0-9]+$/.test(ext)) continue;
    if (!normalized.includes(ext)) normalized.push(ext);
  }
  if (!normalized.length) throw new Error('At least one file extension is required');
  return normalized;
}

// Spawn the native file picker with an extension allowlist. The dialog filter
// is convenience only; the returned path is checked again because platform
// pickers and hand-edited automation can bypass visual filters.
function pickFile({ title, extensions = ['.svg', '.png'] } = {}) {
  const reason = dialogUnavailableReason();
  if (reason) {
    throw new DialogUnavailableError(
      `No GUI file picker available (reason: ${reason})`,
      reason,
    );
  }
  const allowed = normalizeFileExtensions(extensions);
  const promptTitle = title || 'Select a file';
  let picked;
  if (process.platform === 'win32') {
    picked = pickFileWindows(promptTitle, allowed);
  } else if (process.platform === 'darwin') {
    picked = pickFileMacOS(promptTitle, allowed);
  } else {
    picked = pickFileLinux(promptTitle, allowed);
  }
  if (picked == null) return null;
  const normalized = normalizePickedPath(picked);
  if (!allowed.includes(path.extname(normalized).toLowerCase())) {
    throw new Error(`Unsupported file type: ${path.extname(normalized) || '(none)'}`);
  }
  return normalized;
}

module.exports = {
  pickFolder,
  pickFile,
  isDialogAvailable,
  dialogUnavailableReason,
  DialogUnavailableError,
  DialogCancelledError,
  __test: {
    normalizePickedPath,
    normalizeFileExtensions,
    pickFileWindows,
    pickFileMacOS,
    pickFileZenity,
    pickFileKDialog,
  },
};
