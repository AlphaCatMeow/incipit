'use strict';

const { TextDecoder } = require('util');
const { CustomIconError } = require('./errors');

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_ELEMENT_COUNT = 10000;
const MAX_ATTRIBUTE_COUNT = 50000;
const MAX_DEPTH = 64;
const MAX_TEXT_LENGTH = 1024 * 1024;

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'pattern', 'marker', 'title', 'desc', 'text', 'tspan',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight',
  'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);

const GRAPHIC_ELEMENTS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
]);

const STRIPPED_ELEMENTS = new Set([
  'script', 'foreignobject', 'image', 'use', 'a', 'style', 'iframe', 'object',
  'embed', 'audio', 'video', 'canvas', 'set', 'discard', 'handler', 'listener',
  'animate', 'animatemotion', 'animatetransform', 'animatecolor', 'mpath',
  'feimage',
]);

const URL_ATTRIBUTES = new Set([
  'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start',
  'marker-mid', 'marker-end', 'cursor',
]);

const ALLOWED_STYLE_PROPERTIES = new Set([
  'color', 'display', 'fill', 'fill-opacity', 'fill-rule', 'filter',
  'flood-color', 'flood-opacity', 'font-family', 'font-size', 'font-style',
  'font-weight', 'letter-spacing', 'lighting-color', 'marker', 'marker-end',
  'marker-mid', 'marker-start', 'mask', 'mix-blend-mode', 'opacity',
  'paint-order', 'pointer-events', 'shape-rendering', 'stop-color',
  'stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity',
  'stroke-width', 'text-anchor', 'text-decoration', 'text-rendering',
  'transform', 'transform-origin', 'visibility', 'word-spacing', 'clip-path',
  'clip-rule',
]);

function iconError(code, message, cause = null) {
  return new CustomIconError(code, message, cause);
}

function decodeSvg(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  if (!buffer.length) throw iconError('ICON_SVG_EMPTY', 'The SVG file is empty.');
  if (buffer.length > MAX_SVG_BYTES) {
    throw iconError('ICON_SVG_TOO_LARGE', 'The SVG file is larger than 2 MB.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (exc) {
    throw iconError('ICON_SVG_ENCODING', 'The SVG must be valid UTF-8 text.', exc);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/\0/.test(text) || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw iconError('ICON_SVG_CONTROL_CHAR', 'The SVG contains invalid control characters.');
  }
  return text;
}

function decodeXmlEntities(value) {
  return String(value).replace(/&([^;]+);/g, (whole, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
    if (Object.prototype.hasOwnProperty.call(named, entity)) return named[entity];
    let codePoint = null;
    if (/^#[0-9]+$/.test(entity)) codePoint = Number(entity.slice(1));
    else if (/^#x[0-9a-f]+$/i.test(entity)) codePoint = Number.parseInt(entity.slice(2), 16);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint)) || codePoint === 0x7f) {
      throw iconError('ICON_SVG_ENTITY', `The SVG contains an unsupported entity: &${entity};`);
    }
    return String.fromCodePoint(codePoint);
  });
}

function escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function findTagEnd(text, start) {
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

function parseStartTag(body) {
  let source = body.trim();
  let selfClosing = false;
  if (/\/$/.test(source)) {
    selfClosing = true;
    source = source.slice(0, -1).trimEnd();
  }
  const nameMatch = source.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
  if (!nameMatch) throw iconError('ICON_SVG_XML', 'The SVG contains a malformed element name.');
  const name = nameMatch[1];
  let offset = nameMatch[0].length;
  const attributes = [];
  const seen = new Set();
  while (offset < source.length) {
    const whitespace = source.slice(offset).match(/^\s+/);
    if (!whitespace) throw iconError('ICON_SVG_XML', `Malformed attributes on <${name}>.`);
    offset += whitespace[0].length;
    if (offset >= source.length) break;
    const attrMatch = source.slice(offset).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!attrMatch) throw iconError('ICON_SVG_XML', `Malformed attribute on <${name}>.`);
    const attrName = attrMatch[1];
    const key = attrName.toLowerCase();
    if (seen.has(key)) throw iconError('ICON_SVG_XML', `Duplicate attribute ${attrName} on <${name}>.`);
    seen.add(key);
    offset += attrMatch[0].length;
    const aroundEquals = source.slice(offset).match(/^\s*=\s*/);
    if (!aroundEquals) throw iconError('ICON_SVG_XML', `Attribute ${attrName} must have a quoted value.`);
    offset += aroundEquals[0].length;
    const quote = source[offset];
    if (quote !== '"' && quote !== "'") {
      throw iconError('ICON_SVG_XML', `Attribute ${attrName} must have a quoted value.`);
    }
    const end = source.indexOf(quote, offset + 1);
    if (end < 0) throw iconError('ICON_SVG_XML', `Attribute ${attrName} has an unterminated value.`);
    attributes.push({ name: attrName, value: decodeXmlEntities(source.slice(offset + 1, end)) });
    offset = end + 1;
  }
  return { name, attributes, selfClosing };
}

function decodeCssEscapes(value) {
  const source = String(value);
  let output = '';
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\\') {
      output += source[index];
      continue;
    }
    if (index + 1 >= source.length) {
      output += '\\';
      continue;
    }
    const rest = source.slice(index + 1);
    const hex = rest.match(/^[0-9a-f]{1,6}/i);
    if (hex) {
      const codePoint = Number.parseInt(hex[0], 16);
      output += codePoint > 0 && codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : '\ufffd';
      index += hex[0].length;
      if (source[index + 1] === '\r' && source[index + 2] === '\n') index += 2;
      else if (/[\t\n\f\r ]/.test(source[index + 1] || '')) index += 1;
      continue;
    }
    if (source[index + 1] === '\r' && source[index + 2] === '\n') {
      index += 2;
      continue;
    }
    if (source[index + 1] === '\n' || source[index + 1] === '\r' || source[index + 1] === '\f') {
      index += 1;
      continue;
    }
    output += source[index + 1];
    index += 1;
  }
  return output;
}

