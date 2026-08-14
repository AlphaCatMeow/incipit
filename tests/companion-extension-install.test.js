'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { removeCompanionExtensions } = require('../src/install');
const {
  COMPANION_EXTENSION_PREFIX,
  installCompanionExtension,
  companionExtensionVersion,
} = require('../src/install').__test;

const RESOURCE_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(RESOURCE_ROOT, 'companion', 'claude-selection-reference');

function walkRelative(root) {
  const out = [];
  function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(full, relPath);
      else out.push(relPath.split(path.sep).join('/'));
    }
  }
  walk(root, '');
  return out.sort();
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-companion-install-'));
try {
  const extensionsDir = temp;
  const extensionDir = path.join(extensionsDir, 'anthropic.claude-code-1.2.3');
  fs.mkdirSync(extensionDir, { recursive: true });
  const target = { extensionDir };

  const version = companionExtensionVersion(RESOURCE_ROOT);
  assert.ok(/^\d+\.\d+\.\d+/.test(version), 'companion package.json exposes a semver version');

  // Fresh install: syncs every source file into a version-suffixed sibling
  // folder next to the Claude Code extension, matching VS Code's own
  // `publisher.name-x.y.z` extension layout.
  const first = installCompanionExtension(RESOURCE_ROOT, target);
  assert.strictEqual(first.name, `${COMPANION_EXTENSION_PREFIX}${version}`);
  assert.strictEqual(first.path, path.join(extensionsDir, first.name));
  assert.strictEqual(first.version, version);
  assert.strictEqual(first.staleRemoved, 0);
  assert.ok(first.written > 0, 'fresh install writes at least one file');
  assert.strictEqual(first.written, first.total);
  assert.ok(fs.existsSync(path.join(first.path, 'package.json')));
  assert.ok(fs.existsSync(path.join(first.path, 'extension.js')));
  assert.ok(fs.existsSync(path.join(first.path, 'l10n', 'bundle.l10n.zh-cn.json')));

  const installedFiles = walkRelative(first.path);
  assert.deepStrictEqual(
    installedFiles,
    walkRelative(SOURCE_DIR),
    'installed file tree matches the shipped companion source tree',
  );
  for (const rel of installedFiles) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(first.path, rel)),
      fs.readFileSync(path.join(SOURCE_DIR, rel)),
      `${rel} bytes match the shipped source`,
    );
  }

  // Idempotent: a second install with nothing changed on either side writes
  // nothing and removes nothing.
  const second = installCompanionExtension(RESOURCE_ROOT, target);
  assert.strictEqual(second.written, 0, 'repeated install is idempotent');
  assert.strictEqual(second.staleRemoved, 0);

  // Simulate a folder left behind by a previous incipit version, plus an
  // unrelated extension that must never be touched.
  const staleDir = path.join(extensionsDir, `${COMPANION_EXTENSION_PREFIX}0.0.0-stale-test`);
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'extension.js'), '// stale build');
  const unrelatedDir = path.join(extensionsDir, 'someone-else.unrelated-1.0.0');
  fs.mkdirSync(unrelatedDir, { recursive: true });
  fs.writeFileSync(path.join(unrelatedDir, 'extension.js'), '// not ours');

  const third = installCompanionExtension(RESOURCE_ROOT, target);
  assert.strictEqual(third.staleRemoved, 1, 'a stale-version companion folder is pruned on the next apply');
  assert.ok(!fs.existsSync(staleDir), 'the stale-version folder no longer exists');
  assert.ok(fs.existsSync(unrelatedDir), 'an unrelated extension folder is left untouched');
  assert.ok(fs.existsSync(third.path), 'the current-version folder still exists');

  // Restore removes every incipit companion folder but leaves unrelated
  // extensions (and the Claude Code target itself) untouched.
  const removal = removeCompanionExtensions(target);
  assert.strictEqual(removal.removed, 1);
  assert.ok(!fs.existsSync(third.path), 'the companion extension folder is removed on restore');
  assert.ok(fs.existsSync(unrelatedDir), 'restore leaves unrelated extension folders untouched');
  assert.ok(fs.existsSync(extensionDir), 'restore leaves the Claude Code target itself untouched');

  // Removing again when nothing is installed is a safe no-op.
  const removalAgain = removeCompanionExtensions(target);
  assert.strictEqual(removalAgain.removed, 0);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('companion extension install tests passed');
