'use strict';

const { parseHostExpression, visitSyntax, propertyName } = require('./host-source');

/** Locate listeners that forward their incoming message to the host protocol. */
function privateMessageListeners(content) {
  const listeners = [];
  for (const seed of content.matchAll(/\.webview\s*\.\s*onDidReceiveMessage\s*\(/g)) {
    const parsed = parseHostExpression(content, seed.index + seed[0].length);
    const callback = parsed?.type === 'SequenceExpression' ? parsed.expressions[0] : parsed;
    if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type) ||
        callback.body.type !== 'BlockStatement' || callback.params[0]?.type !== 'Identifier') continue;
    const message = callback.params[0].name;
    let forwardsMessage = false;
    visitSyntax(callback.body, node => {
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          propertyName(node.callee) === 'fromClient' && node.arguments[0]?.name === message) forwardsMessage = true;
    });
    if (!forwardsMessage) continue;
    const insertIndex = callback.body.start + 1;
    const guard = `if(${message}&&${message}.__incipit===true)return;`;
    listeners.push({ insertIndex, guard, patched: content.startsWith(guard, insertIndex) });
  }
  return listeners;
}

module.exports = { privateMessageListeners };
