'use strict';

const assert = require('assert');
const vm = require('vm');

const { __test } = require('../src/install');

const CLASSIC_COMPONENT = 'code:({children:c,className:d})=>{if(d)return R.default.createElement("code",{className:d},c);let u=String(c);if(u.includes("★")&&u.includes("Insight"))return R.default.createElement("code",{className:S.insightHeader},c);if(/^─{20,}$/.test(u.trim()))return R.default.createElement("code",{className:S.insightFooter},c);return R.default.createElement("code",null,c)}';
const JSX_COMPONENT = 'code:({children:c,className:d})=>{if(d)return b("code",{className:d,children:c});let u=String(c);if(u.includes("★")&&u.includes("Insight"))return b("code",{className:S.insightHeader,children:c});if(/^─{20,}$/.test(u.trim()))return b("code",{className:S.insightFooter,children:c});return b("code",{children:c})}';

const CLASSIC_SOURCE = `const components={${CLASSIC_COMPONENT},img:()=>null};globalThis.__component=components.code;`;
const JSX_SOURCE = `const components={${JSX_COMPONENT},img:()=>null};globalThis.__component=components.code;`;

const CLASSIC_EXPECTED = 'const components={code:({children:c,className:d})=>{let u=String(c),__incipitHtml;if(d){__incipitHtml=window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(u,d);if(__incipitHtml!==null&&__incipitHtml!==void 0)return R.default.createElement("code",{className:d+" hljs",dangerouslySetInnerHTML:{__html:__incipitHtml}});return R.default.createElement("code",{className:d},c)}if(u.indexOf("\\n")!==-1){__incipitHtml=window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(u,"");if(__incipitHtml!==null&&__incipitHtml!==void 0)return R.default.createElement("code",{className:"hljs",dangerouslySetInnerHTML:{__html:__incipitHtml}})}if(u.includes("★")&&u.includes("Insight"))return R.default.createElement("code",{className:S.insightHeader},c);if(/^─{20,}$/.test(u.trim()))return R.default.createElement("code",{className:S.insightFooter},c);return R.default.createElement("code",null,c)},img:()=>null};globalThis.__component=components.code;';
const JSX_EXPECTED = 'const components={code:({children:c,className:d})=>{let u=String(c),__incipitHtml;if(d){__incipitHtml=window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(u,d);if(__incipitHtml!==null&&__incipitHtml!==void 0)return b("code",{className:d+" hljs",dangerouslySetInnerHTML:{__html:__incipitHtml}});return b("code",{className:d,children:c})}if(u.indexOf("\\n")!==-1){__incipitHtml=window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(u,"");if(__incipitHtml!==null&&__incipitHtml!==void 0)return b("code",{className:"hljs",dangerouslySetInnerHTML:{__html:__incipitHtml}})}if(u.includes("★")&&u.includes("Insight"))return b("code",{className:S.insightHeader,children:c});if(/^─{20,}$/.test(u.trim()))return b("code",{className:S.insightFooter,children:c});return b("code",{children:c})},img:()=>null};globalThis.__component=components.code;';

function createElement(type, props, ...children) {
  const normalized = props ? { ...props } : {};
  if (children.length === 1) normalized.children = children[0];
  else if (children.length > 1) normalized.children = children;
  return { type, props: normalized };
}

function executeComponent(source, highlighter) {
  const sandbox = {
    R: { default: { createElement } },
    b: (type, props) => ({ type, props: { ...props } }),
    S: { insightHeader: 'insight-header', insightFooter: 'insight-footer' },
  };
  sandbox.window = sandbox;
  sandbox.__INCIPIT_HIGHLIGHT_CODE_HTML__ = highlighter;
  vm.runInNewContext(source, sandbox, { filename: 'markdown-code-component-fixture.js' });
  return sandbox.__component;
}

function assertRuntimeBehavior(patched, family) {
  const calls = [];
  const component = executeComponent(patched, (code, className) => {
    calls.push([code, className]);
    return `<span>${code}</span>`;
  });

  const explicit = component({ children: 'const answer = 42;', className: 'language-js Insight' });
  assert.strictEqual(explicit.type, 'code', `${family}: explicit-language element type`);
  assert.strictEqual(explicit.props.className, 'language-js Insight hljs', `${family}: class suffix preserved`);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(explicit.props.dangerouslySetInnerHTML)),
    { __html: '<span>const answer = 42;</span>' },
    `${family}: highlighted HTML forwarded through the renderer contract`,
  );

  const automatic = component({ children: 'line one\nline two', className: undefined });
  assert.strictEqual(automatic.props.className, 'hljs', `${family}: no-language fenced code highlighted`);
  assert.deepStrictEqual(calls, [
    ['const answer = 42;', 'language-js Insight'],
    ['line one\nline two', ''],
  ], `${family}: both render-time highlighter paths receive exact source text`);

  const fallback = executeComponent(patched, () => null)({
    children: 'const original = true;',
    className: 'language-js Insight',
  });
  assert.strictEqual(fallback.props.className, 'language-js Insight', `${family}: null highlighter keeps host class`);
  assert.strictEqual(fallback.props.children, 'const original = true;', `${family}: null highlighter keeps host children`);

  const automaticFallback = executeComponent(patched, () => undefined)({
    children: 'line one\nline two',
    className: undefined,
  });
  assert.strictEqual(automaticFallback.props.className, undefined, `${family}: undefined highlighter does not invent a class`);
  assert.strictEqual(automaticFallback.props.children, 'line one\nline two', `${family}: undefined highlighter keeps multiline children`);

  const insight = component({ children: '★ Insight', className: undefined });
  assert.strictEqual(insight.props.className, 'insight-header', `${family}: host Insight branch survives prefix rewrite`);
  const divider = component({ children: '────────────────────', className: undefined });
  assert.strictEqual(divider.props.className, 'insight-footer', `${family}: host divider branch survives prefix rewrite`);
}