function normalizedCssSecurityValue(value) {
  return decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//g, '');
}

function containsCssUrl(value) {
  return /url\s*\(/i.test(normalizedCssSecurityValue(value));
}

function parseLocalUrl(value, references) {
  const text = normalizedCssSecurityValue(value).trim();
  if (!/url\s*\(/i.test(text)) return text;
  const match = text.match(/^url\(\s*(['"]?)#([A-Za-z_][A-Za-z0-9_.:-]{0,127})\1\s*\)$/i);
  if (!match) {
    throw iconError('ICON_SVG_EXTERNAL_REFERENCE', 'The SVG contains an external or malformed URL reference.');
  }
  references.add(match[2]);
  return `url(#${match[2]})`;
}

function rejectExecutableValue(value) {
  const compact = normalizedCssSecurityValue(value).replace(/[\s\u0000-\u0020]+/gu, '').toLowerCase();
  if (/(?:javascript|vbscript|data|https?|file|ftp):/.test(compact) || compact.includes('@import') ||
      compact.includes('expression(') || compact.includes('-moz-binding') || compact.includes('behavior:')) {
    throw iconError('ICON_SVG_EXTERNAL_REFERENCE', 'The SVG contains executable or external content.');
  }
}

function sanitizeStyle(value, references) {
  rejectExecutableValue(value);
  if (/[{}<>]/.test(value)) throw iconError('ICON_SVG_STYLE', 'The SVG contains an unsafe style attribute.');
  const declarations = [];
  for (const raw of String(value).split(';')) {
    const declaration = raw.trim();
    if (!declaration) continue;
    const colon = declaration.indexOf(':');
    if (colon <= 0) throw iconError('ICON_SVG_STYLE', 'The SVG contains a malformed style declaration.');
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    let propertyValue = declaration.slice(colon + 1).trim();
    if (!propertyValue) continue;
    if (URL_ATTRIBUTES.has(property)) propertyValue = parseLocalUrl(propertyValue, references);
    else if (containsCssUrl(propertyValue)) {
      throw iconError('ICON_SVG_EXTERNAL_REFERENCE', 'The SVG contains an URL in an unsupported style property.');
    }
    rejectExecutableValue(propertyValue);
    declarations.push(`${property}:${propertyValue}`);
  }
  return declarations.join(';');
}

function validateRootGeometry(attributes) {
  const byName = new Map(attributes.map(attr => [attr.name.toLowerCase(), attr.value]));
  for (const key of ['width', 'height']) {
    if (!byName.has(key)) continue;
    const value = String(byName.get(key)).trim();
    const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|pt|pc|mm|cm|in|em|rem|%)?$/i);
    if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0 || Number(match[1]) > 16384) {
      throw iconError('ICON_SVG_DIMENSIONS', `The SVG has an unsupported ${key}.`);
    }
  }
  if (byName.has('viewbox')) {
    const values = String(byName.get('viewbox')).trim().split(/[\s,]+/).map(Number);
    if (values.length !== 4 || values.some(value => !Number.isFinite(value)) ||
        values[2] <= 0 || values[3] <= 0 || values[2] > 10000000 || values[3] > 10000000) {
      throw iconError('ICON_SVG_DIMENSIONS', 'The SVG has an invalid viewBox.');
    }
  }
}

function sanitizeAttributes(elementName, attributes, context) {
  const out = [];
  let hasNamespace = false;
  for (const attribute of attributes) {
    context.attributeCount++;
    if (context.attributeCount > MAX_ATTRIBUTE_COUNT) {
      throw iconError('ICON_SVG_COMPLEXITY', 'The SVG contains too many attributes.');
    }
    const lower = attribute.name.toLowerCase();
    if (lower === 'xmlns') {
      if (!context.isRoot || attribute.value !== SVG_NAMESPACE) {
        throw iconError('ICON_SVG_NAMESPACE', 'The SVG namespace is invalid.');
      }
      hasNamespace = true;
      out.push({ name: 'xmlns', value: SVG_NAMESPACE });
      continue;
    }
    if (lower.startsWith('xmlns:') || lower === 'xml:space') continue;
    if (attribute.name.includes(':')) {
      throw iconError('ICON_SVG_NAMESPACE', `The SVG uses an unsupported prefixed attribute: ${attribute.name}.`);
    }
    if (lower.startsWith('on') || lower === 'href' || lower === 'src' || lower === 'externalresourcesrequired') {
      continue;
    }
    let value = attribute.value;
    if (lower === 'id') {
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
        throw iconError('ICON_SVG_ID', 'The SVG contains an invalid element id.');
      }
      if (context.ids.has(value)) throw iconError('ICON_SVG_ID', `The SVG contains duplicate id ${value}.`);
      context.ids.add(value);
    } else if (lower === 'style') {
      value = sanitizeStyle(value, context.references);
      if (!value) continue;
    } else if (URL_ATTRIBUTES.has(lower)) {
      value = parseLocalUrl(value, context.references);
      rejectExecutableValue(value);
    } else {
      if (containsCssUrl(value)) {
        throw iconError('ICON_SVG_EXTERNAL_REFERENCE', `The SVG contains an URL in ${attribute.name}.`);
      }
      rejectExecutableValue(value);
    }
    out.push({ name: attribute.name, value });
  }
  if (context.isRoot && !hasNamespace) out.unshift({ name: 'xmlns', value: SVG_NAMESPACE });
  if (context.isRoot) validateRootGeometry(out);
  return out;
}

function serializeStartTag(name, attributes, selfClosing) {
  const suffix = attributes.map(attr => ` ${attr.name}="${escapeXmlAttribute(attr.value)}"`).join('');
  return `<${name}${suffix}${selfClosing ? '/>' : '>'}`;
}

// Parses untrusted SVG as strict XML, removes executable subtrees and unsafe
// attributes, and emits a canonical static SVG. It rejects malformed or empty
// results so callers never install an invisible icon.
function sanitizeSvg(input) {
  const text = decodeSvg(input);
  const output = [];
  const stack = [];
  const ids = new Set();
  const references = new Set();
  let rootSeen = false;
  let rootClosed = false;
  let elementCount = 0;
  let attributeCount = 0;
  let graphicCount = 0;
  let textLength = 0;
  let offset = 0;

  while (offset < text.length) {
    const nextTag = text.indexOf('<', offset);
    const end = nextTag < 0 ? text.length : nextTag;
    const rawText = text.slice(offset, end);
    if (rawText) {
      const decoded = decodeXmlEntities(rawText);
      textLength += decoded.length;
      if (textLength > MAX_TEXT_LENGTH) throw iconError('ICON_SVG_COMPLEXITY', 'The SVG contains too much text.');
      const parent = stack[stack.length - 1];
      if (!parent) {
        if (decoded.trim()) throw iconError('ICON_SVG_XML', 'The SVG contains text outside its root element.');
      } else if (!parent.stripped) {
        const textAllowed = parent.name === 'text' || parent.name === 'tspan' || parent.name === 'title' || parent.name === 'desc';
        if (textAllowed || !decoded.trim()) output.push(escapeXmlText(decoded));
        else throw iconError('ICON_SVG_XML', `Unexpected text inside <${parent.name}>.`);
      }
    }
    if (nextTag < 0) break;
    offset = nextTag;

    if (text.startsWith('<!--', offset)) {
      const commentEnd = text.indexOf('-->', offset + 4);
      if (commentEnd < 0) throw iconError('ICON_SVG_XML', 'The SVG contains an unterminated comment.');
      offset = commentEnd + 3;
      continue;
    }
    if (text.startsWith('<?', offset)) {
      const instructionEnd = text.indexOf('?>', offset + 2);
      if (instructionEnd < 0) throw iconError('ICON_SVG_XML', 'The SVG contains an unterminated processing instruction.');
      const instruction = text.slice(offset + 2, instructionEnd).trim();
      if (rootSeen || !/^xml(?:\s|$)/i.test(instruction)) {
        throw iconError('ICON_SVG_PROCESSING_INSTRUCTION', 'The SVG contains an unsafe processing instruction.');
      }
      offset = instructionEnd + 2;
      continue;
    }
    if (text.startsWith('<!', offset)) {
      throw iconError('ICON_SVG_DOCTYPE', 'DOCTYPE, ENTITY, and CDATA declarations are not allowed in custom SVG icons.');
    }
    const tagEnd = findTagEnd(text, offset + 1);
    if (tagEnd < 0) throw iconError('ICON_SVG_XML', 'The SVG contains an unterminated tag.');
    const body = text.slice(offset + 1, tagEnd);
    offset = tagEnd + 1;

    if (/^\s*\//.test(body)) {
      const match = body.match(/^\s*\/\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/);
      if (!match || !stack.length || stack[stack.length - 1].name !== match[1]) {
        throw iconError('ICON_SVG_XML', 'The SVG contains mismatched closing tags.');
      }
      const closed = stack.pop();
      if (!closed.stripped) output.push(`</${closed.name}>`);
      if (!stack.length) rootClosed = true;
      continue;
    }

    if (rootClosed) throw iconError('ICON_SVG_XML', 'The SVG contains more than one root element.');
    const parsed = parseStartTag(body);
    if (parsed.name.includes(':')) {
      throw iconError('ICON_SVG_NAMESPACE', `The SVG uses an unsupported prefixed element: ${parsed.name}.`);
    }
    const lower = parsed.name.toLowerCase();
    const parentStripped = Boolean(stack.length && stack[stack.length - 1].stripped);
    const stripped = parentStripped || STRIPPED_ELEMENTS.has(lower);
    if (!rootSeen) {
      if (parsed.name !== 'svg') throw iconError('ICON_SVG_ROOT', 'The custom icon must have an <svg> root element.');
      rootSeen = true;
    } else if (!stack.length) {
      throw iconError('ICON_SVG_XML', 'The SVG contains more than one root element.');
    }
    if (!stripped && !ALLOWED_ELEMENTS.has(parsed.name)) {
      throw iconError('ICON_SVG_UNSUPPORTED_ELEMENT', `The SVG contains unsupported element <${parsed.name}>.`);
    }
    elementCount++;
    if (elementCount > MAX_ELEMENT_COUNT) throw iconError('ICON_SVG_COMPLEXITY', 'The SVG contains too many elements.');
    if (!stripped) {
      const attributes = sanitizeAttributes(parsed.name, parsed.attributes, {
        isRoot: parsed.name === 'svg' && stack.length === 0,
        ids,
        references,
        get attributeCount() { return attributeCount; },
        set attributeCount(value) { attributeCount = value; },
      });
      output.push(serializeStartTag(parsed.name, attributes, parsed.selfClosing));
      if (GRAPHIC_ELEMENTS.has(parsed.name)) graphicCount++;
    }
    if (!parsed.selfClosing) {
      stack.push({ name: parsed.name, stripped });
      if (stack.length > MAX_DEPTH) throw iconError('ICON_SVG_COMPLEXITY', 'The SVG nesting depth is too large.');
    } else if (!stack.length) {
      rootClosed = true;
    }
  }

  if (!rootSeen || stack.length || !rootClosed) throw iconError('ICON_SVG_XML', 'The SVG document is incomplete.');
  for (const reference of references) {
    if (!ids.has(reference)) {
      throw iconError('ICON_SVG_REFERENCE', `The SVG references missing local id #${reference}.`);
    }
  }
  if (!graphicCount) {
    throw iconError('ICON_SVG_NO_GRAPHIC', 'The SVG contains no usable visible graphic after sanitization.');
  }
  return output.join('');
}

module.exports = {
  SVG_NAMESPACE,
  MAX_SVG_BYTES,
  sanitizeSvg,
};
