import { assetURL, pageNonce } from './enhance_shared.js';
import { ensureHighlighter, normalizeLanguage } from './syntax_highlight.js';

let runtime = null;

function loadParser() {
  if (runtime) return runtime;
  runtime = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = assetURL('markdown/markdown-it.min.js');
    const nonce = pageNonce(); if (nonce) script.nonce = nonce;
    const timer = setTimeout(() => finish(new Error('Message formatting timed out.')), 8000);
    function finish(error) {
      clearTimeout(timer); script.onload = script.onerror = null;
      if (error) { script.remove(); runtime = null; reject(error); return; }
      try {
        const parser = globalThis.markdownit({ html: false, linkify: false, typographer: false, maxNesting: 32 });
        // Remote images must never initiate a request merely because a history opens.
        parser.renderer.rules.image = (tokens, index) => {
          const token = tokens[index], label = parser.utils.escapeHtml(token.content || 'Image');
          const href = token.attrGet('src') || '';
          return /^https?:\/\//i.test(href) ? `<a href="${parser.utils.escapeHtml(href)}">${label} (image)</a>` : `<span>${label} (image)</span>`;
        };
        resolve(parser);
      } catch (error) { runtime = null; reject(error); }
    }
    script.onload = () => finish(); script.onerror = () => finish(new Error('Message formatting is unavailable.'));
    document.head.append(script);
  });
  return runtime;
}

/** Format read-only message text; raw text remains available if a local asset fails. */
export function createAgentRichText(text, { fileAction, signal } = {}) {
  const root = document.createElement('div'); root.setAttribute('data-incipit-agent-prose', '');
  const raw = document.createElement('div'); raw.setAttribute('data-incipit-agent-raw', ''); raw.textContent = String(text || ''); root.append(raw);
  if (!text || text.length > 200000) return root;
  let generation = 0;
  async function render() {
    const token = ++generation;
    try {
      const parser = await loadParser();
      if (signal?.aborted || token !== generation) return;
      const content = document.createElement('div'); content.innerHTML = parser.render(text);
      for (const link of content.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href');
        if (/^(https?:\/\/|mailto:)/i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; continue; }
        const action = !/^[a-z][a-z0-9+.-]*:/i.test(href) || /^file:/i.test(href) ? fileAction?.(href) : null;
        link.removeAttribute('href');
        if (action) {
          link.setAttribute('role', 'button'); link.tabIndex = 0; link.title = action.filePath;
          const open = event => { event.preventDefault(); event.stopPropagation(); action.open(); };
          link.addEventListener('click', open);
          link.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') open(event); });
        }
      }
      root.replaceChildren(content);
      for (const code of content.querySelectorAll('pre > code[class*="language-"]')) {
        const language = normalizeLanguage((code.className.match(/language-([^\s]+)/) || [])[1]);
        if (!language || code.textContent.length > 12000) continue;
        try {
          const highlighter = await ensureHighlighter(language);
          if (signal?.aborted || token !== generation) return;
          if (highlighter.getLanguage(language)) { code.innerHTML = highlighter.highlight(code.textContent, { language, ignoreIllegals: true }).value; code.classList.add('hljs'); }
        } catch (error) {
          if (signal?.aborted) return;
          const note = document.createElement('span'); note.setAttribute('data-incipit-agent-notice', ''); note.textContent = 'Code shown without syntax color.'; note.title = error.message;
          code.parentElement.after(note);
        }
      }
    } catch (error) {
      if (signal?.aborted || token !== generation) return;
      root.replaceChildren(raw);
      const retry = document.createElement('button'); retry.type = 'button'; retry.setAttribute('data-incipit-agent-action', ''); retry.textContent = 'Retry formatting'; retry.title = error.message;
      retry.addEventListener('click', event => { event.stopPropagation(); retry.disabled = true; render(); }); root.append(retry);
    }
  }
  render();
  return root;
}
