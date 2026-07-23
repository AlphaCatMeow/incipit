'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const install = require('../src/install');
const workbenchOverlay = require('../src/workbench-overlay');

const ROOT = path.resolve(__dirname, '..');
const sharedSource = fs.readFileSync(path.join(ROOT, 'data', 'enhance_shared.js'), 'utf8').replace(/\r\n/g, '\n');
const typographySource = fs.readFileSync(path.join(ROOT, 'data', 'enhance_typography.js'), 'utf8').replace(/\r\n/g, '\n');
const backupSource = fs.readFileSync(path.join(ROOT, 'src', 'backup.js'), 'utf8').replace(/\r\n/g, '\n');

function count(source, fragment) {
  return source.split(fragment).length - 1;
}

function balancedBlock(source, openingBrace) {
  let depth = 1;
  let quote = null;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('Unterminated JavaScript block in test fixture.');
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `found ${name}`);
  const opening = source.indexOf('{', start);
  const closing = balancedBlock(source, opening);
  return source.slice(start, closing + 1);
}

function evaluateSharedConfig(palette) {
  const start = sharedSource.indexOf('export const CFG =');
  const end = sharedSource.indexOf('\n\nexport const DEBUG', start);
  assert.ok(start >= 0 && end > start, 'found shared CFG initializer');
  const code = sharedSource.slice(start, end).replace('export const CFG', 'const CFG');
  return Function('globalThis', `${code}; return CFG;`)({
    __incipitConfig: { theme: { palette, bodyBold: true }, features: {}, language: 'en' },
  });
}

function evaluateAppVars(cfg) {
  const start = sharedSource.indexOf('const SOFT_PALETTE =');
  const end = sharedSource.indexOf('\n\nlet appVarApplyScheduled', start);
  assert.ok(start >= 0 && end > start, 'found shared palette/app-var block');
  const code = sharedSource.slice(start, end).replace('export const APP_VAR_OVERRIDES', 'const APP_VAR_OVERRIDES');
  return Function('CFG', `${code}; return APP_VAR_OVERRIDES;`)(cfg);
}

function createDocumentMock(existingNodes = []) {
  const nodes = new Map();
  const document = {
    head: {
      appendChild(node) {
        node.remove = () => nodes.delete(node.id);
        nodes.set(node.id, node);
      },
    },
    createElement() {
      return { id: '', rel: '', href: '', remove() { nodes.delete(this.id); } };
    },
    getElementById(id) {
      return nodes.get(id) || null;
    },
  };
  for (const entry of existingNodes) {
    const node = typeof entry === 'string'
      ? { id: entry, rel: 'stylesheet', href: entry }
      : { ...entry };
    document.head.appendChild(node);
  }
  return { document, nodes };
}

function evaluateInjectStyles(cfg, document) {
  const functionSource = extractFunction(sharedSource, 'injectStyles').replace('export function', 'function');
  return Function('CFG', 'document', 'assetURL', `${functionSource}; return injectStyles;`)(
    cfg,
    document,
    fileName => `asset://${fileName}`,
  );
}

const rootFiles = new Set(install.ROOT_WEBVIEW_FILES.map(([, target]) => target));
assert.ok(rootFiles.has('theme.css'), 'base theme is shipped');
assert.ok(rootFiles.has('warm-white-override.css'), 'warm-white override is shipped');
assert.ok(rootFiles.has('ink-black-override.css'), 'ink-black override is shipped');
assert.ok(backupSource.includes("'incipit-ink-black-link'"), 'backup marker scan recognizes the ink-black head link');

const anchor = '<link href="${H}" rel="stylesheet">';
const expectedHead = Object.freeze({
  'warm-black': { activeId: null, activeFile: null },
  'ink-black': { activeId: 'incipit-ink-black-link', activeFile: 'ink-black-override.css' },
  'warm-white': { activeId: 'incipit-warm-white-link', activeFile: 'warm-white-override.css' },
});
let staleHead = anchor +
  '<link id="claude-enhance-styles-link" href="old-theme.css" rel="stylesheet">' +
  '<link id="incipit-warm-white-link" href="old-warm.css" rel="stylesheet">' +
  '<link id="incipit-ink-black-link" href="old-ink.css" rel="stylesheet">';
