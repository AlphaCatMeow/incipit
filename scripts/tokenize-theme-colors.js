'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildFinalMap,
  declarationKey,
  parseStylesheet,
  resolvedRecords,
  sha256,
  verifyBaseline,
} = require('../tests/helpers/css-theme-oracle');

const ROOT = path.resolve(__dirname, '..');
const THEME_PATH = path.join(ROOT, 'data', 'theme.css');
const WARM_PATH = path.join(ROOT, 'data', 'warm-white-override.css');
const INK_PATH = path.join(ROOT, 'data', 'ink-black-override.css');
const SOURCE_DIR = path.join(ROOT, 'scripts', 'theme-sources');
const FROZEN_THEME_PATH = path.join(SOURCE_DIR, 'theme.pre-tokenization.css');
const FROZEN_WARM_PATH = path.join(SOURCE_DIR, 'warm-white-override.pre-tokenization.css');
const BASELINE_PATH = path.join(ROOT, 'tests', 'fixtures', 'theme-colors-baseline.json');
const CSS_NAMED_COLORS = new Set(`
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
  blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue
  cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
  darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
  darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
  deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
  lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey
  lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey
  lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
  mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
  mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite
  navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
  rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell
  sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan
  teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
`.trim().split(/\s+/));
const COLOR_LITERAL_RE =
  /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\b[a-z]+\b/gi;

const CORE_TOKENS = Object.freeze([
  ['--ink-surface-canvas', '#1f1f1e', '#f8f8f6', '#0a0b0b'],
  ['--ink-surface-message-canvas', '#1e1e1e', '#f8f8f6', '#0a0b0b'],
  ['--ink-surface-raised', '#1a1a19', '#f4f2ec', '#141516'],
  ['--ink-surface-panel', '#2c2c2a', '#ffffff', '#1a1b1c'],
  ['--ink-surface-code', '#272727', '#e6e4de', '#1a1b1c'],
  ['--ink-surface-elevated', '#2c2c2a', '#ffffff', '#212121'],
  ['--ink-surface-recessed', '#121212', '#e6e4de', '#141516'],
  ['--ink-editor-bg', '#121212', '#e6e4de', '#0a0b0b'],
  ['--ink-text-primary', '#f8f8f6', '#0d0d0d', '#fbfbfc'],
  ['--ink-text-strong', '#f5f2e8', '#0d0d0d', '#fbfbfc'],
  ['--ink-text-secondary', '#bcbcb9', '#797569', '#aaaaab'],
  ['--ink-text-tool-secondary', '#9c9c9a', '#8c897e', '#aaaaab'],
  ['--ink-text-tertiary', '#989898', '#797569', '#838484'],
  ['--ink-text-quote', '#c3c2b7', '#797569', '#c7c6c7'],
  ['--ink-accent', '#d97757', '#bf5d3a', '#d97757'],
  ['--ink-accent-bright', '#e0a18b', '#8f452b', '#e0a18b'],
  ['--ink-accent-wash', 'rgba(217,119,87,0.22)', 'rgba(191,93,58,0.16)', 'rgba(217,119,87,0.20)'],
  ['--ink-accent-selection', 'rgba(217,119,87,0.32)', 'rgba(191,93,58,0.22)', 'rgba(217,119,87,0.32)'],
  ['--ink-accent-focus', 'rgba(217,119,87,0.6)', 'rgba(191,93,58,0.6)', 'rgba(217,119,87,0.6)'],
  ['--ink-accent-dim', '#bc8c75', '#bc8c75', '#bc8c75'],
  ['--ink-border-hairline', 'rgba(245, 242, 232, 0.10)', 'rgba(60,55,40,0.10)', 'rgba(255,255,255,0.10)'],
  ['--ink-border-strong', 'rgba(245, 242, 232, 0.16)', 'rgba(60,55,40,0.16)', 'rgba(255,255,255,0.16)'],
  ['--ink-border-divider', 'rgba(245, 242, 232, 0.06)', 'rgba(60,55,40,0.06)', 'rgba(255,255,255,0.08)'],
  ['--ink-rule', 'rgba(200,200,200,0.28)', 'rgba(150,145,130,0.30)', 'rgba(200,200,200,0.28)'],
  ['--ink-add-fg', '#7cb27c', '#1c9c1c', '#7cb27c'],
  ['--ink-del-fg', '#c96a6a', '#c92626', '#c96a6a'],
  ['--ink-add-bar', '#3fb950', '#1f883d', '#3fb950'],
  ['--ink-del-bar', '#f85149', '#cf222e', '#f85149'],
  ['--ink-add-line-bg', '#23863633', '#dafbe180', '#23863633'],
  ['--ink-del-line-bg', '#da363333', '#ffebe980', '#da363333'],
  ['--ink-add-char-bg', '#2ea04366', '#aceebb99', '#2ea04366'],
  ['--ink-del-char-bg', '#f8514966', '#ff818266', '#f8514966'],
  ['--ink-chip-bg', '#3d312d', '#ead8cf', '#3d312d'],
  ['--ink-chip-fg', '#e0a18b', '#8f452b', '#e0a18b'],
  ['--ink-chip-bg-hover', '#493932', '#e2c8bc', '#493932'],
  ['--ink-bubble-bg', '#121212', '#e6e4de', '#fbfbfc'],
  ['--ink-bubble-text', '#f5f2e8', '#0d0d0d', '#0a0b0b'],
  ['--ink-bubble-showmore', 'rgba(245, 242, 232, 0.62)', 'rgba(61,57,41,0.62)', '#0a0b0b'],
  ['--ink-bubble-showmore-hover', '#f5f2e8', '#0d0d0d', 'rgba(10,11,11,0.62)'],
  ['--ink-bubble-chip-bg', '#3d312d', '#ead8cf', '#ead8cf'],
  ['--ink-bubble-chip-fg', '#e0a18b', '#8f452b', '#8f452b'],
  ['--ink-bubble-chip-bg-hover', '#493932', '#e2c8bc', '#e2c8bc'],
  ['--ink-bubble-link-accent', '#d97757', '#bf5d3a', '#bf5d3a'],
  ['--ink-bubble-link-wash', 'rgba(217,119,87,0.22)', 'rgba(191,93,58,0.16)', 'rgba(191,93,58,0.16)'],
  ['--ink-composer-input-bg', '#2c2c2a', '#ffffff', '#212121'],
  ['--ink-composer-badge-label', '#f8f8f6', '#0d0d0d', '#fbfbfc'],
  ['--ink-composer-badge-value', '#989898', '#797569', '#838484'],
  ['--ink-send-bg', '#3d3b36', '#e6e4de', '#2c2c2d'],
  ['--ink-send-bg-hover', '#48463f', '#dddbd5', '#444445'],
  ['--ink-send-default-fg', '#f5f2e8', '#0d0d0d', '#f5f2e8'],
  ['--ink-scrollbar-thumb', '#3c3c3c', '#b0b0ae', '#2c2c2d'],
  ['--ink-scrollbar-thumb-hover', '#5a5a5a', '#8a8a88', '#444445'],
  ['--ink-scrollbar-thumb-active', '#6a6a6a', '#6f6f6d', '#555556'],
  ['--ink-scrollbar-track', 'transparent', 'transparent', 'transparent'],
  ['--ink-list-active-bg', '#121212', '#e6e4de', '#1a1b1c'],
  ['--ink-list-active-fg', '#f5f2e8', '#0d0d0d', '#fbfbfc'],
  ['--ink-list-hover-bg', '#1a1a19', '#f4f2ec', '#141516'],
  ['--ink-diff-surface', '#1f1f1e', '#fafaf5', '#0a0b0b'],
  ['--ink-diff-text', '#f0eee8', '#0d0d0d', '#fbfbfc'],
  ['--ink-diff-muted', '#9c9c9a', '#666258', '#838484'],
  ['--ink-diff-border', 'rgba(248, 246, 240, 0.12)', 'rgba(0, 0, 0, 0.10)', 'rgba(255,255,255,0.10)'],
  ['--ink-diff-divider', 'rgba(248, 246, 240, 0.10)', 'rgba(0, 0, 0, 0.08)', 'rgba(255,255,255,0.08)'],
  ['--ink-diff-shadow', 'rgba(0, 0, 0, 0.28)', 'rgba(60, 55, 40, 0.10)', 'rgba(0, 0, 0, 0.28)'],
  ['--ink-diff-header-bg', '#2a2a28', '#e6e4de', '#1a1b1c'],
  ['--ink-diff-header-text', '#d8d6ce', '#3f3d38', '#c7c6c7'],
  ['--ink-diff-header-border', 'rgba(248, 246, 240, 0.08)', 'rgba(31, 35, 40, 0.08)', 'rgba(255,255,255,0.08)'],
  ['--ink-diff-gradient-start', 'rgba(31, 31, 30, 0)', 'rgba(250, 250, 245, 0)', 'rgba(10,11,11,0)'],
  ['--ink-diff-overlay-hover', 'rgba(248, 246, 240, 0.045)', 'rgba(60, 55, 40, 0.055)', 'rgba(255,255,255,0.045)'],
  ['--ink-diff-button-bg', '#2c2c2a', '#fafaf5', '#1a1b1c'],
  ['--ink-diff-button-bg-hover', '#333330', '#f2f2eb', '#212121'],
  ['--ink-diff-button-text', '#f8f8f6', '#0d0d0d', '#fbfbfc'],
  ['--ink-diff-button-border', 'rgba(248, 246, 240, 0.14)', 'rgba(0, 0, 0, 0.12)', 'rgba(255,255,255,0.14)'],
  ['--ink-diff-add-border', 'rgba(124, 178, 124, 0.35)', 'rgba(40, 132, 55, 0.34)', 'rgba(124, 178, 124, 0.35)'],
  ['--ink-diff-del-border', 'rgba(201, 106, 106, 0.35)', 'rgba(176, 62, 54, 0.34)', 'rgba(201, 106, 106, 0.35)'],
  ['--ink-diff-overview', 'rgba(248, 246, 240, 0.04)', 'rgba(60, 55, 40, 0.045)', 'rgba(255,255,255,0.04)'],
]);

