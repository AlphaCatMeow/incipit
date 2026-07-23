'use strict';

const assert = require('assert');
const cp = require('child_process');
const fileDialog = require('../src/file-dialog');

function withExecFileSync(fake, run) {
  const original = cp.execFileSync;
  cp.execFileSync = fake;
  try { return run(); }
  finally { cp.execFileSync = original; }
}

function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try { return run(); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
}

assert.deepStrictEqual(
  fileDialog.__test.normalizeFileExtensions(['SVG', '.png', '.PNG', '../bad']),
  ['.png'],
  'only canonical dotted extensions are accepted by the picker filter',
);
assert.throws(() => fileDialog.__test.normalizeFileExtensions([]), /At least one/);

withExecFileSync((command, args) => {
  assert.strictEqual(command, 'powershell');
  const encoded = args[args.indexOf('-EncodedCommand') + 1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /System\.Windows\.Forms\.OpenFileDialog/);
  assert.match(script, /\*\.svg;\*\.png/);
  assert.match(script, /CheckFileExists = \$true/);
  return 'C:\\Icons\\mark.svg';
}, () => {
  assert.strictEqual(
    fileDialog.__test.pickFileWindows('Choose icon', ['.svg', '.png']),
    'C:\\Icons\\mark.svg',
  );
});

withExecFileSync(() => {
  const error = new Error('cancelled');
  error.status = 2;
  throw error;
}, () => {
  assert.strictEqual(fileDialog.__test.pickFileWindows('Choose icon', ['.svg']), null);
});

withExecFileSync((command, args) => {
  assert.strictEqual(command, 'osascript');
  assert.match(args[1], /choose file/);
  assert.match(args[1], /"svg", "png"/);
  return '/tmp/mark.png\n';
}, () => {
  assert.strictEqual(fileDialog.__test.pickFileMacOS('Choose icon', ['.svg', '.png']), '/tmp/mark.png');
});

withExecFileSync((command, args) => {
  assert.strictEqual(command, 'zenity');
  assert.ok(args.includes('--file-filter=SVG / PNG | *.svg *.png'));
  return '/tmp/mark.svg\n';
}, () => {
  assert.strictEqual(fileDialog.__test.pickFileZenity('Choose icon', ['.svg', '.png']), '/tmp/mark.svg');
});

withExecFileSync((command, args) => {
  assert.strictEqual(command, 'kdialog');
  assert.ok(args.includes('SVG / PNG (*.svg *.png)'));
  return '/tmp/mark.png\n';
}, () => {
  assert.strictEqual(fileDialog.__test.pickFileKDialog('Choose icon', ['.svg', '.png']), '/tmp/mark.png');
});

withPlatform('win32', () => withExecFileSync((command) => {
  if (command === 'where') return '';
  if (command === 'powershell') return 'C:\\Icons\\wrong.jpg';
  throw new Error(`unexpected command ${command}`);
}, () => {
  assert.throws(
    () => fileDialog.pickFile({ title: 'Choose icon', extensions: ['.svg', '.png'] }),
    /Unsupported file type: \.jpg/,
    'the backend result is checked even when the native dialog was filtered',
  );
}));

console.log('file-dialog tests passed');