for (const [palette, expected] of Object.entries(expectedHead)) {
  const [patched, status] = install.__test.patchExtensionHtmlHead(staleHead, { palette });
  assert.strictEqual(count(patched, 'id="claude-enhance-styles-link"'), 1, `${palette} has one base link`);
  assert.strictEqual(count(patched, 'id="incipit-warm-white-link"'), palette === 'warm-white' ? 1 : 0,
    `${palette} removes inactive warm-white links`);
  assert.strictEqual(count(patched, 'id="incipit-ink-black-link"'), palette === 'ink-black' ? 1 : 0,
    `${palette} removes inactive ink-black links`);
  if (expected.activeId) {
    assert.ok(patched.includes(expected.activeFile), `${palette} links its selected override file`);
  }
  assert.match(status, new RegExp(`\\(${palette}\\)`));
  const [again, againStatus] = install.__test.patchExtensionHtmlHead(patched, { palette });
  assert.strictEqual(again, patched, `${palette} head patch is byte-idempotent`);
  assert.match(againStatus, /已存在/);
}
const [invalidPaletteHead, invalidStatus] = install.__test.patchExtensionHtmlHead(staleHead, { palette: 'unknown' });
assert.ok(!invalidPaletteHead.includes('incipit-warm-white-link') && !invalidPaletteHead.includes('incipit-ink-black-link'));
assert.match(invalidStatus, /\(warm-black\)/, 'unknown palettes fail closed to the default');

const unknownRoute = install.__test.buildHostRouteContract(
  { version: '99.99.99' },
  'official extension bytes',
  'official webview bytes',
);
assert.strictEqual(unknownRoute.status, 'degraded');
const routeCarryingPreamble = install.__test.buildWebviewConfigPreamble(
  {},
  { palette: 'ink-black' },
  'en',
  [unknownRoute],
);
assert.deepStrictEqual(
  install.__test.buildHostRouteContract(
    { version: '99.99.99' },
    'incipit-patched extension bytes',
    routeCarryingPreamble + 'incipit-patched webview bytes',
  ),
  unknownRoute,
  'repeated apply retains the official host-route fingerprint instead of recording patched process state',
);

const monacoExpected = Object.freeze({
  'warm-black': ['incipit-github-dark', 'vs-dark'],
  'ink-black': ['incipit-ink-black', 'vs-dark'],
  'warm-white': ['incipit-github-light', 'vs'],
});
assert.deepStrictEqual(
  Object.keys(install.__test.MONACO_DIFF_THEMES).sort(),
  ['incipit-github-dark', 'incipit-github-light', 'incipit-ink-black'],
  'three Monaco diff themes are registered',
);
assert.strictEqual(install.__test.MONACO_DIFF_THEMES['incipit-ink-black'].colors['editor.background'], '#0a0b0b');
assert.strictEqual(install.__test.MONACO_DIFF_THEMES['incipit-ink-black'].colors['editorGutter.background'], '#0a0b0b');
assert.strictEqual(install.__test.MONACO_DIFF_THEMES['incipit-ink-black'].colors['editorLineNumber.foreground'], '#838484');
assert.deepStrictEqual(
  install.__test.MONACO_DIFF_THEMES['incipit-ink-black'].rules,
  install.__test.MONACO_DIFF_THEMES['incipit-github-dark'].rules,
  'ink-black keeps vs2015 syntax token colours',
);
for (const [palette, [ownedTheme, fallbackTheme]] of Object.entries(monacoExpected)) {
  const preamble = install.__test.buildWebviewConfigPreamble({}, { palette }, 'en', []);
  const context = { console: { warn() {} } };
  vm.runInNewContext(preamble, context);
  const registered = new Map();
  const monaco = { defineTheme(name, definition) { registered.set(name, definition); } };
  assert.strictEqual(context.__incipitPickMonacoDiffTheme(monaco), ownedTheme, `${palette} picks its owned Monaco theme`);
  assert.deepStrictEqual(Array.from(registered.keys()).sort(),
    ['incipit-github-dark', 'incipit-github-light', 'incipit-ink-black']);
  for (const [name, expectedDefinition] of Object.entries(install.__test.MONACO_DIFF_THEMES)) {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(registered.get(name))),
      expectedDefinition,
      `${palette} registers the complete ${name} definition`,
    );
  }
  assert.strictEqual(context.__incipitPickMonacoDiffTheme(monaco), ownedTheme,
    `${palette} keeps the registered theme on repeated setup`);
  assert.strictEqual(registered.size, 3, `${palette} registers Monaco themes once per namespace`);
  const secondRegistered = [];
  const secondMonaco = { defineTheme(name) { secondRegistered.push(name); } };
  assert.strictEqual(context.__incipitPickMonacoDiffTheme(secondMonaco), ownedTheme,
    `${palette} initializes a later Monaco namespace`);
  assert.deepStrictEqual(secondRegistered.sort(),
    ['incipit-github-dark', 'incipit-github-light', 'incipit-ink-black']);

  const fallbackContext = { console: { warn() {} } };
  vm.runInNewContext(preamble, fallbackContext);
  assert.strictEqual(fallbackContext.__incipitPickMonacoDiffTheme(null), fallbackTheme,
    `${palette} has a safe built-in Monaco fallback`);
}

