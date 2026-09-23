'use strict';

const { parseHostExpression, visitSyntax, propertyName } = require('./host-source');

/** Keep explicitly owned agent messages out of the native main transcript. */
function patchAgentMessages(content) {
  const starts = [...content.matchAll(/\bfunction\s+[\w$]+\s*\([^)]*\)\s*\{/g)].map(match => match.index);
  const candidates = new Map();
  for (const seed of content.matchAll(/\bif\s*\(\s*([\w$]+)\.isEmpty\b/g)) {
    const start = starts.filter(index => index < seed.index).pop();
    if (start === undefined || candidates.has(start)) continue;
    const fn = parseHostExpression(content, start);
    if (!fn || fn.end < seed.index || fn.params[1]?.name !== seed[1]) continue;
    const record = seed[1], session = fn.params[0]?.name;
    const guard = fn.body.body.find(node => node.type === 'IfStatement' && node.start === seed.index);
    if (!guard || guard.consequent.type !== 'ReturnStatement' || guard.consequent.argument?.value !== null) continue;
    const types = new Set();
    let renderer = false;
    visitSyntax(fn.body, node => {
      if (node.type === 'BinaryExpression' && node.operator === '===' &&
          node.left.type === 'MemberExpression' && node.left.object.name === record &&
          propertyName(node.left) === 'type' && node.right.type === 'Literal') types.add(node.right.value);
      if (node.type === 'ObjectExpression' &&
          node.properties.some(p => propertyName(p) === 'session' && p.value?.name === session) &&
          node.properties.some(p => propertyName(p) === 'message' && p.value?.name === record)) renderer = true;
    });
    if (!renderer || !types.has('user') || !types.has('assistant')) continue;
    const readOnly = fn.body.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
      .find(node => node.init?.type === 'LogicalExpression' && node.init.operator === '??' &&
        node.init.left.type === 'ChainExpression' && propertyName(node.init.left.expression) === 'readOnly');
    candidates.set(start, { guard, record, readOnly: readOnly?.id.name });
  }
  if (candidates.size !== 1) return [content, 'Agent message ownership: degraded (main transcript renderer is not uniquely recognized)'];
  const { guard, record, readOnly } = [...candidates.values()][0];
  const test = content.slice(guard.test.start, guard.test.end);
  if (test.includes(record + '.sdkParentToolUseId')) return [content, 'Agent message ownership: already patched'];
  // The upstream read-only transcript also uses this renderer as of 2.1.278.
  const owned = `(${record}.parentToolUseId||${record}.sdkParentToolUseId)`;
  const updated = `${test}||${readOnly ? `(!${readOnly}&&${owned})` : owned}`;
  return [content.slice(0, guard.test.start) + updated + content.slice(guard.test.end), 'Agent message ownership: patched'];
}

module.exports = { patchAgentMessages };
