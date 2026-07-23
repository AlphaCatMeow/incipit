'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withIsolatedConfig(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-config-theme-icon-'));
  const originalHomedir = os.homedir;
  const modulePath = require.resolve('../src/config');
  os.homedir = () => home;
  delete require.cache[modulePath];
  try {
    return run(require('../src/config'), home);
  } finally {
    delete require.cache[modulePath];
    os.homedir = originalHomedir;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

withIsolatedConfig((config, home) => {
  assert.strictEqual(config.getTheme().palette, 'warm-black', 'warm-black remains the default');
  assert.deepStrictEqual(
    config.PALETTE_OPTIONS,
    ['warm-black', 'ink-black', 'warm-white'],
    'all three public palettes are accepted',
  );

  config.setPalette('ink-black');
  config.setBodyBold(true);
  assert.deepStrictEqual(
    { palette: config.getTheme().palette, bodyBold: config.getTheme().bodyBold },
    { palette: 'ink-black', bodyBold: false },
    'the warm-white body-weight option cannot leak into ink-black',
  );
  assert.throws(() => config.setPalette('black'), /Unsupported palette/);

  assert.deepStrictEqual(config.getCustomIcon(), {
    configured: false,
    sourcePath: null,
    status: 'official',
    errorCode: null,
  });

  const iconPath = path.join(home, 'My Icon.SVG');
  fs.writeFileSync(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>');
  config.setCustomIconPath(iconPath);
  assert.deepStrictEqual(config.getCustomIcon(), {
    configured: true,
    sourcePath: path.normalize(iconPath),
    status: 'ready',
    errorCode: null,
  });

  fs.unlinkSync(iconPath);
  assert.strictEqual(config.getCustomIcon().errorCode, 'missing', 'a stale path remains fail-visible');

  config.writeConfig({
    language: 'zh',
    targets: { lastUsed: 'kept', manual: [] },
    theme: { palette: 'warm-white' },
    features: { math: false },
    icon: { sourcePath: 'relative/icon.svg' },
  });
  assert.deepStrictEqual(
    config.getCustomIcon(),
    { configured: true, sourcePath: null, status: 'invalid', errorCode: 'invalid-path' },
    'malformed saved paths are diagnosed instead of becoming official silently',
  );

  config.resetConfigurable();
  const reset = config.readConfig();
  assert.strictEqual(reset.language, 'zh');
  assert.deepStrictEqual(reset.targets, { lastUsed: 'kept', manual: [] });
  assert.ok(!Object.prototype.hasOwnProperty.call(reset, 'theme'));
  assert.ok(!Object.prototype.hasOwnProperty.call(reset, 'features'));
  assert.ok(!Object.prototype.hasOwnProperty.call(reset, 'icon'));
});

console.log('config-theme-icon tests passed');
