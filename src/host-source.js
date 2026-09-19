'use strict';

const { parseExpressionAt } = require('acorn');

/** Parse one host expression without consuming the rest of the bundle. */
function parseHostExpression(source, start = 0) {
  try {
    return parseExpressionAt(source, start, {
      ecmaVersion: 'latest', allowSuperOutsideMethod: true, preserveParens: true,
    });
  } catch (_) {
    return null;
  }
}

/** Visit syntax nodes, including nested expressions, without following metadata. */
function visitSyntax(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visitSyntax(child, visit));
    else if (value && typeof value.type === 'string') visitSyntax(value, visit);
  }
}

function propertyName(node) {
  if (!node || node.computed) return null;
  const key = node.type === 'MemberExpression' ? node.property : node.key;
  return key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? key.value : null;
}

module.exports = { parseHostExpression, visitSyntax, propertyName };