const CUSTOM_PROPERTY_ALIASES = Object.freeze({
  '--app-background': '--ink-surface-canvas',
  '--app-primary-background': '--ink-surface-canvas',
  '--app-root-background': '--ink-surface-canvas',
  '--app-secondary-background': '--ink-surface-canvas',
  '--app-tool-background': '--ink-surface-canvas',
  '--app-header-background': '--ink-surface-canvas',
  '--app-input-background': '--ink-surface-canvas',
  '--app-input-secondary-background': '--ink-surface-canvas',
  '--app-menu-background': '--ink-surface-canvas',
  '--app-primary-foreground': '--ink-text-primary',
  '--app-input-foreground': '--ink-text-primary',
  '--app-input-secondary-foreground': '--ink-text-primary',
  '--app-menu-foreground': '--ink-text-primary',
  '--app-secondary-foreground': '--ink-text-secondary',
  '--app-secondary-text': '--ink-text-secondary',
  '--incipit-message-mention-chip-background': '--ink-chip-bg',
  '--incipit-message-mention-chip-foreground': '--ink-chip-fg',
  '--incipit-message-mention-chip-background-hover': '--ink-chip-bg-hover',
  '--incipit-composer-mention-chip-background': '--ink-chip-bg',
  '--incipit-composer-mention-chip-foreground': '--ink-chip-fg',
  '--incipit-composer-mention-chip-background-hover': '--ink-chip-bg-hover',
  '--incipit-scrollbar-thumb': '--ink-scrollbar-thumb',
  '--incipit-scrollbar-thumb-hover': '--ink-scrollbar-thumb-hover',
  '--incipit-scrollbar-thumb-active': '--ink-scrollbar-thumb-active',
  '--incipit-scrollbar-track': '--ink-scrollbar-track',
  '--app-list-active-background': '--ink-list-active-bg',
  '--app-list-active-foreground': '--ink-list-active-fg',
  '--vscode-list-activeSelectionBackground': '--ink-list-active-bg',
  '--vscode-list-focusBackground': '--ink-list-active-bg',
  '--vscode-list-hoverBackground': '--ink-list-hover-bg',
});

