'use strict';

/** Guard only the recognized presentation helper that follows new messages. */
function patchTranscriptFollow(content) {
  const pattern = /function ([\w$]+)\(([\w$]+),([\w$]+)=!1\)\{let ([\w$]+)=\2\.current;if\(!\4\)return;(?:if\(globalThis\.__INCIPIT_ALLOW_TRANSCRIPT_FOLLOW__\?\.\(\4,\3\)===!1\)return;)?if\(\3\)\4\.scrollTo\(\{top:\4\.scrollHeight,behavior:"smooth"\}\);else \4\.scrollTop=\4\.scrollHeight\}/g;
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) return [content, 'Transcript scroll intent: degraded (automatic follow helper is not uniquely recognized)'];
  const match = matches[0];
  if (match[0].includes('__INCIPIT_ALLOW_TRANSCRIPT_FOLLOW__')) return [content, 'Transcript scroll intent: already patched'];
  const anchor = `if(!${match[4]})return;`;
  const guard = `if(globalThis.__INCIPIT_ALLOW_TRANSCRIPT_FOLLOW__?.(${match[4]},${match[3]})===!1)return;`;
  const replacement = match[0].replace(anchor, anchor + guard);
  return [content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length), 'Transcript scroll intent: patched'];
}

module.exports = { patchTranscriptFollow };