const cfgContract = Object.freeze({
  'warm-black': ['#1f1f1e', '#f8f8f6', '#bcbcb9', false],
  'ink-black': ['#0a0b0b', '#fbfbfc', '#aaaaab', false],
  'warm-white': ['#f8f8f6', '#0d0d0d', '#797569', true],
});
const backgroundAppVars = Object.freeze([
  '--app-background',
  '--app-primary-background',
  '--app-root-background',
  '--app-secondary-background',
  '--app-tool-background',
  '--app-header-background',
  '--app-input-background',
  '--app-input-secondary-background',
  '--app-menu-background',
]);
const foregroundAppVars = Object.freeze([
  '--app-primary-foreground',
  '--app-input-foreground',
  '--app-input-secondary-foreground',
  '--app-menu-foreground',
]);
const secondaryAppVars = Object.freeze(['--app-secondary-foreground', '--app-secondary-text']);
for (const [palette, [background, foreground, secondary, bodyBold]] of Object.entries(cfgContract)) {
  const cfg = evaluateSharedConfig(palette);
  assert.strictEqual(cfg.palette, palette, `${palette} survives runtime normalization`);
  assert.strictEqual(cfg.bodyBold, bodyBold, `${palette} bodyBold scope`);
  const appVars = evaluateAppVars(cfg);
  assert.strictEqual(Object.keys(appVars).length, 16, `${palette} exposes the complete app-var contract`);
  for (const name of backgroundAppVars) assert.strictEqual(appVars[name], background, `${palette} ${name}`);
  for (const name of foregroundAppVars) assert.strictEqual(appVars[name], foreground, `${palette} ${name}`);
  for (const name of secondaryAppVars) assert.strictEqual(appVars[name], secondary, `${palette} ${name}`);
  assert.strictEqual(appVars['--app-monospace-font-family'], 'var(--incipit-code-font)');

  const { document, nodes } = createDocumentMock([
    { id: 'claude-enhance-styles-link', rel: 'alternate', href: 'asset://stale-base.css' },
    { id: 'incipit-warm-white-link', rel: 'alternate', href: 'asset://stale-warm.css' },
    { id: 'incipit-ink-black-link', rel: 'alternate', href: 'asset://stale-ink.css' },
  ]);
  evaluateInjectStyles(cfg, document)();
  assert.ok(nodes.has('claude-enhance-styles-link'), `${palette} runtime installs the base stylesheet`);
  assert.strictEqual(nodes.get('claude-enhance-styles-link').href, 'asset://theme.css',
    `${palette} repairs a stale base stylesheet URL`);
  assert.strictEqual(nodes.get('claude-enhance-styles-link').rel, 'stylesheet');
  assert.strictEqual(nodes.has('incipit-warm-white-link'), palette === 'warm-white');
  assert.strictEqual(nodes.has('incipit-ink-black-link'), palette === 'ink-black');
  if (palette === 'warm-white') {
    assert.strictEqual(nodes.get('incipit-warm-white-link').href, 'asset://warm-white-override.css');
    assert.strictEqual(nodes.get('incipit-warm-white-link').rel, 'stylesheet');
  }
  if (palette === 'ink-black') {
    assert.strictEqual(nodes.get('incipit-ink-black-link').href, 'asset://ink-black-override.css');
    assert.strictEqual(nodes.get('incipit-ink-black-link').rel, 'stylesheet');
  }
  const activeNodes = Array.from(nodes.values());
  evaluateInjectStyles(cfg, document)();
  assert.deepStrictEqual(Array.from(nodes.values()), activeNodes, `${palette} runtime style injection is idempotent`);
}
assert.strictEqual(evaluateSharedConfig('unsupported').palette, 'warm-black', 'runtime rejects unknown palettes');

