'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createBaseline,
  parseStylesheet,
  resolveValue,
  verifyBaseline,
} = require('./helpers/css-theme-oracle');

const ROOT = path.resolve(__dirname, '..');
const THEME_PATH = path.join(ROOT, 'data', 'theme.css');
const WARM_PATH = path.join(ROOT, 'data', 'warm-white-override.css');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'theme-colors-baseline.json');
const themeCss = fs.readFileSync(THEME_PATH, 'utf8');
const warmCss = fs.readFileSync(WARM_PATH, 'utf8');

if (process.argv.includes('--write-baseline')) {
  if (fs.existsSync(BASELINE_PATH) && process.env.INCIPIT_REPLACE_THEME_BASELINE !== '1') {
    throw new Error('Refusing to replace the frozen theme baseline without INCIPIT_REPLACE_THEME_BASELINE=1.');
  }
  const baseline = createBaseline(themeCss, warmCss, {
    generatedFrom: '2026-07-21 pre-tokenization worktree',
  });
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const result = verifyBaseline(themeCss, warmCss, baseline);
assert.ok(result.darkContracts > 1000, 'oracle covers the complete warm-black declaration surface');
assert.ok(result.warmWhiteContracts > result.darkContracts, 'warm-white includes the dark base plus overrides');

function mustFail(mutatedTheme, mutatedWarm, pattern) {
  assert.throws(() => verifyBaseline(mutatedTheme, mutatedWarm, baseline), pattern);
}

const mutatedDarkValue = themeCss.includes('--ink-text-primary:')
  ? themeCss.replace(/(--ink-text-primary\s*:\s*)[^;]+;/, '$1#010203;')
  : themeCss.replace(/(--app-primary-foreground\s*:\s*)#f8f8f6/i, '$1#010203');
assert.notStrictEqual(mutatedDarkValue, themeCss, 'dark value mutation fixture found');
mustFail(mutatedDarkValue, warmCss, /warm-black changed/);

const mutatedWarmValue = warmCss.includes('--ink-text-primary:')
  ? warmCss.replace(/(--ink-text-primary\s*:\s*)[^;]+;/, '$1#fefefe;')
  : warmCss.replace(/(--app-primary-foreground\s*:\s*)#0d0d0d/i, '$1#fefefe');
assert.notStrictEqual(mutatedWarmValue, warmCss, 'warm value mutation fixture found');
mustFail(themeCss, mutatedWarmValue, /warm-white changed/);

const mutatedSelector = themeCss.replace(
  '[data-incipit-messages-container]',
  '[data-incipit-messages-container-broken]',
);
assert.notStrictEqual(mutatedSelector, themeCss, 'selector mutation fixture found');
mustFail(mutatedSelector, warmCss, /declaration sequence changed|lost selector/);

const mutatedImportance = themeCss.replace(
  /(--app-background\s*:[^;]*?)\s*!important\s*;/i,
  '$1;',
);
assert.notStrictEqual(mutatedImportance, themeCss, '!important mutation fixture found');
mustFail(mutatedImportance, warmCss, /declaration sequence changed|important/);

const parserFixture = [
  '/* comment with { color:red; } */',
  ':root { --asset: url("data:image/svg+xml,<svg>{;}</svg>"); --tone: #abc; }',
  '@keyframes pulse { from { color: var(--tone); } to { color: #def; } }',
].join('\n');
const parsedFixture = parseStylesheet(parserFixture, 'parser-fixture.css');
assert.ok(parsedFixture.some(item => item.context === '@keyframes pulse' && item.selector === 'from'));
assert.ok(parsedFixture.some(item => item.property === '--asset' && item.value.includes('<svg>{;}</svg>')));
assert.strictEqual(resolveValue('var(--a, #fff)', new Map()), '#fff');
assert.throws(
  () => resolveValue('var(--a)', new Map([['--a', 'var(--b)'], ['--b', 'var(--a)']])),
  /Cyclic custom property reference/,
);

console.log(
  `theme color oracle passed (${result.darkContracts} dark / ${result.warmWhiteContracts} warm-white contracts)`,
);
