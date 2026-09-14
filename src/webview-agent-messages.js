'use strict';

/** Keep explicitly owned agent messages out of the native main transcript. */
function patchAgentMessages(content) {
  const expression = /function ([\w$]+)\(([\w$]+),([\w$]+),[^)]*\)\{if\(\3\.isEmpty(?:\|\|\3\.parentToolUseId\|\|\3\.sdkParentToolUseId)?\)return null;if\(\3\.type==="user"\)\{if\(\3\.parentToolUseId\)return null;/g;
  const matches = [...content.matchAll(expression)].filter(match => {
    const tail = content.slice(match.index + match[0].length, match.index + 3000);
    return tail.includes(match[3] + '.type==="assistant"') &&
      tail.includes('session:' + match[2] + ',message:' + match[3]);
  });
  if (matches.length !== 1) return [content, 'Agent message ownership: degraded (main transcript renderer is not uniquely recognized)'];
  const match = matches[0], record = match[3];
  if (match[0].includes(record + '.sdkParentToolUseId')) return [content, 'Agent message ownership: already patched'];
  const updated = match[0].replace(record + '.isEmpty)', record + '.isEmpty||' + record + '.parentToolUseId||' + record + '.sdkParentToolUseId)');
  return [content.slice(0, match.index) + updated + content.slice(match.index + match[0].length), 'Agent message ownership: patched'];
}

module.exports = { patchAgentMessages };
