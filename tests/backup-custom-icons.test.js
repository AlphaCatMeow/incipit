'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CUSTOM_ICON_NAMES } = require('../src/custom-icon');

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function makeTarget(root, version, iconNames = CUSTOM_ICON_NAMES) {
  const extensionDir = path.join(root, `anthropic.claude-code-${version}`);
  const extensionJsPath = path.join(extensionDir, 'extension.js');
  const webviewIndexJsPath = path.join(extensionDir, 'webview', 'index.js');
  writeFile(extensionJsPath, `// official extension ${version}\n`);
  writeFile(webviewIndexJsPath, `// official webview ${version}\n`);
  writeFile(path.join(extensionDir, 'package.json'), JSON.stringify({
    name: 'claude-code',
    publisher: 'Anthropic',
    version,
  }));
  for (const name of iconNames) writeFile(path.join(extensionDir, 'resources', name), `official:${name}`);
  return { extensionDir, extensionJsPath, webviewIndexJsPath, version };
}

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-backup-icons-'));
  const home = path.join(sandbox, 'home');
  const targetsRoot = path.join(sandbox, 'targets');
  fs.mkdirSync(home, { recursive: true });
  const originalHomedir = os.homedir;
  const backupPath = require.resolve('../src/backup');
  os.homedir = () => home;
  delete require.cache[backupPath];
  const backup = require('../src/backup');

  try {
    const target = makeTarget(targetsRoot, '9.0.1');
    const extraPath = path.join(target.extensionDir, 'resources', 'unrelated.svg');
    writeFile(extraPath, 'leave me alone');

    const oldPoint = await backup.ensureOfficialRestorePoint(target);
    assert.ok(!oldPoint.manifest.entries.some(entry => entry.logicalName.startsWith('resources/')));

    const extended = await backup.ensureOfficialRestorePoint(target, { includeCustomIcons: true });
    assert.strictEqual(extended.status, 'extended');
    assert.strictEqual(extended.iconEntriesAdded, 4);
    const iconEntries = extended.manifest.entries.filter(entry => entry.logicalName.startsWith('resources/'));
    assert.deepStrictEqual(iconEntries.map(entry => entry.logicalName).sort(),
      CUSTOM_ICON_NAMES.map(name => `resources/${name}`).sort());
    const payloads = backup.readOfficialIconRestorePayloads(extended, CUSTOM_ICON_NAMES);
    assert.ok(payloads.every(payload => payload.bytes.toString() === `official:${payload.name}`));

    for (const name of CUSTOM_ICON_NAMES) {
      writeFile(path.join(target.extensionDir, 'resources', name), `custom:${name}`);
    }
    await backup.restoreOfficialTarget(target);
    for (const name of CUSTOM_ICON_NAMES) {
      assert.strictEqual(
        fs.readFileSync(path.join(target.extensionDir, 'resources', name), 'utf8'),
        `official:${name}`,
      );
    }
    assert.strictEqual(fs.readFileSync(extraPath, 'utf8'), 'leave me alone', 'restore never owns the resources tree');

    const missingName = 'claude-logo-done.svg';
    const missingTarget = makeTarget(
      targetsRoot,
      '9.0.2',
      CUSTOM_ICON_NAMES.filter(name => name !== missingName),
    );
    const missingPoint = await backup.ensureOfficialRestorePoint(missingTarget, { includeCustomIcons: true });
    const missingEntry = missingPoint.manifest.entries.find(entry => entry.logicalName === `resources/${missingName}`);
    assert.strictEqual(missingEntry.existedBefore, false);
    writeFile(path.join(missingTarget.extensionDir, 'resources', missingName), 'custom-created');
    await backup.restoreOfficialTarget(missingTarget);
    assert.ok(!fs.existsSync(path.join(missingTarget.extensionDir, 'resources', missingName)));

    // Legacy migration stays structurally icon-free. A non-icon apply still
    // migrates from a legacy backup, but the migrated point carries no
    // resources/ icon entries: a legacy backup never captured the official
    // icons, so it cannot prove an official icon source.
    const legacyTarget = makeTarget(targetsRoot, '9.0.3');
    backup.createBackup(legacyTarget, { name: 'pre-icon' });
    fs.appendFileSync(legacyTarget.extensionJsPath, '// incipit patched\n');
    const migrated = await backup.ensureOfficialRestorePoint(legacyTarget);
    assert.strictEqual(migrated.status, 'migrated');
    assert.ok(
      !migrated.manifest.entries.some(entry => entry.logicalName.startsWith('resources/')),
      'legacy migration never captures resources/ icons it cannot prove official',
    );

    // Regression (backfill bug): an icon-carrying apply over a lost restore
    // point must refuse a legacy migration instead of snapshotting the current
    // resources/ bytes as "official". Even when those bytes are already a
    // previously applied custom icon, the path fails closed toward Marketplace
    // recovery — it never backfills custom bytes into the official restore point.
    const poisonedTarget = makeTarget(targetsRoot, '9.0.6');
    backup.createBackup(poisonedTarget, { name: 'pre-icon' });
    fs.appendFileSync(poisonedTarget.extensionJsPath, '// incipit patched\n');
    for (const name of CUSTOM_ICON_NAMES) {
      writeFile(path.join(poisonedTarget.extensionDir, 'resources', name), `already-custom:${name}`);
    }
    await assert.rejects(
      () => backup.ensureOfficialRestorePoint(poisonedTarget, { includeCustomIcons: true }),
      (err) => backup.isMissingOfficialRestorePointError(err),
      'an icon apply over a lost restore point must not backfill custom bytes as official',
    );

    const sourceTarget = makeTarget(targetsRoot, '9.0.4');
    const extensionRoot = path.join(sandbox, 'marketplace-extension');
    writeFile(path.join(extensionRoot, 'extension.js'), '// marketplace official');
    writeFile(path.join(extensionRoot, 'webview', 'index.js'), '// marketplace official');
    for (const name of CUSTOM_ICON_NAMES) {
      writeFile(path.join(extensionRoot, 'resources', name), `marketplace:${name}`);
    }
    writeFile(path.join(extensionRoot, 'resources', 'unrelated.svg'), 'not owned');
    const marketplaceRestore = path.join(sandbox, 'marketplace-restore');
    fs.mkdirSync(marketplaceRestore, { recursive: true });
    const marketplaceEntries = backup.__test.officialRestorePointEntriesFromExtensionRoot(
      sourceTarget,
      extensionRoot,
      marketplaceRestore,
      { includeCustomIcons: true },
    );
    const marketplaceIcons = marketplaceEntries.filter(entry => entry.logicalName.startsWith('resources/'));
    assert.strictEqual(marketplaceIcons.length, 4);
    assert.ok(marketplaceIcons.every(entry => fs.readFileSync(entry.backupPath, 'utf8') ===
      `marketplace:${path.basename(entry.logicalName)}`));
    assert.ok(!marketplaceEntries.some(entry => entry.logicalName === 'resources/unrelated.svg'));

    for (const name of CUSTOM_ICON_NAMES) {
      writeFile(path.join(sourceTarget.extensionDir, 'resources', name), `marketplace-custom:${name}`);
    }
    const [marketplaceRestored] = backup.restoreBackup({
      claudeCodeVersion: sourceTarget.version,
      extensionVersion: sourceTarget.version,
      extensionDir: sourceTarget.extensionDir,
      entries: marketplaceEntries,
    }, { target: sourceTarget });
    assert.ok(marketplaceRestored >= 4);
    for (const name of CUSTOM_ICON_NAMES) {
      assert.strictEqual(
        fs.readFileSync(path.join(sourceTarget.extensionDir, 'resources', name), 'utf8'),
        `marketplace:${name}`,
        'Marketplace recovery restores the exact packaged icon bytes',
      );
    }

    const corrupt = marketplaceIcons[0];
    writeFile(corrupt.backupPath, 'corrupted');
    assert.throws(
      () => backup.readOfficialIconRestorePayloads({ manifest: { entries: marketplaceEntries } }, [path.basename(corrupt.logicalName)]),
      /failed verification/,
    );

    const missingFingerprint = { ...marketplaceIcons[1], sha256: '' };
    assert.throws(
      () => backup.readOfficialIconRestorePayloads({
        manifest: {
          entries: marketplaceEntries.map(entry =>
            entry.logicalName === missingFingerprint.logicalName ? missingFingerprint : entry),
        },
      }, [path.basename(missingFingerprint.logicalName)]),
      /no valid fingerprint/,
    );

    const outsidePath = path.join(sandbox, 'must-not-be-restored.svg');
    writeFile(outsidePath, 'outside-sentinel');
    const escapedEntries = marketplaceEntries.map(entry =>
      entry.logicalName === marketplaceIcons[2].logicalName
        ? { ...entry, originalPath: outsidePath }
        : entry
    );
    assert.throws(
      () => backup.restoreBackup({
        claudeCodeVersion: sourceTarget.version,
        extensionVersion: sourceTarget.version,
        extensionDir: sourceTarget.extensionDir,
        entries: escapedEntries,
      }, { target: sourceTarget }),
      /different Claude Code target/,
      'restore refuses a manifest entry whose destination escapes its logical target path',
    );
    assert.strictEqual(fs.readFileSync(outsidePath, 'utf8'), 'outside-sentinel');

    const ownedMigrationTarget = makeTarget(targetsRoot, '9.0.5');
    const ownedMigrationPoint = await backup.ensureOfficialRestorePoint(ownedMigrationTarget);
    const ownedLogicalName = 'webview/ink-black-override.css';
    const ownedManifestPath = path.join(ownedMigrationPoint.restorePointDir, 'manifest.json');
    const ownedManifest = JSON.parse(fs.readFileSync(ownedManifestPath, 'utf8'));
    ownedManifest.entries = ownedManifest.entries.filter(entry => entry.logical_name !== ownedLogicalName);
    fs.writeFileSync(ownedManifestPath, JSON.stringify(ownedManifest, null, 2));
    const extendedOwnedPoint = await backup.ensureOfficialRestorePoint(ownedMigrationTarget);
    assert.strictEqual(extendedOwnedPoint.status, 'extended');
    assert.strictEqual(extendedOwnedPoint.ownedWebviewEntriesAdded, 1);
    const ownedEntry = extendedOwnedPoint.manifest.entries.find(entry => entry.logicalName === ownedLogicalName);
    assert.ok(ownedEntry && ownedEntry.existedBefore === false,
      'an older restore point records a newly owned webview file before its first write');
    const ownedDestination = path.join(ownedMigrationTarget.extensionDir, 'webview', 'ink-black-override.css');
    writeFile(ownedDestination, 'incipit-generated-ink-theme');
    await backup.restoreOfficialTarget(ownedMigrationTarget);
    assert.ok(!fs.existsSync(ownedDestination),
      'restore deletes a newly introduced owned webview file added after the original point schema');

    const malformedRestore = path.join(sandbox, 'malformed-restore');
    writeFile(path.join(malformedRestore, 'manifest.json'), JSON.stringify({
      version: 3,
      entries: [{ type: 'file', logical_name: 'broken', original_path: 'x', backup_file: '../escape' }],
    }));
    assert.strictEqual(
      backup.__test.readManifest(malformedRestore),
      null,
      'a malformed entry invalidates the whole manifest instead of being silently dropped',
    );

    const malformedOriginalPath = path.join(sandbox, 'malformed-original-path');
    writeFile(path.join(malformedOriginalPath, 'payload'), 'payload');
    writeFile(path.join(malformedOriginalPath, 'manifest.json'), JSON.stringify({
      version: 3,
      entries: [{
        type: 'file',
        logical_name: 'extension.js',
        original_path: 'relative-target.js',
        backup_file: 'payload',
      }],
    }));
    assert.strictEqual(
      backup.__test.readManifest(malformedOriginalPath),
      null,
      'manifest destinations must be absolute before a restore point is accepted',
    );
  } finally {
    delete require.cache[backupPath];
    os.homedir = originalHomedir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().then(
  () => console.log('backup-custom-icons tests passed'),
  error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  },
);