function assertCanonicalPatch(source, expected, family) {
  const [patched, line] = __test.patchMarkdownCodeComponent(source);
  assert(/已写入/.test(line), `${family}: fresh official shape must be patched: ${line}`);
  assert.strictEqual(patched, expected, `${family}: generated bytes must match the frozen contract`);
  assert.strictEqual(__test.renderTimeMarkdownCodeIsPatched(patched), true, `${family}: scoped postcondition`);
  assert.doesNotThrow(() => new vm.Script(patched), `${family}: patched fixture syntax`);
  assertRuntimeBehavior(patched, family);

  const [repatched, secondLine] = __test.patchMarkdownCodeComponent(patched);
  assert.strictEqual(repatched, patched, `${family}: second patch must be byte-idempotent`);
  assert(/已存在/.test(secondLine), `${family}: second patch reports existing shape: ${secondLine}`);
}

assertCanonicalPatch(CLASSIC_SOURCE, CLASSIC_EXPECTED, 'classic createElement');
assertCanonicalPatch(JSX_SOURCE, JSX_EXPECTED, 'automatic JSX runtime');

const V1_COMPONENT = 'code:({children:c,className:d})=>{if(d){let u=String(c),__incipitHtml=window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(u,d);if(__incipitHtml!==null&&__incipitHtml!==void 0)return R.default.createElement("code",{className:d+" hljs",dangerouslySetInnerHTML:{__html:__incipitHtml}});return R.default.createElement("code",{className:d},c)}let u=String(c);if(u.includes("★")&&u.includes("Insight"))return R.default.createElement("code",{className:S.insightHeader},c);if(/^─{20,}$/.test(u.trim()))return R.default.createElement("code",{className:S.insightFooter},c);return R.default.createElement("code",null,c)}';
const v1Source = `const components={${V1_COMPONENT}};globalThis.__component=components.code;`;
const [v1Patched, v1Line] = __test.patchMarkdownCodeComponent(v1Source);
assert(/已升级/.test(v1Line), `classic V1 must migrate instead of being mistaken for current: ${v1Line}`);
assert.strictEqual(__test.renderTimeMarkdownCodeIsPatched(v1Patched), true, 'classic V1 migration reaches current contract');
assert.strictEqual(
  (v1Patched.match(/window\.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window\.__INCIPIT_HIGHLIGHT_CODE_HTML__\(/g) || []).length,
  2,
  'classic V1 migration adds only the missing no-language path',
);
assertRuntimeBehavior(v1Patched, 'classic V1 migration');
const [v1Repatched, v1SecondLine] = __test.patchMarkdownCodeComponent(v1Patched);
assert.strictEqual(v1Repatched, v1Patched, 'migrated V1 is byte-idempotent');
assert(/已存在/.test(v1SecondLine), `migrated V1 reports existing shape: ${v1SecondLine}`);

for (const [label, source] of [
  ['ambiguous duplicate components', `const first={${CLASSIC_COMPONENT}};const second={${JSX_COMPONENT}};`],
  ['unsupported renderer call shape', 'const components={code:({children:c,className:d})=>{if(d)return h("code",{className:d},c);let u=String(c);return h("code",null,c)}};'],
  ['reordered code coercion', 'const components={code:({children:c,className:d})=>{let u=String(c);if(d)return b("code",{className:d,children:c});return b("code",{children:c})}};'],
  ['malformed component boundary', 'const components={code:({children:c,className:d})=>{if(d)return b("code",{className:d,children:c});let u=String(c);'],
]) {
  const [unchanged, line] = __test.patchMarkdownCodeComponent(source);
  assert.strictEqual(unchanged, source, `${label}: unsupported/ambiguous source must not be partially rewritten`);
  assert(/降级/.test(line), `${label}: miss must remain explicit: ${line}`);
}

const fakeGlobalContract = [
  CLASSIC_SOURCE,
  'window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(outside,"language-js");',
  'window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(outside,"");',
  'outside.indexOf("\\n")!==-1;className:"hljs";outside+" hljs";dangerouslySetInnerHTML:{__html:__incipitHtml};',
].join('');
assert.strictEqual(
  __test.renderTimeMarkdownCodeIsPatched(fakeGlobalContract),
  false,
  'highlighter-shaped literals outside the unique code component must not make the contract green',
);

console.log('markdown-code-component-contracts: ok');
