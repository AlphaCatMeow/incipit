'use strict';

const crypto = require('crypto');

const GENERATED_TOKEN_PREFIX = '--ink-';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function maskComments(source) {
  let output = '';
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === '\\' && index + 1 < source.length) {
        output += source[index + 1];
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      output += '  ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index >= source.length) throw new Error('Unterminated CSS comment.');
      output += '  ';
      index += 1;
      continue;
    }
    output += char;
  }
  if (quote) throw new Error('Unterminated CSS string.');
  return output;
}

function canonicalWhitespace(value) {
  let output = '';
  let quote = null;
  let pendingSpace = false;
  const source = String(value).trim();
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === '\\' && index + 1 < source.length) {
        output += source[index + 1];
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (pendingSpace && output) output += ' ';
      pendingSpace = false;
      quote = char;
      output += char;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output) output += ' ';
    pendingSpace = false;
    output += char;
  }
  return output
    .replace(/\s*,\s*/g, ',')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/#[0-9a-f]{3,8}\b/gi, match => match.toLowerCase());
}

function normalizeSelector(selector) {
  return canonicalWhitespace(selector)
    .replace(/\s*([>+~])\s*/g, '$1')
    .replace(/\s*,\s*/g, ',');
}

function splitTopLevel(source, delimiter) {
  const parts = [];
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth -= 1;
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth -= 1;
    else if (char === delimiter && parenDepth === 0 && bracketDepth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
    if (parenDepth < 0 || bracketDepth < 0) throw new Error('Unbalanced CSS grouping.');
  }
  if (quote || parenDepth !== 0 || bracketDepth !== 0) throw new Error('Unbalanced CSS grouping.');
  parts.push(source.slice(start));
  return parts;
}

function findTopLevelColon(source) {
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth -= 1;
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth -= 1;
    else if (char === ':' && parenDepth === 0 && bracketDepth === 0) return index;
  }
  return -1;
}

function findBlockDelimiter(source, start, end) {
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth -= 1;
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth -= 1;
    else if (parenDepth === 0 && bracketDepth === 0 && (char === '{' || char === ';')) {
      return { index, char };
    }
  }
  return null;
}

function findMatchingBrace(source, opening, end) {
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 1;
  for (let index = opening + 1; index < end; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth -= 1;
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth -= 1;
    else if (parenDepth === 0 && bracketDepth === 0 && char === '{') braceDepth += 1;
    else if (parenDepth === 0 && bracketDepth === 0 && char === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return index;
    }
  }
  throw new Error('Unterminated CSS block.');
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function parseDeclarations(block, absoluteStart, selectors, context, sourceName, starts, declarations) {
  let localOffset = 0;
  const parts = splitTopLevel(block, ';');
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const rawPart = parts[partIndex];
    const rawPartStart = localOffset;
    const leading = rawPart.search(/\S/);
    const partOffset = leading < 0 ? localOffset : localOffset + leading;
    localOffset += rawPart.length + 1;
    const text = rawPart.trim();
    if (!text) continue;
    const colon = findTopLevelColon(text);
    if (colon <= 0) throw new Error(`Malformed declaration in ${sourceName}:${lineAt(starts, absoluteStart + partOffset)}.`);
    const property = text.slice(0, colon).trim().toLowerCase();
    const afterColon = text.slice(colon + 1);
    const valueLeading = (afterColon.match(/^\s*/) || [''])[0].length;
    let value = afterColon.slice(valueLeading).trimEnd();
    const importantMatch = value.match(/\s*!important\s*$/i);
    const important = Boolean(importantMatch);
    if (important) value = value.slice(0, importantMatch.index).trimEnd();
    if (!/^--[-_a-z0-9]+$/i.test(property) && !/^-?[_a-z][-_a-z0-9]*$/i.test(property)) {
      throw new Error(`Malformed property ${property} in ${sourceName}:${lineAt(starts, absoluteStart + partOffset)}.`);
    }
    const textStart = rawPartStart + leading;
    const valueStart = absoluteStart + textStart + colon + 1 + valueLeading;
    const valueEnd = valueStart + value.length;
    const statementStart = absoluteStart + rawPartStart;
    const statementEnd = absoluteStart + rawPartStart + rawPart.length +
      (partIndex < parts.length - 1 ? 1 : 0);
    for (const selector of selectors) {
      declarations.push({
        context: context.join(' / '),
        selector,
        property,
        value: canonicalWhitespace(value),
        important,
        line: lineAt(starts, absoluteStart + partOffset),
        source: sourceName,
        selectorGroup: selectors.join(','),
        statementStart,
        statementEnd,
        valueStart,
        valueEnd,
      });
    }
  }
}

