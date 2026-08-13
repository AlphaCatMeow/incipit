'use strict';

//! Atomic file replacement shared by every incipit writer.
//!
//! incipit rewrites multi-megabyte bundles inside a live VS Code extension
//! directory. A torn write there is not a recoverable inconvenience: a
//! truncated `webview/index.js` is a syntax error, and a syntax error blanks
//! the Claude Code panel. Writing to a sibling temp file and renaming leaves
//! the target either fully old or fully new, even when the process dies
//! mid-write or a virus scanner briefly holds the file open.

const fs = require('fs');
const path = require('path');

/**
 * Replace `targetPath` with `data`, atomically.
 *
 * The parent directory is created when missing. The temp file is written next
 * to the target so the rename never crosses a filesystem boundary; a failed
 * rename removes the temp file before rethrowing.
 *
 * @param {string} targetPath Absolute path of the file to replace.
 * @param {string|Buffer} data Complete contents to write.
 */
function atomicWrite(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (exc) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw exc;
  }
}

module.exports = { atomicWrite };
