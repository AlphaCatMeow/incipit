/** Resolve authored local references without using the webview document base URL. */
const DRIVE = /^[A-Za-z]:[\\/]/;
const CONTROL = /[\u0000-\u001f\u007f\ufffd]/;
const RESOURCE_HOST = /^file\+\.vscode-resource\.vscode-cdn\.net$/i;

function absolutePath(value) {
  const path = value.replace(/\\/g, '/');
  let prefix, parts, floor = 0;
  if (DRIVE.test(path)) { prefix = path.slice(0, 3); parts = path.slice(3).split('/'); }
  else if (path.startsWith('//')) { prefix = '//'; parts = path.slice(2).split('/'); floor = 2; if (!parts[0] || !parts[1]) return null; }
  else if (path.startsWith('/')) { prefix = '/'; parts = path.slice(1).split('/'); }
  else return null;
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length <= floor) return null; out.pop(); }
    else out.push(part);
  }
  return prefix + out.join('/');
}

function parseLocation(suffix) {
  const match = /^#L?(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/i.exec(suffix);
  if (!match) return null;
  const [startLine, startColumn, endLine, endColumn] = match.slice(1).map(n => n === undefined ? undefined : Number(n));
  if ([startLine, startColumn, endLine, endColumn].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1))) return null;
  if (endLine !== undefined && endLine < startLine) return null;
  return { startLine, endLine: endLine || startLine, ...(startColumn ? { startColumn, endColumn: endColumn || startColumn } : {}) };
}

/**
 * Return a local absolute path and optional editor location, or null when the
 * reference is ambiguous. `literal` is for tool input paths, which are already
 * filesystem strings; hrefs are percent-decoded exactly once. `revealPath`
 * preserves relative provenance for the host's workspace containment check.
 */
export function resolveFileReference(value, { cwd = '', literal = false } = {}) {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  let raw = value.trim(), location;
  if (!raw || raw.startsWith('#')) return null;
  try {
    if (!literal) {
      const hash = raw.indexOf('#');
      if (hash >= 0) { location = parseLocation(raw.slice(hash)); if (!location) return null; raw = raw.slice(0, hash); }
      if (raw.includes('?')) return null;
      if (/^file:/i.test(raw)) {
        const url = new URL(raw);
        if (url.username || url.password || url.port) return null;
        raw = (url.hostname && url.hostname !== 'localhost' ? '//' + url.hostname : '') + decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
      } else if (/^https:/i.test(raw)) {
        const url = new URL(raw);
        if (!RESOURCE_HOST.test(url.hostname) || url.port || url.username || url.password) return null;
        raw = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
      } else {
        raw = decodeURIComponent(raw);
        if (!DRIVE.test(raw) && /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
      }
      if (!location) {
        const at = /:(\d+)(?::(\d+))?$/.exec(raw);
        if (at) { location = parseLocation('#L' + at[1] + (at[2] ? 'C' + at[2] : '')); if (!location) return null; raw = raw.slice(0, at.index); }
      }
    }
    if (!raw || CONTROL.test(raw) || /[<>|*?]/.test(raw)) return null;
    if (/^[A-Za-z]:[^\\/]/.test(raw)) return null;
    if (!DRIVE.test(raw) && raw.includes(':')) return null;
    const base = absolutePath(String(cwd || ''));
    const absolute = DRIVE.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\');
    if (!absolute && !base) return null;
    if (!literal && !absolute && !/[\\/.]/.test(raw) && !/^(readme|license|licence|copying|makefile|dockerfile|gemfile|rakefile|justfile|procfile)$/i.test(raw)) return null;
    if (!literal && raw.startsWith('//') && !DRIVE.test(base || '')) return null;
    const filePath = absolutePath(absolute ? raw : base + '/' + raw);
    if (!filePath) return null;
    return { filePath, location, revealPath: absolute ? filePath : raw, cwd: base || '' };
  } catch (_) { return null; }
}

/** External links keep the host's navigation and are never treated as files. */
export function isExternalReference(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('#')) return true;
  if (/^https:/i.test(raw)) { try { return !RESOURCE_HOST.test(new URL(raw).hostname); } catch (_) { return false; } }
  return /^(?:http|mailto|tel):/i.test(raw);
}