function parseStylesheet(css, sourceName = 'inline.css') {
  const source = maskComments(String(css));
  const starts = lineStarts(source);
  const declarations = [];
  const declarationAtRules = new Set(['font-face', 'page', 'property', 'counter-style']);
  const atRuleCounts = new Map();

  function parseRange(start, end, context) {
    let cursor = start;
    while (cursor < end) {
      while (cursor < end && /\s/.test(source[cursor])) cursor += 1;
      if (cursor >= end) break;
      const delimiter = findBlockDelimiter(source, cursor, end);
      if (!delimiter) {
        if (source.slice(cursor, end).trim()) {
          throw new Error(`Unexpected trailing CSS in ${sourceName}:${lineAt(starts, cursor)}.`);
        }
        break;
      }
      const prelude = canonicalWhitespace(source.slice(cursor, delimiter.index));
      if (!prelude) throw new Error(`Empty CSS prelude in ${sourceName}:${lineAt(starts, cursor)}.`);
      if (delimiter.char === ';') {
        if (!prelude.startsWith('@')) {
          throw new Error(`Unexpected top-level statement in ${sourceName}:${lineAt(starts, cursor)}.`);
        }
        cursor = delimiter.index + 1;
        continue;
      }
      const close = findMatchingBrace(source, delimiter.index, end);
      const bodyStart = delimiter.index + 1;
      const body = source.slice(bodyStart, close);
      if (prelude.startsWith('@')) {
        const nameMatch = prelude.match(/^@([a-z-]+)/i);
        if (!nameMatch) throw new Error(`Malformed at-rule in ${sourceName}:${lineAt(starts, cursor)}.`);
        const name = nameMatch[1].toLowerCase();
        if (declarationAtRules.has(name)) {
          const countKey = `${context.join(' / ')}\u0000${prelude}`;
          const occurrence = (atRuleCounts.get(countKey) || 0) + 1;
          atRuleCounts.set(countKey, occurrence);
          parseDeclarations(
            body,
            bodyStart,
            [`${normalizeSelector(prelude)}#${occurrence}`],
            context,
            sourceName,
            starts,
            declarations,
          );
        } else {
          parseRange(bodyStart, close, [...context, normalizeSelector(prelude)]);
        }
      } else {
        const selectors = splitTopLevel(prelude, ',')
          .map(normalizeSelector)
          .filter(Boolean);
        if (!selectors.length) throw new Error(`Empty selector in ${sourceName}:${lineAt(starts, cursor)}.`);
        parseDeclarations(body, bodyStart, selectors, context, sourceName, starts, declarations);
      }
      cursor = close + 1;
    }
  }

  parseRange(0, source.length, []);
  return declarations.map((declaration, order) => ({ ...declaration, order }));
}

function declarationKey(declaration) {
  return `${declaration.context}\u0001${declaration.selector}\u0001${declaration.property}`;
}

function declarationSignature(declaration) {
  return `${declarationKey(declaration)}\u0001${declaration.important ? '!' : ''}`;
}

function buildFinalMap(stylesheets) {
  const final = new Map();
  let globalOrder = 0;
  for (const declarations of stylesheets) {
    for (const declaration of declarations) {
      const candidate = { ...declaration, globalOrder };
      globalOrder += 1;
      const key = declarationKey(candidate);
      const previous = final.get(key);
      if (!previous ||
          (candidate.important && !previous.important) ||
          candidate.important === previous.important) {
        final.set(key, candidate);
      }
    }
  }
  return final;
}

