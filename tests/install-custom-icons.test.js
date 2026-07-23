'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { prepareCustomIcon, CUSTOM_ICON_NAMES, PNG_ICON_NAME } = require('../src/custom-icon');
const {
  validateCustomIconApplyInputs,
  inspectCustomIconTarget,
  applyCustomIconPlan,
} = require('../src/install').__test;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function transparentPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanline = Buffer.from([0, 210, 85, 50, 0]);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function seedOfficialIcons(resourcesDir, missing = new Set()) {
  fs.mkdirSync(resourcesDir, { recursive: true });
  const bytesByName = new Map();
  for (const name of CUSTOM_ICON_NAMES) {
    const bytes = Buffer.from(`official:${name}`);
    bytesByName.set(name, bytes);
    if (!missing.has(name)) fs.writeFileSync(path.join(resourcesDir, name), bytes);
  }
  return bytesByName;
}

function restorePayloads(officialBytes, missing = new Set()) {
  return CUSTOM_ICON_NAMES.map(name => ({
    name,
    existedBefore: !missing.has(name),
    bytes: missing.has(name) ? null : officialBytes.get(name),
  }));
}

function assertSlotsEqual(resourcesDir, expected) {
  for (const name of CUSTOM_ICON_NAMES) {
    const destination = path.join(resourcesDir, name);
    const bytes = expected.get(name);
    if (bytes === null) assert.ok(!fs.existsSync(destination), `${name} should be absent`);
    else assert.deepStrictEqual(fs.readFileSync(destination), bytes, `${name} bytes`);
  }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-install-icons-'));
try {
  const extensionDir = path.join(temp, 'extension');
  const resourcesDir = path.join(extensionDir, 'resources');
  const target = { extensionDir };
  const officialBytes = seedOfficialIcons(resourcesDir);
  fs.writeFileSync(path.join(resourcesDir, 'unrelated.svg'), 'leave-me-alone');

  const svgPath = path.join(temp, 'selected.svg');
  fs.writeFileSync(svgPath, [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">',
    '<path fill="#d95530" d="M1 1h18v18H1z"/>',
    '</svg>',
  ].join(''));
  const svgPlan = prepareCustomIcon(svgPath);
  const validatedSvg = validateCustomIconApplyInputs(svgPlan, restorePayloads(officialBytes));
  const svgReport = applyCustomIconPlan(target, validatedSvg);
  assert.strictEqual(svgReport.status, 'customized');
  assert.strictEqual(svgReport.written, 3);
  assert.strictEqual(svgReport.total, 4);
  const expectedSvg = new Map(svgPlan.slots.map(slot => [slot.name, slot.bytes]));
  expectedSvg.set(PNG_ICON_NAME, officialBytes.get(PNG_ICON_NAME));
  assertSlotsEqual(resourcesDir, expectedSvg);
  assert.strictEqual(fs.readFileSync(path.join(resourcesDir, 'unrelated.svg'), 'utf8'), 'leave-me-alone');

  const svgAgain = applyCustomIconPlan(target, validatedSvg);
  assert.strictEqual(svgAgain.written, 0, 'repeated SVG apply is idempotent');

  const pngPath = path.join(temp, 'selected.png');
  fs.writeFileSync(pngPath, transparentPng());
  const pngPlan = prepareCustomIcon(pngPath);
  const validatedPng = validateCustomIconApplyInputs(pngPlan, restorePayloads(officialBytes));
  const pngReport = applyCustomIconPlan(target, validatedPng);
  assert.strictEqual(pngReport.written, 4);
  assertSlotsEqual(resourcesDir, new Map(pngPlan.slots.map(slot => [slot.name, slot.bytes])));

  for (const [name, bytes] of officialBytes) fs.writeFileSync(path.join(resourcesDir, name), bytes);
  assert.throws(
    () => applyCustomIconPlan(target, validatedSvg, {
      beforeSlot(_operation, index) {
        if (index === 1) throw new Error('injected write failure');
      },
    }),
    error => error.code === 'INCIPIT_CUSTOM_ICON_APPLY_FAILED' && /rolled back/.test(error.message),
  );
  assertSlotsEqual(resourcesDir, officialBytes);
  assert.deepStrictEqual(
    fs.readdirSync(resourcesDir).filter(name => name.includes('.incipit-')),
    [],
    'transaction leaves no temporary files',
  );

  if (process.platform !== 'win32') {
    const permissionDestination = path.join(resourcesDir, CUSTOM_ICON_NAMES[0]);
    const originalMode = fs.statSync(permissionDestination).mode & 0o777;
    fs.chmodSync(permissionDestination, 0o600);
    assert.throws(
      () => applyCustomIconPlan(target, validatedSvg, {
        beforeSlot(_operation, index) {
          if (index === 1) throw new Error('injected permission rollback');
        },
      }),
      error => error.code === 'INCIPIT_CUSTOM_ICON_APPLY_FAILED',
    );
    assert.strictEqual(
      fs.statSync(permissionDestination).mode & 0o777,
      0o600,
      'rollback preserves the original icon file permissions',
    );
    fs.chmodSync(permissionDestination, originalMode);
  }

  for (const [name, bytes] of officialBytes) fs.writeFileSync(path.join(resourcesDir, name), bytes);
  assert.throws(
    () => applyCustomIconPlan(target, validatedSvg, {
      beforeSlot(_operation, index) {
        if (index === 1) {
          fs.writeFileSync(path.join(resourcesDir, CUSTOM_ICON_NAMES[0]), 'external-change');
          throw new Error('injected concurrent change');
        }
      },
    }),
    error => error.code === 'INCIPIT_CUSTOM_ICON_ROLLBACK_FAILED' && /changed during rollback/.test(error.message),
    'rollback refuses to overwrite a concurrent writer',
  );
  assert.strictEqual(
    fs.readFileSync(path.join(resourcesDir, CUSTOM_ICON_NAMES[0]), 'utf8'),
    'external-change',
    'a concurrent writer remains authoritative when rollback detects drift',
  );
  for (const [name, bytes] of officialBytes) fs.writeFileSync(path.join(resourcesDir, name), bytes);

  assert.throws(
    () => applyCustomIconPlan(target, validatedSvg, {
      beforeSlot(_operation, index) {
        if (index !== 1) return;
        const destination = path.join(resourcesDir, CUSTOM_ICON_NAMES[0]);
        const replacement = path.join(resourcesDir, '.external-same-bytes');
        fs.writeFileSync(replacement, expectedSvg.get(CUSTOM_ICON_NAMES[0]), { mode: 0o600 });
        fs.rmSync(destination);
        fs.renameSync(replacement, destination);
        throw new Error('injected same-byte identity replacement');
      },
    }),
    error => error.code === 'INCIPIT_CUSTOM_ICON_ROLLBACK_FAILED' && /changed during rollback/.test(error.message),
    'rollback distinguishes a concurrent same-byte replacement by file identity',
  );
  assert.deepStrictEqual(
    fs.readFileSync(path.join(resourcesDir, CUSTOM_ICON_NAMES[0])),
    expectedSvg.get(CUSTOM_ICON_NAMES[0]),
    'rollback does not overwrite a concurrent same-byte replacement with the official icon',
  );
  for (const [name, bytes] of officialBytes) fs.writeFileSync(path.join(resourcesDir, name), bytes);

  const originalUnlinkSync = fs.unlinkSync;
  let injectedNonFileWriter = false;
  try {
    fs.unlinkSync = function injectedUnlinkSync(targetPath) {
      if (!injectedNonFileWriter && String(targetPath).includes('.incipit-stage-')) {
        injectedNonFileWriter = true;
        const destination = path.join(resourcesDir, CUSTOM_ICON_NAMES[0]);
        originalUnlinkSync(destination);
        fs.mkdirSync(destination);
        const error = new Error('injected staging cleanup failure');
        error.code = 'EIO';
        throw error;
      }
      return originalUnlinkSync(targetPath);
    };
    assert.throws(
      () => applyCustomIconPlan(target, validatedSvg),
      error => error.code === 'INCIPIT_CUSTOM_ICON_ROLLBACK_FAILED' &&
        /changed during rollback/.test(error.message),
      'rollback never moves or deletes a concurrent non-file destination',
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  const nonFileWriterDestination = path.join(resourcesDir, CUSTOM_ICON_NAMES[0]);
  assert.ok(
    fs.lstatSync(nonFileWriterDestination).isDirectory(),
    'the concurrent directory remains at the authoritative destination',
  );
  assert.deepStrictEqual(
    fs.readdirSync(resourcesDir).filter(name => name.includes('.incipit-')),
    [],
    'the failed cleanup does not strand claim, abort, or stage files',
  );
  fs.rmSync(nonFileWriterDestination, { recursive: true, force: true });
  fs.writeFileSync(nonFileWriterDestination, officialBytes.get(CUSTOM_ICON_NAMES[0]));

  const originalRenameSync = fs.renameSync;
  let injectedClaimWriter = false;
  try {
    fs.renameSync = function injectedRenameSync(sourcePath, targetPath) {
      if (!injectedClaimWriter && sourcePath === nonFileWriterDestination &&
          String(targetPath).includes('.incipit-claim-')) {
        injectedClaimWriter = true;
        fs.unlinkSync(sourcePath);
        fs.mkdirSync(sourcePath);
      }
      return originalRenameSync(sourcePath, targetPath);
    };
    assert.throws(
      () => applyCustomIconPlan(target, validatedSvg),
      error => error.code === 'INCIPIT_CUSTOM_ICON_APPLY_FAILED' &&
        /not a regular file/.test(error.message),
      'a non-file replacement in the claim window is restored to its original path',
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.ok(
    fs.lstatSync(nonFileWriterDestination).isDirectory(),
    'the claim-window writer remains at the authoritative destination',
  );
  assert.deepStrictEqual(
    fs.readdirSync(resourcesDir).filter(name => name.includes('.incipit-')),
    [],
    'the claim-window failure cleans its private files',
  );
  fs.rmSync(nonFileWriterDestination, { recursive: true, force: true });
  fs.writeFileSync(nonFileWriterDestination, officialBytes.get(CUSTOM_ICON_NAMES[0]));

  assert.throws(
    () => applyCustomIconPlan(target, validatedSvg, {
      afterSlotCheck(_operation, index) {
        if (index === 0) {
          fs.writeFileSync(path.join(resourcesDir, CUSTOM_ICON_NAMES[0]), 'late-external-change');
        }
      },
    }),
    error => error.code === 'INCIPIT_CUSTOM_ICON_APPLY_FAILED' && /changed during apply/.test(error.message),
    'the commit-time CAS refuses a write that lands after the per-slot check',
  );
  assert.strictEqual(
    fs.readFileSync(path.join(resourcesDir, CUSTOM_ICON_NAMES[0]), 'utf8'),
    'late-external-change',
    'the late writer is not overwritten',
  );
  for (const [name, bytes] of officialBytes) fs.writeFileSync(path.join(resourcesDir, name), bytes);

  const missingPng = new Set([PNG_ICON_NAME]);
  const svgWithoutOfficialPng = validateCustomIconApplyInputs(
    svgPlan,
    restorePayloads(officialBytes, missingPng),
  );
  fs.rmSync(path.join(resourcesDir, PNG_ICON_NAME));
  assert.throws(
    () => applyCustomIconPlan(target, svgWithoutOfficialPng, {
      afterSlotCheck(operation) {
        if (operation.name === PNG_ICON_NAME) {
          fs.writeFileSync(path.join(resourcesDir, PNG_ICON_NAME), 'late-created-png');
        }
      },
    }),
    error => error.code === 'INCIPIT_CUSTOM_ICON_APPLY_FAILED' && /changed during apply/.test(error.message),
    'the delete branch refuses a file created after its per-slot check',
  );
  for (const name of CUSTOM_ICON_NAMES.filter(name => name !== PNG_ICON_NAME)) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(resourcesDir, name)),
      officialBytes.get(name),
      `${name} is rolled back when the late PNG create is detected`,
    );
  }
  assert.strictEqual(
    fs.readFileSync(path.join(resourcesDir, PNG_ICON_NAME), 'utf8'),
    'late-created-png',
    'the concurrently created PNG remains authoritative',
  );
  fs.writeFileSync(path.join(resourcesDir, PNG_ICON_NAME), officialBytes.get(PNG_ICON_NAME));

  const displacedResourcesDir = path.join(extensionDir, 'resources-before-race');
  const outsideResourcesDir = path.join(temp, 'outside-resources');
  seedOfficialIcons(outsideResourcesDir);
  const outsideBefore = new Map(CUSTOM_ICON_NAMES.map(name => [
    name,
    fs.readFileSync(path.join(outsideResourcesDir, name)),
  ]));
  let resourcesDisplaced = false;
  try {
    assert.throws(
      () => applyCustomIconPlan(target, validatedSvg, {
        afterSlotCheck(_operation, index) {
          if (index !== 0) return;
          fs.renameSync(resourcesDir, displacedResourcesDir);
          fs.symlinkSync(
            outsideResourcesDir,
            resourcesDir,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          resourcesDisplaced = true;
        },
      }),
      error => error.code === 'INCIPIT_CUSTOM_ICON_APPLY_FAILED' &&
        /resources directory changed during apply/.test(error.message),
      'a resources directory replacement cannot redirect the icon commit',
    );
    for (const [name, bytes] of outsideBefore) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(outsideResourcesDir, name)),
        bytes,
        `${name} outside the extension target must not be changed`,
      );
    }
  } finally {
    if (resourcesDisplaced) {
      fs.unlinkSync(resourcesDir);
      fs.renameSync(displacedResourcesDir, resourcesDir);
    }
  }

  const preflight = inspectCustomIconTarget(target);
  fs.writeFileSync(path.join(resourcesDir, CUSTOM_ICON_NAMES[0]), 'changed-after-preflight');
  assert.throws(
    () => applyCustomIconPlan(target, validatedSvg, {}, preflight),
    /changed after installer preflight/,
    'installer preflight fingerprints guard the delayed icon commit',
  );
  assert.strictEqual(
    fs.readFileSync(path.join(resourcesDir, CUSTOM_ICON_NAMES[0]), 'utf8'),
    'changed-after-preflight',
  );
  for (const [name, bytes] of officialBytes) fs.writeFileSync(path.join(resourcesDir, name), bytes);

  const nonFileName = CUSTOM_ICON_NAMES[0];
  fs.rmSync(path.join(resourcesDir, nonFileName));
  fs.mkdirSync(path.join(resourcesDir, nonFileName));
  assert.throws(
    () => inspectCustomIconTarget(target),
    /not a regular file/,
    'known destination-shape failures are rejected during installer preflight',
  );
  fs.rmSync(path.join(resourcesDir, nonFileName), { recursive: true, force: true });
  fs.writeFileSync(path.join(resourcesDir, nonFileName), officialBytes.get(nonFileName));

  const danglingTarget = path.join(temp, 'dangling-icon-target');
  const movedDanglingTarget = path.join(temp, 'dangling-icon-target-moved');
  fs.mkdirSync(danglingTarget);
  fs.rmSync(path.join(resourcesDir, nonFileName));
  fs.symlinkSync(
    danglingTarget,
    path.join(resourcesDir, nonFileName),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.renameSync(danglingTarget, movedDanglingTarget);
  assert.throws(
    () => inspectCustomIconTarget(target),
    /not a regular file/,
    'a dangling symlink is a present unsafe destination, not an absent slot',
  );
  fs.unlinkSync(path.join(resourcesDir, nonFileName));
  fs.writeFileSync(path.join(resourcesDir, nonFileName), officialBytes.get(nonFileName));

  fs.rmSync(path.join(resourcesDir, PNG_ICON_NAME));
  const missingReport = applyCustomIconPlan(target, svgWithoutOfficialPng);
  assert.strictEqual(missingReport.files.find(file => file.name === PNG_ICON_NAME).mode, 'official-restored');
  const expectedMissing = new Map(svgPlan.slots.map(slot => [slot.name, slot.bytes]));
  expectedMissing.set(PNG_ICON_NAME, null);
  assertSlotsEqual(resourcesDir, expectedMissing);
  assert.deepStrictEqual(
    fs.readdirSync(resourcesDir).filter(name => name.includes('.incipit-')),
    [],
    'all successful and failed icon transactions clean up private files',
  );

  assert.throws(
    () => validateCustomIconApplyInputs({ ...svgPlan, slots: svgPlan.slots.slice(0, 2) }, restorePayloads(officialBytes)),
    /does not cover the required slots/,
  );
  assert.throws(
    () => validateCustomIconApplyInputs(svgPlan, restorePayloads(officialBytes).slice(0, 3)),
    /does not cover all four slots/,
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('install custom icon tests passed');