function normalized(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, '');
}

function sameValue(left, right) {
  return normalized(left) === normalized(right);
}

function isColorLiteralMatch(value) {
  const normalizedMatch = String(value).toLowerCase();
  return normalizedMatch.startsWith('#') || normalizedMatch.includes('(') || CSS_NAMED_COLORS.has(normalizedMatch);
}

function containsLiteralColor(value) {
  COLOR_LITERAL_RE.lastIndex = 0;
  let match;
  while ((match = COLOR_LITERAL_RE.exec(value))) {
    if (isColorLiteralMatch(match[0])) return true;
  }
  return false;
}

function replaceLiteralColors(value, replacement) {
  COLOR_LITERAL_RE.lastIndex = 0;
  return value.replace(COLOR_LITERAL_RE, match => (
    isColorLiteralMatch(match) ? replacement(match) : match
  ));
}

function replaceRanges(source, replacements) {
  let output = source;
  for (const replacement of replacements.slice().sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return output;
}

function triples(core) {
  return { name: core[0], dark: core[1], warm: core[2], ink: core[3], core: true };
}

function compactColor(value) {
  return normalized(value);
}

function coreTokenFor(property, dark, warm, selector) {
  const prop = property.toLowerCase();
  const d = compactColor(dark);
  const w = compactColor(warm);
  const bubble = /user-bubble/.test(selector);
  const composer = /inputcontainer|composer/i.test(selector);
  const diff = /diff|monaco/i.test(selector);

  if (bubble && /^(background|background-color)$/.test(prop) && d === '#121212' && w === '#e6e4de') {
    return '--ink-bubble-bg';
  }
  if (bubble && prop === 'color' && d === '#f5f2e8' && w === '#0d0d0d') return '--ink-bubble-text';
  if (bubble && prop === 'color' && d === 'rgba(245,242,232,0.62)' && w === 'rgba(61,57,41,0.62)') {
    return '--ink-bubble-showmore';
  }
  if (composer && /^(background|background-color)$/.test(prop) && d === '#2c2c2a' && w === '#ffffff') {
    return '--ink-composer-input-bg';
  }
  if (/send-button/.test(selector) && /^(background|background-color)$/.test(prop) && d === '#3d3b36' && w === '#e6e4de') {
    return '--ink-send-bg';
  }
  if (/send-button/.test(selector) && /^(background|background-color)$/.test(prop) && d === '#48463f' && w === '#dddbd5') {
    return '--ink-send-bg-hover';
  }
  if (/send-button/.test(selector) && prop === 'color' && d === '#f5f2e8' && w === '#0d0d0d') {
    return '--ink-send-default-fg';
  }
  if (diff && /^(background|background-color)$/.test(prop) && d === '#121212' && w === '#e6e4de') {
    return '--ink-editor-bg';
  }
  const pairCandidates = [
    ['--ink-surface-message-canvas', ['background', 'background-color'], '#1e1e1e', '#f8f8f6'],
    ['--ink-surface-raised', ['background', 'background-color'], '#1a1a19', '#f4f2ec'],
    ['--ink-surface-panel', ['background', 'background-color'], '#2c2c2a', '#ffffff'],
    ['--ink-surface-code', ['background', 'background-color'], '#272727', '#e6e4de'],
    ['--ink-surface-recessed', ['background', 'background-color'], '#121212', '#e6e4de'],
    ['--ink-text-primary', ['color', 'fill', 'stroke'], '#f8f8f6', '#0d0d0d'],
    ['--ink-text-strong', ['color', 'fill', 'stroke'], '#f5f2e8', '#0d0d0d'],
    ['--ink-text-secondary', ['color', 'fill', 'stroke'], '#bcbcb9', '#797569'],
    ['--ink-text-tool-secondary', ['color', 'fill', 'stroke'], '#9c9c9a', '#8c897e'],
    ['--ink-text-tertiary', ['color', 'fill', 'stroke'], '#989898', '#797569'],
    ['--ink-text-quote', ['color'], '#c3c2b7', '#797569'],
    ['--ink-accent', ['color', 'background', 'background-color', 'border-color', 'fill', 'stroke'], '#d97757', '#bf5d3a'],
    ['--ink-accent-wash', ['background', 'background-color'], 'rgba(217,119,87,0.22)', 'rgba(191,93,58,0.16)'],
    ['--ink-accent-selection', ['background', 'background-color'], 'rgba(217,119,87,0.32)', 'rgba(191,93,58,0.22)'],
    ['--ink-accent-focus', ['outline', 'outline-color'], 'rgba(217,119,87,0.6)', 'rgba(191,93,58,0.6)'],
    ['--ink-rule', ['background', 'background-color'], 'rgba(200,200,200,0.28)', 'rgba(150,145,130,0.30)'],
    ['--ink-add-fg', ['color'], '#7cb27c', '#1c9c1c'],
    ['--ink-del-fg', ['color'], '#c96a6a', '#c92626'],
  ];
  for (const [name, properties, darkValue, warmValue] of pairCandidates) {
    if (properties.includes(prop) && d === compactColor(darkValue) && w === compactColor(warmValue)) return name;
  }
  return null;
}

function rgbaParts(value) {
  const match = normalized(value).match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
  return match ? match.slice(1) : null;
}

function inkColorFor(color, selector, property) {
  const value = normalized(color);
  const bubble = /user-bubble/.test(selector);
  const composer = /inputcontainer|composer/i.test(selector);
  if (/shadow/.test(property)) return color;
  if (bubble) {
    if (value === '#121212') return '#fbfbfc';
    if (['#f8f8f6', '#f5f2e8', '#e8e6dd', '#eae4d5'].includes(value)) return '#0a0b0b';
    if (value === '#d97757') return '#bf5d3a';
    const parts = rgbaParts(value);
    if (parts && ((parts[0] === '245' && parts[1] === '242') || (parts[0] === '248' && parts[1] === '248'))) {
      return `rgba(10,11,11,${parts[3]})`;
    }
  }
  const exact = new Map([
    ['#1e1e1e', '#0a0b0b'],
    ['#1f1f1e', '#1a1b1c'],
    ['#121212', '#141516'],
    ['#1a1a19', '#141516'],
    ['#2c2c2a', composer ? '#212121' : '#1a1b1c'],
    ['#272727', '#1a1b1c'],
    ['#302d2a', '#212121'],
    ['#333330', '#212121'],
    ['#3a3b3a', '#212121'],
    ['#f8f8f6', '#fbfbfc'],
    ['#f5f2e8', '#fbfbfc'],
    ['#e8e6dd', '#fbfbfc'],
    ['#eae4d5', '#fbfbfc'],
    ['#bcbcb9', '#aaaaab'],
    ['#9c9c9a', '#aaaaab'],
    ['#989898', '#838484'],
    ['#c3c2b7', '#c7c6c7'],
    ['#d8d6ce', '#c7c6c7'],
    ['#b3b0a8', '#aaaaab'],
    ['#b8b7ad', '#aaaaab'],
    ['#6a6a64', '#838484'],
    ['#a8896e', '#d97757'],
    ['#c8b19d', '#e0a18b'],
    ['#2f2f2c', '#1a1b1c'],
    ['#242421', '#212121'],
    ['rgba(220,210,190,0.30)', 'rgba(255,255,255,0.10)'],
    ['rgba(220,210,190,0.45)', 'rgba(255,255,255,0.16)'],
    ['rgba(195,194,183,0.74)', 'rgba(199,198,199,0.74)'],
  ]);
  if (exact.has(value)) return exact.get(value);
  const parts = rgbaParts(value);
  if (parts) {
    const [red, green, blue, alpha] = parts;
    if ((red === '245' && green === '242' && blue === '232') ||
        (red === '248' && green === '248' && blue === '246')) {
      return `rgba(251,251,252,${alpha})`;
    }
    if (red === '248' && green === '246' && blue === '240') {
      return `rgba(255,255,255,${alpha})`;
    }
    if (red === '168' && green === '137' && blue === '110') {
      return `rgba(217,119,87,${alpha})`;
    }
  }
  return color;
}

function inkValueFor(dark, selector, property) {
  if (/shadow/.test(property)) return dark;
  return replaceLiteralColors(dark, color => inkColorFor(color, selector, property));
}

// ---------------------------------------------------------------------------
// ink-black is a monochrome (black / white / grey) palette. Warm-black keeps
// its terracotta accent; ink-black replaces every orange / yellow / cream
// literal with a neutral grey while preserving diff add/delete greens and reds,
// error states, and the shared deep-black shadow contract. Only token.ink is
// rewritten, so warm-black and warm-white stay byte-for-byte identical.
// ---------------------------------------------------------------------------
const INK_ACCENT_HEX = new Map([
  ['#d97757', '#c2c4c7'],
  ['#e0a18b', '#dadce0'],
  ['#bc8c75', '#93959a'],
  ['#a8896e', '#c2c4c7'],
  ['#c8b19d', '#dadce0'],
]);
const INK_ACCENT_RGB = new Map([
  ['217,119,87', '194,196,199'],
  ['168,137,110', '194,196,199'],
]);
// #bf5d3a / #8f452b are the accent as it lands on the bright user-bubble
// island; there it must read as a dark grey, elsewhere as the light accent grey.
const INK_BUBBLE_HEX = new Map([['#bf5d3a', '#5a5c5f'], ['#8f452b', '#45474a']]);
const INK_ISLAND_HEX = new Map([['#bf5d3a', '#93959a'], ['#8f452b', '#93959a']]);
const INK_BUBBLE_RGB = new Map([['191,93,58', '90,92,95']]);
const INK_ISLAND_RGB = new Map([['191,93,58', '147,149,154']]);

function parseCssColor(text) {
  const value = text.trim().toLowerCase();
  let match = value.match(/^#([0-9a-f]{6})$/);
  if (match) { const n = parseInt(match[1], 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, alpha: null, form: 'hex6' }; }
  match = value.match(/^#([0-9a-f]{3})$/);
  if (match) { const s = match[1]; return { r: parseInt(s[0] + s[0], 16), g: parseInt(s[1] + s[1], 16), b: parseInt(s[2] + s[2], 16), alpha: null, form: 'hex3' }; }
  match = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})$/);
  if (match) { const n = parseInt(match[1], 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, alpha: match[2], form: 'hex8' }; }
  match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (match) return { r: +match[1], g: +match[2], b: +match[3], alpha: match[4] !== undefined ? match[4] : null, form: 'rgb' };
  return null;
}
function hueAndSaturation(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta === 0) return { hue: null, sat: 0 };
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, sat: delta / max };
}
function grayLevel(r, g, b) {
  return Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
}
function hex2(n) { return n.toString(16).padStart(2, '0'); }
function neutralizeInkLiteral(literal, tokenName) {
  const key = literal.trim().toLowerCase();
  if (INK_ACCENT_HEX.has(key)) return INK_ACCENT_HEX.get(key);
  const island = tokenName.includes('bubble');
  if (key === '#bf5d3a' || key === '#8f452b') return (island ? INK_BUBBLE_HEX : INK_ISLAND_HEX).get(key);
  const color = parseCssColor(literal);
  if (!color) return literal;
  const rgbKey = `${color.r},${color.g},${color.b}`;
  if (color.form === 'rgb') {
    if (rgbKey === '191,93,58') return `rgba(${(island ? INK_BUBBLE_RGB : INK_ISLAND_RGB).get(rgbKey)},${color.alpha})`;
    if (INK_ACCENT_RGB.has(rgbKey)) {
      const grey = INK_ACCENT_RGB.get(rgbKey);
      return color.alpha !== null ? `rgba(${grey},${color.alpha})` : `rgb(${grey})`;
    }
  }
  const { hue, sat } = hueAndSaturation(color.r, color.g, color.b);
  const warm = hue !== null && hue >= 12 && hue <= 75 && (sat >= 0.05 || color.r - color.b >= 6);
  if (!warm) return literal;
  const level = grayLevel(color.r, color.g, color.b);
  if (color.form === 'rgb') {
    return color.alpha !== null ? `rgba(${level},${level},${level},${color.alpha})` : `rgb(${level},${level},${level})`;
  }
  const grey = `#${hex2(level)}${hex2(level)}${hex2(level)}`;
  return color.form === 'hex8' ? grey + color.alpha : grey;
}
function neutralizeInkValue(tokenName, value) {
  // Error states keep their semantic red. Everything else — including the
  // accent tint that lives inside a few shadow layers — is greyed; the
  // deep-black drop-shadow layers are achromatic and pass through untouched.
  if (/error/.test(tokenName)) return value;
  return replaceLiteralColors(value, literal => neutralizeInkLiteral(literal, tokenName));
}

