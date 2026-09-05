/** Color bounded source segments, preserving token scopes across line breaks. */
import { ensureHighlighter, normalizeLanguage } from '../syntax_highlight.js';
import { diffAbortError } from './model.js';

const MAX_SEGMENT_CHARS = 12000;

function splitHighlightedLines(html) {
  const lines = [], stack = [];
  let line = '', offset = 0;
  for (const match of html.matchAll(/<span\b[^>]*>|<\/span>|\n/g)) {
    line += html.slice(offset, match.index);
    const token = match[0];
    if (token === '\n') { lines.push(line + '</span>'.repeat(stack.length)); line = stack.join(''); }
    else { line += token; if (token === '</span>') stack.pop(); else stack.push(token); }
    offset = match.index + token.length;
  }
  lines.push(line + html.slice(offset));
  return lines;
}

/** Return row-indexed markup; cancellation never publishes a partial page. */
export async function colorDiffRows(rows, language, signal) {
  const name = normalizeLanguage(language);
  const markup = new Map();
  if (!name || ['plaintext', 'text', 'none'].includes(name)) return { markup, notice: '' };
  const highlighter = await ensureHighlighter(name);
  if (signal.aborted) throw diffAbortError();
  if (!highlighter.getLanguage(name)) return { markup, notice: 'Syntax color is unavailable for this language.' };
  let limited = false;
  for (const side of ['old', 'new']) {
    let segment = [], chars = 0, hunk = null;
    const flush = async () => {
      if (!segment.length) return;
      if (signal.aborted) throw diffAbortError();
      const source = segment.map(({ row }) => row.text).join('\n');
      // Historical hunks often omit the enclosing Vue SFC section (2026-09-05).
      const result = name === 'vue' && !/<(?:script|style|template)\b/i.test(source)
        ? highlighter.highlightAuto(source, ['typescript', 'css', 'xml'])
        : highlighter.highlight(source, { language: name, ignoreIllegals: true });
      if (result.errorRaised) throw result.errorRaised;
      const lines = splitHighlightedLines(result.value);
      segment.forEach(({ row, index }, i) => { if (row.kind !== 'ctx' || side === 'new') markup.set(index, lines[i]); });
      segment = []; chars = 0;
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row.kind === 'gap' || (hunk !== null && row.hunk !== hunk)) await flush();
      hunk = row.hunk;
      if (row.kind === 'gap' || (side === 'old' ? row.kind === 'add' : row.kind === 'del')) continue;
      if (chars + row.text.length > MAX_SEGMENT_CHARS) { limited = true; await flush(); }
      if (row.text.length > MAX_SEGMENT_CHARS) { limited = true; continue; }
      segment.push({ row, index }); chars += row.text.length + 1;
    }
    await flush();
  }
  if (signal.aborted) throw diffAbortError();
  return { markup, notice: limited ? 'Syntax color is limited for large source segments.' : '' };
}