function findClosingParen(value, opening) {
  let quote = null;
  let depth = 1;
  for (let index = opening + 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function variableEnvironment(finalMap, declaration) {
  const variables = new Map();
  for (const candidate of finalMap.values()) {
    if (!candidate.property.startsWith('--')) continue;
    const sameGlobalRoot = candidate.context === '' && candidate.selector === ':root';
    const sameContextRoot = candidate.context === declaration.context && candidate.selector === ':root';
    const sameRule = candidate.context === declaration.context && candidate.selector === declaration.selector;
    if (sameGlobalRoot || sameContextRoot || sameRule) variables.set(candidate.property, candidate.value);
  }
  return variables;
}

function splitVarArguments(value) {
  const parts = splitTopLevel(value, ',');
  return {
    name: parts.shift().trim(),
    fallback: parts.length ? parts.join(',').trim() : null,
  };
}

function resolveValue(value, variables, stack = []) {
  const source = String(value);
  let output = '';
  let cursor = 0;
  const varPattern = /var\s*\(/ig;
  while (cursor < source.length) {
    varPattern.lastIndex = cursor;
    const match = varPattern.exec(source);
    if (!match) {
      output += source.slice(cursor);
      break;
    }
    output += source.slice(cursor, match.index);
    const opening = source.indexOf('(', match.index);
    const closing = findClosingParen(source, opening);
    if (closing < 0) throw new Error(`Unterminated var() in ${source}.`);
    const whole = source.slice(match.index, closing + 1);
    const { name, fallback } = splitVarArguments(source.slice(opening + 1, closing));
    if (!/^--[-_a-z0-9]+$/i.test(name)) throw new Error(`Invalid custom property reference ${name}.`);
    if (variables.has(name)) {
      if (stack.includes(name)) throw new Error(`Cyclic custom property reference: ${[...stack, name].join(' -> ')}`);
      output += resolveValue(variables.get(name), variables, [...stack, name]);
    } else if (fallback !== null) {
      output += resolveValue(fallback, variables, stack);
    } else {
      output += whole;
    }
    cursor = closing + 1;
  }
  return canonicalWhitespace(output);
}

function resolvedRecords(finalMap) {
  return [...finalMap.entries()]
    .filter(([, declaration]) => !declaration.property.startsWith(GENERATED_TOKEN_PREFIX))
    .map(([key, declaration]) => ({
      key,
      important: declaration.important,
      resolved: resolveValue(declaration.value, variableEnvironment(finalMap, declaration)),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function createBaseline(themeCss, warmCss, metadata = {}) {
  const themeDeclarations = parseStylesheet(themeCss, 'data/theme.css');
  const warmDeclarations = parseStylesheet(warmCss, 'data/warm-white-override.css');
  const darkFinal = buildFinalMap([themeDeclarations]);
  const warmFinal = buildFinalMap([themeDeclarations, warmDeclarations]);
  return {
    version: 1,
    generatedFrom: metadata.generatedFrom || 'pre-tokenization worktree',
    sources: {
      themeSha256: sha256(themeCss),
      warmWhiteSha256: sha256(warmCss),
    },
    themeSequence: themeDeclarations
      .filter(declaration => !declaration.property.startsWith(GENERATED_TOKEN_PREFIX))
      .map(declarationSignature),
    warmSequence: warmDeclarations
      .filter(declaration => !declaration.property.startsWith(GENERATED_TOKEN_PREFIX))
      .map(declarationSignature),
    dark: resolvedRecords(darkFinal),
    warmWhite: resolvedRecords(warmFinal),
  };
}

function assertSequenceEqual(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new Error(`${label} declaration sequence length changed: expected ${expected.length}, got ${actual.length}.`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label} declaration sequence changed at ${index}: expected ${expected[index]}, got ${actual[index] || '<missing>'}.`);
    }
  }
}

function assertSequenceSubset(actual, expected, label) {
  const counts = new Map();
  for (const signature of expected) counts.set(signature, (counts.get(signature) || 0) + 1);
  for (const signature of actual) {
    const remaining = counts.get(signature) || 0;
    if (remaining <= 0) throw new Error(`${label} contains an unexpected declaration: ${signature}.`);
    counts.set(signature, remaining - 1);
  }
}

function assertRecordsMatch(actualMap, expectedRecords, label) {
  for (const expected of expectedRecords) {
    const actual = actualMap.get(expected.key);
    if (!actual) throw new Error(`${label} lost selector/property contract ${expected.key}.`);
    if (actual.important !== expected.important) {
      throw new Error(`${label} changed !important for ${expected.key}.`);
    }
    if (actual.resolved !== expected.resolved) {
      throw new Error(
        `${label} changed ${expected.key}: expected ${expected.resolved}, got ${actual.resolved}.`,
      );
    }
  }
}

function recordsToMap(finalMap) {
  return new Map(resolvedRecords(finalMap).map(record => [record.key, record]));
}

function verifyBaseline(themeCss, warmCss, baseline) {
  if (!baseline || baseline.version !== 1) throw new Error('Unsupported theme oracle baseline.');
  const themeDeclarations = parseStylesheet(themeCss, 'data/theme.css');
  const warmDeclarations = parseStylesheet(warmCss, 'data/warm-white-override.css');
  const themeSequence = themeDeclarations
    .filter(declaration => !declaration.property.startsWith(GENERATED_TOKEN_PREFIX))
    .map(declarationSignature);
  const warmSequence = warmDeclarations
    .filter(declaration => !declaration.property.startsWith(GENERATED_TOKEN_PREFIX))
    .map(declarationSignature);
  assertSequenceEqual(themeSequence, baseline.themeSequence, 'warm-black');
  assertSequenceSubset(warmSequence, baseline.warmSequence, 'warm-white override');

  const darkFinal = buildFinalMap([themeDeclarations]);
  const warmFinal = buildFinalMap([themeDeclarations, warmDeclarations]);
  assertRecordsMatch(recordsToMap(darkFinal), baseline.dark, 'warm-black');
  assertRecordsMatch(recordsToMap(warmFinal), baseline.warmWhite, 'warm-white');
  return {
    darkContracts: baseline.dark.length,
    warmWhiteContracts: baseline.warmWhite.length,
    themeDeclarations: themeDeclarations.length,
    warmDeclarations: warmDeclarations.length,
  };
}

module.exports = {
  GENERATED_TOKEN_PREFIX,
  buildFinalMap,
  canonicalWhitespace,
  createBaseline,
  declarationKey,
  parseStylesheet,
  recordsToMap,
  resolvedRecords,
  resolveValue,
  sha256,
  verifyBaseline,
};