function kebab(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function componentFor(selector) {
  const dataNames = [...selector.matchAll(/data-incipit-([a-z0-9-]+)/g)].map(match => match[1]);
  if (dataNames.length) return kebab(dataNames[dataNames.length - 1]);
  const cce = [...selector.matchAll(/\.((?:cce|incipit)[A-Za-z0-9_-]+)/g)]
    .map(match => match[1].replace(/_[A-Za-z0-9]+$/, ''));
  if (cce.length) return kebab(cce[cce.length - 1]);
  const classParts = [...selector.matchAll(/class\*=["']([A-Za-z0-9_-]+)/g)]
    .map(match => kebab(match[1].split('_')[0]))
    .filter(name => !/^(container|wrapper|content|root)$/.test(name));
  if (classParts.length) return classParts[classParts.length - 1];
  const element = selector.match(/(?:^|[ >+~])([a-z][a-z0-9-]*)/i);
  return element ? kebab(element[1]) : 'surface';
}

function stateFor(selector) {
  const states = ['hover', 'focus-visible', 'focus-within', 'focus', 'active', 'disabled', 'checked', 'placeholder', 'before', 'after', 'selection'];
  return states.find(state => selector.toLowerCase().includes(`:${state}`)) || '';
}

function roleFor(property) {
  const roles = {
    color: 'fg',
    background: 'bg',
    'background-color': 'bg',
    'background-image': 'image',
    border: 'border',
    'border-color': 'border',
    'border-top': 'border-top',
    'border-right': 'border-right',
    'border-bottom': 'border-bottom',
    'border-left': 'border-left',
    'border-bottom-color': 'border-bottom',
    outline: 'outline',
    'outline-color': 'outline',
    'box-shadow': 'shadow',
    'text-shadow': 'text-shadow',
    fill: 'fill',
    stroke: 'stroke',
    'caret-color': 'caret',
  };
  return roles[property] || kebab(property);
}

function renderTokenBlock(tokens, palette, title) {
  const lines = [
    `/* ${title} */`,
    ':root {',
  ];
  for (const token of [...tokens.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`  ${token.name}: ${token[palette]};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

function recordsMap(finalMap) {
  return new Map(resolvedRecords(finalMap).map(record => [record.key, record]));
}

function removeEmptyRules(css) {
  let output = css;
  let changed = true;
  while (changed) {
    changed = false;
    const pattern = /(^|})([^{}]*?)\{([\s\r\n]*)\}/g;
    output = output.replace(pattern, (whole, boundary, prelude) => {
      if (!prelude.trim() || prelude.trim().startsWith('@font-face')) return whole;
      changed = true;
      return boundary;
    });
  }
  return output.replace(/\n{4,}/g, '\n\n\n');
}

function rewriteWarmWhiteHeader(css) {
  const legacyHeader = /\/\* ={20,}\n\s*Warm-white palette overrides[\s\S]*?={20,} \*\//;
  if (!legacyHeader.test(css)) {
    throw new Error('Could not locate the frozen warm-white palette header.');
  }
  return css.replace(legacyHeader, [
    '/* ============================================================',
    '   Warm-white palette — semantic tokens plus structural exceptions.',
    '',
    '   The complete colour palette lives in the generated :root block above.',
    '   Rules retained below are limited to warm-white-only typography and',
    '   cascade/geometry exceptions that cannot be represented by root tokens',
    '   without changing the frozen pre-tokenization rendering contract.',
    '   ============================================================ */',
  ].join('\n'));
}

/**
 * Read one of the immutable pre-tokenization stylesheets this generator consumes.
 *
 * The stylesheets under `data/` are outputs, never inputs: once a tokenization
 * result is committed, neither the worktree nor HEAD holds the pre-tokenization
 * bytes any more. The inputs therefore live beside this script and are pinned by
 * the baseline hash, which is also their identity check — a mismatch means the
 * frozen input drifted and every downstream golden-master comparison built on it
 * would silently compare against the wrong contract. Do not "fix" a mismatch by
 * re-recording the hash. 2026-07-22
 */
function frozenSource(frozenPath, expectedSha) {
  const source = fs.readFileSync(frozenPath, 'utf8');
  const actual = sha256(source);
  if (actual !== expectedSha) {
    throw new Error(
      `${path.relative(ROOT, frozenPath)} no longer matches its baseline hash `
        + `(expected ${expectedSha}, got ${actual}). This file is the frozen input to theme `
        + 'tokenization; restore it instead of editing it.',
    );
  }
  return source;
}

function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const themeCss = frozenSource(FROZEN_THEME_PATH, baseline.sources.themeSha256);
  const warmCss = frozenSource(FROZEN_WARM_PATH, baseline.sources.warmWhiteSha256);

  const themeDeclarations = parseStylesheet(themeCss, 'data/theme.css');
  const warmDeclarations = parseStylesheet(warmCss, 'data/warm-white-override.css');
  const warmFinal = buildFinalMap([themeDeclarations, warmDeclarations]);
  const groupedTheme = new Map();
  for (const declaration of themeDeclarations) {
    const key = `${declaration.valueStart}:${declaration.valueEnd}`;
    if (!groupedTheme.has(key)) groupedTheme.set(key, []);
    groupedTheme.get(key).push(declaration);
  }

  const tokens = new Map(CORE_TOKENS.map(core => [core[0], triples(core)]));
  const usedNames = new Set(tokens.keys());
  const themeReplacements = [];
  let tokenizedDeclarations = 0;

  function registerToken(preferredName, dark, warm, ink, source) {
    let name = preferredName;
    let suffix = 2;
    while (usedNames.has(name)) {
      const existing = tokens.get(name);
      if (existing && sameValue(existing.dark, dark) && sameValue(existing.warm, warm) && sameValue(existing.ink, ink)) {
        return name;
      }
      name = `${preferredName}-${suffix}`;
      suffix += 1;
    }
    const token = { name, dark, warm, ink, source, core: false };
    tokens.set(name, token);
    usedNames.add(name);
    return name;
  }

  for (const group of groupedTheme.values()) {
    const declaration = group[0];
    const alias = CUSTOM_PROPERTY_ALIASES[declaration.property];
    if (alias) {
      themeReplacements.push({
        start: declaration.valueStart,
        end: declaration.valueEnd,
        value: `var(${alias})`,
      });
      tokenizedDeclarations += 1;
      continue;
    }
    if (declaration.property.startsWith('--') || !containsLiteralColor(declaration.value) ||
        /^(src|font|font-family|font-variation-settings|content)$/.test(declaration.property) ||
        /url\(/i.test(declaration.value)) {
      continue;
    }
    const warmCandidates = group.map(member => warmFinal.get(declarationKey(member))).filter(Boolean);
    const canCollapse = warmCandidates.length === group.length &&
      warmCandidates.every(candidate => candidate.important === declaration.important) &&
      warmCandidates.every(candidate => sameValue(candidate.value, warmCandidates[0].value));
    const warmValue = canCollapse ? warmCandidates[0].value : declaration.value;
    const selector = declaration.selectorGroup;
    const coreName = coreTokenFor(declaration.property, declaration.value, warmValue, selector);
    let tokenName = coreName;
    if (!tokenName) {
      const state = stateFor(selector);
      const base = ['--ink', componentFor(selector), state, roleFor(declaration.property)].filter(Boolean).join('-');
      const inkValue = inkValueFor(declaration.value, selector, declaration.property);
      tokenName = registerToken(base, declaration.value, warmValue, inkValue, `${selector} { ${declaration.property} }`);
    }
    themeReplacements.push({ start: declaration.valueStart, end: declaration.valueEnd, value: `var(${tokenName})` });
    tokenizedDeclarations += 1;
  }

  let tokenBlockDark = renderTokenBlock(tokens, 'dark', 'Semantic colour tokens — warm-black (default palette).');
  let tokenBlockWarm = renderTokenBlock(tokens, 'warm', 'Semantic colour tokens — warm-white palette.');
  const transformedThemeBody = replaceRanges(themeCss, themeReplacements);
  let transformedTheme = tokenBlockDark + '\n' + transformedThemeBody;
  const baseWarmDeclarations = parseStylesheet(tokenBlockWarm, 'generated-warm-tokens.css');
  const transformedThemeDeclarations = parseStylesheet(transformedTheme, 'data/theme.css');
  const baseWarmMap = recordsMap(buildFinalMap([transformedThemeDeclarations, baseWarmDeclarations]));
  const expectedWarmMap = new Map(baseline.warmWhite.map(record => [record.key, record]));

  const groupedWarm = new Map();
  for (const declaration of warmDeclarations) {
    const key = `${declaration.statementStart}:${declaration.statementEnd}`;
    if (!groupedWarm.has(key)) groupedWarm.set(key, []);
    groupedWarm.get(key).push(declaration);
  }
  const removableWarmGroups = [];
  for (const group of groupedWarm.values()) {
    const declaration = group[0];
    const isAlias = Boolean(CUSTOM_PROPERTY_ALIASES[declaration.property]);
    if (!isAlias && (declaration.property.startsWith('--') || !containsLiteralColor(declaration.value))) continue;
    const covered = group.every(member => {
      const key = declarationKey(member);
      const actual = baseWarmMap.get(key);
      const expected = expectedWarmMap.get(key);
      return actual && expected && actual.important === expected.important && actual.resolved === expected.resolved;
    });
    if (!covered) continue;
    removableWarmGroups.push({
      id: `${declaration.statementStart}:${declaration.statementEnd}`,
      start: declaration.statementStart,
      end: declaration.statementEnd,
      members: group,
    });
  }

  const removedGroupIds = new Set(removableWarmGroups.map(group => group.id));
  let transformedWarm;
  let finalWarmBody;
  for (let pass = 0; pass < removableWarmGroups.length + 2; pass += 1) {
    const removals = removableWarmGroups
      .filter(group => removedGroupIds.has(group.id))
      .map(group => ({ start: group.start, end: group.end, value: '' }));
    finalWarmBody = removeEmptyRules(replaceRanges(warmCss, removals));
    transformedWarm = tokenBlockWarm + '\n' + finalWarmBody;
    const candidateDeclarations = parseStylesheet(transformedWarm, 'data/warm-white-override.css');
    const candidateMap = recordsMap(buildFinalMap([transformedThemeDeclarations, candidateDeclarations]));
    const mismatches = baseline.warmWhite.filter(expected => {
      const actual = candidateMap.get(expected.key);
      return !actual || actual.important !== expected.important || actual.resolved !== expected.resolved;
    });
    if (!mismatches.length) break;
    let restored = 0;
    for (const mismatch of mismatches) {
      const candidates = removableWarmGroups
        .filter(group => removedGroupIds.has(group.id) &&
          group.members.some(member => declarationKey(member) === mismatch.key))
        .sort((left, right) => right.start - left.start);
      if (!candidates.length) continue;
      removedGroupIds.delete(candidates[0].id);
      restored += 1;
    }
    if (!restored) {
      const mismatch = mismatches[0];
      const actual = candidateMap.get(mismatch.key);
      throw new Error(
        `Unable to preserve warm-white cascade for ${mismatch.key}: expected ${mismatch.resolved}, got ${actual ? actual.resolved : '<missing>'}.`,
      );
    }
  }

  const darkExpectedMap = new Map(baseline.dark.map(record => [record.key, record]));
  const retainedWarmDeclarations = parseStylesheet(finalWarmBody, 'warm-white-retained.css');
  const groupedRetainedWarm = new Map();
  for (const declaration of retainedWarmDeclarations) {
    const key = `${declaration.valueStart}:${declaration.valueEnd}`;
    if (!groupedRetainedWarm.has(key)) groupedRetainedWarm.set(key, []);
    groupedRetainedWarm.get(key).push(declaration);
  }
  const warmValueReplacements = [];
  let warmExceptionTokens = 0;
  for (const group of groupedRetainedWarm.values()) {
    const declaration = group[0];
    if (declaration.property.startsWith('--') || !containsLiteralColor(declaration.value) ||
        /^(src|font|font-family|font-variation-settings|content)$/.test(declaration.property) ||
        /url\(/i.test(declaration.value)) {
      continue;
    }
    const darkCandidates = group
      .map(member => darkExpectedMap.get(declarationKey(member)))
      .filter(Boolean);
    const darkValue = darkCandidates.length === group.length &&
      darkCandidates.every(candidate => candidate.resolved === darkCandidates[0].resolved)
      ? darkCandidates[0].resolved
      : declaration.value;
    const selector = declaration.selectorGroup;
    const state = stateFor(selector);
    const semanticBase = ['--ink', componentFor(selector), state, roleFor(declaration.property)]
      .filter(Boolean)
      .join('-');
    const inkValue = inkValueFor(darkValue, selector, declaration.property);
    const existing = tokens.get(semanticBase);
    const preferredName = existing &&
      sameValue(existing.dark, darkValue) &&
      sameValue(existing.warm, declaration.value) &&
      sameValue(existing.ink, inkValue)
      ? semanticBase
      : `${semanticBase}-override`;
    const tokenName = registerToken(preferredName, darkValue, declaration.value, inkValue,
      `${selector} { ${declaration.property} }`);
    warmValueReplacements.push({
      start: declaration.valueStart,
      end: declaration.valueEnd,
      value: `var(${tokenName})`,
    });
    warmExceptionTokens += 1;
  }

  finalWarmBody = rewriteWarmWhiteHeader(replaceRanges(finalWarmBody, warmValueReplacements));
  tokenBlockDark = renderTokenBlock(tokens, 'dark', 'Semantic colour tokens — warm-black (default palette).');
  tokenBlockWarm = renderTokenBlock(tokens, 'warm', 'Semantic colour tokens — warm-white palette.');
  transformedTheme = tokenBlockDark + '\n' + transformedThemeBody;
  transformedWarm = tokenBlockWarm + '\n' + finalWarmBody;
  verifyBaseline(transformedTheme, transformedWarm, baseline);

  // Collapse the ink palette to monochrome after the warm-black/warm-white
  // baseline is verified, so neither of those palettes is affected.
  for (const token of tokens.values()) token.ink = neutralizeInkValue(token.name, token.ink);

  const inkBlock = renderTokenBlock(tokens, 'ink', 'Semantic colour tokens — ink-black palette.');
  const inkCss = [
    '/* ink-black palette: neutral black surfaces with a bright user-message island. */',
    inkBlock.trimEnd(),
    '',
    ':root {',
    '  --incipit-mermaid-text: #fbfbfc;',
    '  --incipit-mermaid-muted: #c7c6c7;',
    '  --incipit-mermaid-inverse-text: #0a0b0b;',
    '  --incipit-mermaid-label-bg: #0a0b0b;',
    '  --incipit-mermaid-label-border: #555657;',
    '  --incipit-mermaid-surface: #1c1d1e;',
    '  --incipit-mermaid-surface-alt: #232425;',
    '  --incipit-mermaid-line: #a8a8a9;',
    '  --incipit-mermaid-line-muted: #555657;',
    '  --incipit-mermaid-accent: #c2c4c7;',
    '  --incipit-mermaid-accent-soft: #2f2f2f;',
    '  --incipit-mermaid-accent-border: #93959a;',
    '  --incipit-mermaid-done-soft: #1e2a1e;',
    '  --incipit-mermaid-done-border: #7cb27c;',
    '}',
    '',
    ':where(',
    '  [data-incipit-diff-island],',
    '  [data-incipit-write-diff],',
    '  [data-incipit-write-diff-modal-content],',
    '  [class*="diffEditorWrapper"],',
    '  [class*="modalContent_"]:has([class*="diffEditorContainer"])',
    ') {',
    '  --incipit-diff-surface: var(--ink-diff-surface);',
    '  --incipit-diff-text: var(--ink-diff-text);',
    '  --incipit-diff-muted: var(--ink-diff-muted);',
    '  --incipit-diff-border: var(--ink-diff-border);',
    '  --incipit-diff-divider: var(--ink-diff-divider);',
    '  --incipit-diff-shadow: var(--ink-diff-shadow);',
    '  --incipit-diff-header-bg: var(--ink-diff-header-bg);',
    '  --incipit-diff-header-text: var(--ink-diff-header-text);',
    '  --incipit-diff-header-border: var(--ink-diff-header-border);',
    '  --incipit-diff-gradient-start: var(--ink-diff-gradient-start);',
    '  --incipit-diff-overlay-hover: var(--ink-diff-overlay-hover);',
    '  --incipit-diff-button-bg: var(--ink-diff-button-bg);',
    '  --incipit-diff-button-bg-hover: var(--ink-diff-button-bg-hover);',
    '  --incipit-diff-button-text: var(--ink-diff-button-text);',
    '  --incipit-diff-button-border: var(--ink-diff-button-border);',
    '  --incipit-diff-add-fg: var(--ink-add-fg);',
    '  --incipit-diff-del-fg: var(--ink-del-fg);',
    '  --incipit-diff-add-line: var(--ink-add-line-bg);',
    '  --incipit-diff-del-line: var(--ink-del-line-bg);',
    '  --incipit-diff-add-char: var(--ink-add-char-bg);',
    '  --incipit-diff-del-char: var(--ink-del-char-bg);',
    '  --incipit-diff-add-border: var(--ink-diff-add-border);',
    '  --incipit-diff-del-border: var(--ink-diff-del-border);',
    '  --incipit-diff-add-bar: var(--ink-add-bar);',
    '  --incipit-diff-del-bar: var(--ink-del-bar);',
    '  --incipit-diff-overview: var(--ink-diff-overview);',
    '  --incipit-diff-scrollbar-track-x: var(--ink-diff-header-bg);',
    '  --incipit-diff-scrollbar-track-y: var(--ink-diff-surface);',
    '  --incipit-diff-scrollbar-thumb: var(--ink-scrollbar-thumb);',
    '  --incipit-diff-scrollbar-thumb-hover: var(--ink-scrollbar-thumb-hover);',
    '  --incipit-diff-scrollbar-thumb-active: var(--ink-scrollbar-thumb-active);',
    '  --vscode-editorLineNumber-foreground: var(--ink-text-tertiary);',
    '  --vscode-editorLineNumber-activeForeground: var(--ink-text-quote);',
    '}',
    '',
    '[data-incipit-user-bubble] {',
    '  background: var(--ink-bubble-bg) !important;',
    '  background-color: var(--ink-bubble-bg) !important;',
    '  color: var(--ink-bubble-text) !important;',
    '  --ink-markdown-root-image: radial-gradient(circle, var(--ink-bubble-link-accent) 1px, transparent 1.6px);',
    '}',
    '',
    '[data-incipit-user-bubble] [data-mention-chip],',
    '[data-incipit-user-bubble] [class*="mentionChip"] {',
    '  --incipit-message-mention-chip-background: var(--ink-bubble-chip-bg);',
    '  --incipit-message-mention-chip-foreground: var(--ink-bubble-chip-fg);',
    '  --incipit-message-mention-chip-background-hover: var(--ink-bubble-chip-bg-hover);',
    '}',
    '',
    '[data-incipit-user-bubble] a {',
    '  color: var(--ink-bubble-text) !important;',
    '  text-decoration-color: var(--ink-bubble-link-accent) !important;',
    '}',
    '',
    '[data-incipit-user-bubble] a:hover {',
    '  background-color: var(--ink-bubble-link-wash) !important;',
    '}',
    '',
    '[data-incipit-user-bubble] code {',
    '  background: transparent !important;',
    '  color: inherit !important;',
    '}',
    '',
    '[data-incipit-user-bubble] .claude-show-more-btn {',
    '  color: var(--ink-bubble-showmore);',
    '}',
    '',
    '[data-incipit-user-bubble] .claude-show-more-btn:hover {',
    '  color: var(--ink-bubble-showmore-hover);',
    '}',
    '',
    '[class*="inputContainer_"] [class*="inputContainerBackground"] {',
    '  background: var(--ink-composer-input-bg) !important;',
    '  background-color: var(--ink-composer-input-bg) !important;',
    '  border-color: transparent !important;',
    '}',
    '',
    '[class*="inputContainer_"]:hover,',
    '[class*="inputContainer_"]:focus,',
    '[class*="inputContainer_"]:focus-within {',
    '  border-color: transparent !important;',
    '  outline: none !important;',
    '}',
    '',
    '.cceBadgeLabel,',
    '.cceBadgeIcon {',
    '  color: var(--ink-composer-badge-label) !important;',
    '}',
    '',
    '.cceBadgeVal {',
    '  color: var(--ink-composer-badge-value) !important;',
    '}',
    '',
  ].join('\n');

  const stats = {
    tokens: tokens.size,
    tokenizedDeclarations,
    warmDeclarationsRemoved: removedGroupIds.size,
    warmDeclarationsRetainedForCascade: removableWarmGroups.length - removedGroupIds.size,
    warmExceptionTokens,
    themeBytesBefore: Buffer.byteLength(themeCss),
    themeBytesAfter: Buffer.byteLength(transformedTheme),
    warmBytesBefore: Buffer.byteLength(warmCss),
    warmBytesAfter: Buffer.byteLength(transformedWarm),
  };
  console.log(JSON.stringify(stats, null, 2));
  const outputs = [
    [THEME_PATH, transformedTheme.replace(/\r\n/g, '\n')],
    [WARM_PATH, transformedWarm.replace(/\r\n/g, '\n')],
    [INK_PATH, inkCss.replace(/\r\n/g, '\n')],
  ];
  if (process.argv.includes('--check')) {
    for (const [filePath, expected] of outputs) {
      const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n') : '';
      if (actual !== expected) {
        throw new Error(`${path.relative(ROOT, filePath)} is not the reproducible tokenized output. Run this script with --apply.`);
      }
    }
    console.log('theme token outputs are reproducible');
    return;
  }
  if (!process.argv.includes('--apply')) return;
  for (const [filePath, output] of outputs) fs.writeFileSync(filePath, output);
}

main();