const mermaidFunction = extractFunction(typographySource, 'mermaidThemeVariables');
function mermaidVariables(palette) {
  const paletteValues = Array.from({ length: 12 }, (_, index) => `#${String(index).padStart(6, '0')}`);
  return Function('CFG', 'MERMAID_GROUP_PALETTE', `${mermaidFunction}; return mermaidThemeVariables();`)(
    { palette },
    paletteValues,
  );
}
const inkMermaid = mermaidVariables('ink-black');
assert.strictEqual(inkMermaid.background, '#0a0b0b');
assert.strictEqual(inkMermaid.primaryColor, '#1c1d1e');
assert.strictEqual(inkMermaid.secondaryColor, '#232425');
assert.strictEqual(inkMermaid.primaryTextColor, '#fbfbfc');
assert.strictEqual(inkMermaid.lineColor, '#a8a8a9');
assert.strictEqual(inkMermaid.clusterBorder, '#555657');
assert.strictEqual(inkMermaid.activeTaskBorderColor, '#bd7a62');
assert.strictEqual(inkMermaid.doneTaskBorderColor, '#7cb27c');
assert.deepStrictEqual(
  {
    tertiaryColor: inkMermaid.tertiaryColor,
    edgeLabelBackground: inkMermaid.edgeLabelBackground,
    clusterBkg: inkMermaid.clusterBkg,
    noteBkgColor: inkMermaid.noteBkgColor,
    inverseText: inkMermaid.sequenceNumberColor,
    activeTaskBkgColor: inkMermaid.activeTaskBkgColor,
    doneTaskBkgColor: inkMermaid.doneTaskBkgColor,
    gridColor: inkMermaid.gridColor,
    commitLabelBackground: inkMermaid.commitLabelBackground,
  },
  {
    tertiaryColor: '#2a2b2c',
    edgeLabelBackground: '#1c1d1e',
    clusterBkg: '#232425',
    noteBkgColor: '#1c1d1e',
    inverseText: '#0a0b0b',
    activeTaskBkgColor: '#3a2c25',
    doneTaskBkgColor: '#1e2a1e',
    gridColor: '#555657',
    commitLabelBackground: '#232425',
  },
  'ink-black Mermaid uses the neutral surfaces while retaining semantic accent/done colours',
);
for (let index = 0; index < 12; index += 1) {
  assert.strictEqual(inkMermaid[`pie${index}`], `#${String(index).padStart(6, '0')}`,
    `ink-black retains Mermaid pie group ${index}`);
  if (index < 10) {
    assert.strictEqual(inkMermaid[`cScale${index}`], `#${String(index).padStart(6, '0')}`,
      `ink-black retains Mermaid class scale ${index}`);
  }
}
assert.strictEqual(mermaidVariables('warm-white').darkMode, false);
assert.strictEqual(mermaidVariables('warm-black').background, '#1f1f1e');
assert.match(typographySource, /'ink-black':\s*'hljs\/styles\/vs2015\.min\.css'/,
  'ink-black explicitly uses the dark vs2015 highlight palette');

const overlayContract = Object.freeze({
  'warm-black': ['#2c2c2a', '#f8f8f6', '#333330', '#f8f8f6', '0 2px 8px rgba(0, 0, 0, 0.22)'],
  'ink-black': ['#1a1b1c', '#fbfbfc', '#212121', '#fbfbfc', '0 2px 8px rgba(0, 0, 0, 0.22)'],
  'warm-white': ['#ffffff', '#0d0d0d', '#f8f8f6', '#0d0d0d', '0 3px 10px rgba(0, 0, 0, 0.16)'],
});
for (const [palette, [background, foreground, hoverBackground, hoverForeground, shadow]] of Object.entries(overlayContract)) {
  const visual = workbenchOverlay.__test.overlayVisualTheme({
    palette,
    bodyFontFamily: { css: "'Contract Face', serif" },
    bodyBold: palette === 'warm-white',
  });
  assert.strictEqual(visual.background, background, `${palette} Workbench overlay background`);
  assert.strictEqual(visual.foreground, foreground, `${palette} Workbench overlay foreground`);
  assert.strictEqual(visual.hoverBackground, hoverBackground, `${palette} Workbench overlay hover`);
  assert.strictEqual(visual.hoverForeground, hoverForeground, `${palette} Workbench overlay hover foreground`);
  assert.strictEqual(visual.shadow, shadow, `${palette} Workbench overlay shadow`);
  assert.strictEqual(
    visual.fontFamily,
    palette === 'warm-white' ? "'PaperReading', 'Contract Face', serif" : "'Contract Face', serif",
    `${palette} Workbench overlay font contract`,
  );
}
assert.deepStrictEqual(
  workbenchOverlay.__test.overlayVisualTheme({ palette: 'unsupported' }),
  workbenchOverlay.__test.overlayVisualTheme({ palette: 'warm-black' }),
  'unknown Workbench palettes fail closed to warm-black',
);

console.log('theme runtime palette contracts passed');
