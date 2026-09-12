/** Shared offline syntax runtime and palette stylesheet for prose and diffs. */
import { assetURL, CFG, pageNonce, reportHealth } from './enhance_shared.js';

const EXTRA_LANGUAGES = new Set(['clojure', 'cmake', 'dart', 'dockerfile', 'dos', 'elixir', 'erlang', 'groovy', 'haskell', 'julia', 'matlab', 'nginx', 'ocaml', 'powershell', 'protobuf', 'scala', 'scheme', 'stylus', 'vue']);
const ALIASES = { ts: 'typescript', js: 'javascript', tsx: 'typescript', jsx: 'javascript', html: 'xml', vuejs: 'vue', toml: 'ini', ps1: 'powershell', ps: 'powershell', bat: 'dos', cmd: 'dos', docker: 'dockerfile', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', jl: 'julia', ml: 'ocaml', proto: 'protobuf', gradle: 'groovy' };
const resources = new Map();
const languages = new Map();
let runtime = null;

const FILE_LANGUAGES = {
  bash: 'bash', sh: 'bash', zsh: 'bash', bat: 'dos', cmd: 'dos',
  c: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', cu: 'cpp', cuh: 'cpp',
  cs: 'csharp', css: 'css', diff: 'diff', patch: 'diff', go: 'go', java: 'java',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonl: 'json', html: 'xml', xml: 'xml', svg: 'xml', svelte: 'xml',
  ini: 'ini', toml: 'ini', kt: 'kotlin', kts: 'kotlin', less: 'less', lua: 'lua',
  m: 'objectivec', mm: 'objectivec', matlab: 'matlab', php: 'php',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', py: 'python', pyw: 'python',
  rb: 'ruby', rakefile: 'ruby', gemfile: 'ruby', rs: 'rust', scss: 'scss', sql: 'sql', swift: 'swift',
  yaml: 'yaml', yml: 'yaml', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell',
  scala: 'scala', sc: 'scala', jl: 'julia', ml: 'ocaml', mli: 'ocaml', clj: 'clojure', cljs: 'clojure',
  cmake: 'cmake', groovy: 'groovy', gradle: 'groovy', proto: 'protobuf', vue: 'vue',
  makefile: 'makefile', mk: 'makefile', r: 'r', graphql: 'graphql', gql: 'graphql',
  markdown: 'plaintext', md: 'plaintext', mdx: 'plaintext', mdown: 'plaintext', mkd: 'plaintext',
};


/** Infer source syntax for local files; markdown diffs deliberately stay literal. */
export function getFileLanguage(filePath) {
  const base = String(filePath || '').split(/[/\\]/).pop().toLowerCase();
  if (/^dockerfile(?:\.|$)/.test(base)) return 'dockerfile';
  if (base === 'cmakelists.txt') return 'cmake';
  if (base === 'cargo.lock') return 'ini';
  const ext = base.match(/\.([a-z0-9]+)$/)?.[1] || base;
  return Object.prototype.hasOwnProperty.call(FILE_LANGUAGES, ext) ? FILE_LANGUAGES[ext] : 'plaintext';
}

export function normalizeLanguage(language) {
  const name = String(language || '').toLowerCase().replace(/^language-/, '');
  return Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] : name;
}

function loadResource(file, stylesheet = false) {
  if (resources.has(file)) return resources.get(file);
  const promise = new Promise((resolve, reject) => {
    const node = document.createElement(stylesheet ? 'link' : 'script');
    let timer;
    const finish = error => {
      clearTimeout(timer); node.onload = node.onerror = null;
      if (error) { node.remove(); resources.delete(file); reject(error); }
      else resolve();
    };
    if (stylesheet) { node.rel = 'stylesheet'; node.href = assetURL(file); }
    else { node.src = assetURL(file); const nonce = pageNonce(); if (nonce) node.nonce = nonce; }
    node.onload = () => finish();
    node.onerror = () => finish(new Error('Syntax asset could not be loaded: ' + file));
    timer = setTimeout(() => finish(new Error('Syntax asset load timed out: ' + file)), 8000);
    document.head.appendChild(node);
  });
  resources.set(file, promise);
  return promise;
}

/** Load once, retry after failures, and register only the requested extra grammar. */
export async function ensureHighlighter(language = '') {
  if (!runtime) {
    reportHealth('asset.hljs', 'loading');
    const themeFile = 'hljs/styles/' + (CFG.palette === 'warm-white' ? 'vs.min.css' : 'vs2015.min.css');
    runtime = Promise.all([loadResource(themeFile, true), globalThis.hljs ? null : loadResource('hljs/highlight.min.js')])
      .then(() => {
        if (!globalThis.hljs?.highlight) throw new Error('The syntax runtime did not initialize.');
        reportHealth('asset.hljs', 'ok', { themeFile });
        return globalThis.hljs;
      }).catch(error => { runtime = null; reportHealth('asset.hljs', 'error', { message: error.message }); throw error; });
  }
  const highlighter = await runtime;
  const name = normalizeLanguage(language);
  if (!name || highlighter.getLanguage(name)) return highlighter;
  if (!EXTRA_LANGUAGES.has(name)) {
    reportHealth('syntax.' + name, 'degraded', { reason: 'unsupported-language' });
    return highlighter;
  }
  if (!languages.has(name)) {
    languages.set(name, (async () => {
      if (name === 'vue') await ensureHighlighter('stylus');
      await loadResource('hljs/languages/' + name + '.min.js');
      if (!highlighter.getLanguage(name)) throw new Error('The syntax grammar did not register: ' + name);
      reportHealth('syntax.' + name, 'ok');
    })().catch(error => { languages.delete(name); reportHealth('syntax.' + name, 'error', { message: error.message }); throw error; }));
  }
  await languages.get(name);
  return highlighter;
}
