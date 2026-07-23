'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseStylesheet,
  resolveValue,
} = require('./helpers/css-theme-oracle');

const ROOT = path.resolve(__dirname, '..');
const CSS_PATHS = Object.freeze({
  dark: path.join(ROOT, 'data', 'theme.css'),
  warm: path.join(ROOT, 'data', 'warm-white-override.css'),
  ink: path.join(ROOT, 'data', 'ink-black-override.css'),
});
const css = Object.fromEntries(Object.entries(CSS_PATHS).map(([name, filePath]) => (
  [name, fs.readFileSync(filePath, 'utf8')]
)));
const declarations = Object.fromEntries(Object.entries(css).map(([name, source]) => (
  [name, parseStylesheet(source, path.relative(ROOT, CSS_PATHS[name]))]
)));

const RAW_COLOR_RE = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\b(?:white|black|red|blue|green|gray|grey)\b/i;

function rawColorDeclarations(parsed) {
  return parsed.filter(declaration => (
    !declaration.property.startsWith('--') &&
    !/^(src|content)$/.test(declaration.property) &&
    !/url\(/i.test(declaration.value) &&
    RAW_COLOR_RE.test(declaration.value)
  ));
}

function assertNoRawDeclarationColors(source, label) {
  const hits = rawColorDeclarations(parseStylesheet(source, `${label}.css`));
  assert.deepStrictEqual(
    hits.map(hit => `${hit.line}:${hit.selector}{${hit.property}:${hit.value}}`),
    [],
    `${label} ordinary declarations must consume semantic custom properties`,
  );
}

function rootEnvironment(parsed) {
  const environment = new Map();
  for (const declaration of parsed) {
    if (declaration.context === '' && declaration.selector === ':root' && declaration.property.startsWith('--')) {
      environment.set(declaration.property, declaration.value);
    }
  }
  return environment;
}

function themeTokens(parsed) {
  return new Map([...rootEnvironment(parsed)].filter(([name]) => name.startsWith('--ink-')));
}

function sortedKeys(map) {
  return [...map.keys()].sort();
}

function assertCompleteTokenSets(sources) {
  const parsed = Object.fromEntries(Object.entries(sources).map(([name, source]) => (
    [name, parseStylesheet(source, `${name}.css`)]
  )));
  const maps = Object.fromEntries(Object.entries(parsed).map(([name, items]) => [name, themeTokens(items)]));
  assert.deepStrictEqual(sortedKeys(maps.warm), sortedKeys(maps.dark), 'warm-white defines the complete semantic token set');
  assert.deepStrictEqual(sortedKeys(maps.ink), sortedKeys(maps.dark), 'ink-black defines the complete semantic token set');
  for (const [palette, map] of Object.entries(maps)) {
    for (const [name, value] of map) {
      assert.doesNotThrow(() => resolveValue(value, map), `${palette} token ${name} resolves without a cycle`);
    }
  }
  return maps;
}

function combinedRootEnvironment(...parsedStylesheets) {
  const environment = new Map();
  for (const parsed of parsedStylesheets) {
    for (const [name, value] of rootEnvironment(parsed)) environment.set(name, value);
  }
  return environment;
}

function scopedEnvironment(parsed, selector, root) {
  const environment = new Map(root);
  for (const declaration of parsed) {
    if (declaration.context === '' && declaration.selector === selector && declaration.property.startsWith('--')) {
      environment.set(declaration.property, declaration.value);
    }
  }
  return environment;
}

function resolvedCustomProperty(environment, name) {
  assert.ok(environment.has(name), `custom property ${name} exists`);
  return resolveValue(environment.get(name), environment);
}

function declarationValue(parsed, selector, property, environment) {
  const hit = parsed.find(item => item.context === '' && item.selector === selector && item.property === property);
  assert.ok(hit, `${selector} declares ${property}`);
  return resolveValue(hit.value, environment);
}

for (const [palette, source] of Object.entries(css)) assertNoRawDeclarationColors(source, palette);
assert.throws(
  () => assertNoRawDeclarationColors(`${css.dark}\n.token-regression { color: #010203; }\n`, 'mutation'),
  /ordinary declarations must consume semantic custom properties/,
  'raw declaration mutation is rejected',
);

const tokenMaps = assertCompleteTokenSets(css);
const missingInkToken = css.ink.replace(/^[ \t]*--ink-text-primary\s*:[^;]+;[ \t]*$/m, '');
assert.notStrictEqual(missingInkToken, css.ink, 'missing-token mutation fixture found');
assert.throws(
  () => assertCompleteTokenSets({ dark: css.dark, warm: css.warm, ink: missingInkToken }),
  /ink-black defines the complete semantic token set/,
  'missing palette token mutation is rejected',
);

for (const source of Object.values(css)) {
  for (const match of source.matchAll(/var\((--ink-[a-z0-9-]+)/gi)) {
    for (const [palette, map] of Object.entries(tokenMaps)) {
      assert.ok(map.has(match[1]), `${palette} defines referenced token ${match[1]}`);
    }
  }
}
assert.ok(!sortedKeys(tokenMaps.dark).some(name => /_[a-z0-9]+$/i.test(name) || /yumwmq/i.test(name)),
  'semantic token names never capture host CSS-module hashes');

const coreContract = Object.freeze({
  dark: {
    '--ink-surface-canvas': '#1f1f1e',
    '--ink-text-primary': '#f8f8f6',
    '--ink-accent': '#d97757',
  },
  warm: {
    '--ink-surface-canvas': '#f8f8f6',
    '--ink-text-primary': '#0d0d0d',
    '--ink-accent': '#bf5d3a',
  },
  ink: {
    '--ink-surface-canvas': '#0a0b0b',
    '--ink-surface-panel': '#1a1b1c',
    '--ink-surface-elevated': '#212121',
    '--ink-text-primary': '#fbfbfc',
    '--ink-text-secondary': '#aaaaab',
    '--ink-text-tertiary': '#838484',
    '--ink-text-quote': '#c7c6c7',
    '--ink-accent': '#c2c4c7',
    '--ink-bubble-bg': '#fbfbfc',
    '--ink-bubble-text': '#0a0b0b',
    '--ink-composer-input-bg': '#212121',
  },
});
for (const [palette, expected] of Object.entries(coreContract)) {
  for (const [name, value] of Object.entries(expected)) {
    assert.strictEqual(resolvedCustomProperty(tokenMaps[palette], name), value, `${palette} ${name}`);
  }
}

// ink-black shares warm-black's shadow geometry: the deep-black drop-shadow
// layers must stay identical. Full-string equality no longer holds because the
// accent tint warm-black bakes into a few shadows is greyed out in ink-black
// (ink-black is monochrome), so compare the black layers structurally.
function blackShadowLayers(value) {
  return (value.match(/rgba?\(\s*0\s*,\s*0\s*,\s*0[^)]*\)/gi) || []).map(layer => layer.replace(/\s+/g, ''));
}
for (const name of sortedKeys(tokenMaps.dark).filter(token => /shadow/.test(token))) {
  assert.deepStrictEqual(
    blackShadowLayers(resolveValue(tokenMaps.ink.get(name), tokenMaps.ink)),
    blackShadowLayers(resolveValue(tokenMaps.dark.get(name), tokenMaps.dark)),
    `ink-black preserves the warm-black deep-black drop shadow for ${name}`,
  );
}

// ink-black is monochrome: no --ink token may carry an orange / yellow / cream
// tint (hue 12deg-75deg). Diff add/delete greens & reds and error states are
// semantic and exempt; so is the shared deep-black shadow contract.
function parseInkColor(literal) {
  const value = literal.trim().toLowerCase();
  let match = value.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (match) { const n = parseInt(match[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  match = value.match(/^#([0-9a-f]{3})$/);
  if (match) { const s = match[1]; return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]; }
  match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (match) return [+match[1], +match[2], +match[3]];
  return null;
}
function isWarmTinted(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta === 0) return false;
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  const sat = delta / max;
  return hue >= 12 && hue <= 75 && (sat >= 0.06 || r - b >= 6);
}
for (const [name, value] of tokenMaps.ink) {
  if (/error/.test(name)) continue;
  const resolved = resolveValue(value, tokenMaps.ink);
  const literals = resolved.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || [];
  for (const literal of literals) {
    const rgb = parseInkColor(literal);
    assert.ok(
      !rgb || !isWarmTinted(...rgb),
      `ink-black stays monochrome: ${name} carries a warm literal ${literal}`,
    );
  }
}

const inkRoot = combinedRootEnvironment(declarations.dark, declarations.ink);
for (const [name, value] of Object.entries({
  '--incipit-scrollbar-thumb': '#2c2c2d',
  '--incipit-scrollbar-thumb-hover': '#444445',
  '--incipit-scrollbar-thumb-active': '#555556',
  '--incipit-scrollbar-track': 'transparent',
  '--incipit-mermaid-text': '#fbfbfc',
  '--incipit-mermaid-muted': '#c7c6c7',
  '--incipit-mermaid-surface': '#1c1d1e',
  '--incipit-mermaid-surface-alt': '#232425',
  '--incipit-mermaid-line': '#a8a8a9',
  '--incipit-mermaid-line-muted': '#555657',
})) {
  assert.strictEqual(resolvedCustomProperty(inkRoot, name), value, `ink-black resolves ${name}`);
}

const diffSelector = ':where([data-incipit-diff-island],[data-incipit-write-diff],[data-incipit-write-diff-modal-content],[class*="diffEditorWrapper"],[class*="modalContent_"]:has([class*="diffEditorContainer"]))';
const diffEnvironment = scopedEnvironment(declarations.ink, diffSelector, inkRoot);
for (const [name, value] of Object.entries({
  '--incipit-diff-surface': '#0a0b0b',
  '--incipit-diff-text': '#fbfbfc',
  '--incipit-diff-muted': '#838484',
  '--incipit-diff-header-bg': '#1a1b1c',
  '--incipit-diff-add-line': '#23863633',
  '--incipit-diff-del-line': '#da363333',
  '--vscode-editorlinenumber-foreground': '#838484',
})) {
  assert.strictEqual(resolvedCustomProperty(diffEnvironment, name), value, `ink-black diff resolves ${name}`);
}

assert.strictEqual(
  declarationValue(declarations.ink, '[data-incipit-user-bubble] .claude-show-more-btn', 'color', inkRoot),
  '#0a0b0b',
  'bright bubble show-more text flips dark',
);
assert.strictEqual(
  declarationValue(declarations.ink, '[data-incipit-user-bubble] .claude-show-more-btn:hover', 'color', inkRoot),
  'rgba(10,11,11,0.62)',
  'bright bubble show-more hover stays readable',
);
assert.strictEqual(
  declarationValue(declarations.ink, '.cceBadgeVal', 'color', inkRoot),
  '#838484',
  'composer metric value uses the tertiary ink tone',
);
// Host-owned composer footer icons (attach / slash / eye) stay the host's own
// tint in every palette — ink-black must not recolour them, matching warm-black
// and warm-white. A pure-white override read as a halo on the dark ink surface.
const footerIconSelector = '[data-incipit-input-footer] button:not([data-incipit-send-button]):not([class*="sendButton"]):not(.cceBadge):not(.cceNoteBtn)';
for (const [palette, parsed] of Object.entries(declarations)) {
  const hit = parsed.find(item => (
    item.selector === footerIconSelector && ['color', 'fill', 'stroke'].includes(item.property)
  ));
  assert.ok(!hit, `${palette} leaves host-owned composer footer icons to the host without recolouring`);
}

console.log(`theme token contracts passed (${tokenMaps.dark.size} semantic tokens across 3 palettes)`);
