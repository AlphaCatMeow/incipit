'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CustomIconError } = require('./errors');
const { sanitizeSvg } = require('./svg');
const { inspectTransparentPng, MAX_PNG_BYTES } = require('./png');

const SVG_ICON_NAMES = Object.freeze([
  'claude-logo.svg',
  'claude-logo-pending.svg',
  'claude-logo-done.svg',
]);
const PNG_ICON_NAME = 'claude-logo.png';
const CUSTOM_ICON_NAMES = Object.freeze([...SVG_ICON_NAMES, PNG_ICON_NAME]);

function iconError(code, message, cause = null) {
  return new CustomIconError(code, message, cause);
}

function pngSvgWrapper(pngBytes, width, height) {
  const encoded = pngBytes.toString('base64');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
    `<image width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${encoded}"/>`,
    '</svg>',
  ].join('');
}

// Reads and validates the source exactly once. The returned immutable byte
// plan is what apply writes, preventing the selected file from changing
// between validation and fan-out.
function prepareCustomIcon(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw iconError('ICON_CONFIG_INVALID_PATH', 'The custom icon path must be absolute.');
  }
  const normalized = path.normalize(sourcePath);
  const extension = path.extname(normalized).toLowerCase();
  if (extension !== '.svg' && extension !== '.png') {
    throw iconError('ICON_FORMAT', 'Custom icons must be SVG or PNG files.');
  }
  let stat;
  try {
    stat = fs.statSync(normalized);
  } catch (exc) {
    const message = exc && exc.code === 'ENOENT'
      ? 'The configured custom icon no longer exists.'
      : `The configured custom icon cannot be read: ${exc.message}`;
    throw iconError('ICON_SOURCE_UNREADABLE', message, exc);
  }
  if (!stat.isFile()) throw iconError('ICON_SOURCE_NOT_FILE', 'The custom icon path does not point to a file.');
  if (stat.size <= 0) throw iconError('ICON_SOURCE_EMPTY', 'The custom icon file is empty.');
  if (stat.size > MAX_PNG_BYTES) throw iconError('ICON_SOURCE_TOO_LARGE', 'The custom icon is larger than 5 MB.');

  let sourceBytes;
  try {
    sourceBytes = fs.readFileSync(normalized);
  } catch (exc) {
    throw iconError('ICON_SOURCE_UNREADABLE', `The configured custom icon cannot be read: ${exc.message}`, exc);
  }

  let sourceType;
  let svgBytes;
  let pngBytes = null;
  let dimensions = null;
  if (extension === '.svg') {
    sourceType = 'svg';
    svgBytes = Buffer.from(sanitizeSvg(sourceBytes), 'utf8');
  } else {
    sourceType = 'png';
    dimensions = inspectTransparentPng(sourceBytes);
    pngBytes = sourceBytes;
    svgBytes = Buffer.from(pngSvgWrapper(sourceBytes, dimensions.width, dimensions.height), 'utf8');
  }

  const slots = SVG_ICON_NAMES.map(name => Object.freeze({ name, bytes: svgBytes }));
  if (pngBytes) slots.push(Object.freeze({ name: PNG_ICON_NAME, bytes: pngBytes }));
  return Object.freeze({
    sourcePath: normalized,
    sourceType,
    sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    sourceBytes: sourceBytes.length,
    dimensions,
    slots: Object.freeze(slots),
    restoreOfficialSlots: Object.freeze(sourceType === 'svg' ? [PNG_ICON_NAME] : []),
  });
}

function prepareConfiguredCustomIcon(config) {
  if (!config || config.configured !== true) return null;
  if (config.status !== 'ready' || !config.sourcePath) {
    const messages = {
      'invalid-path': 'The saved custom icon path is invalid. Choose the SVG or PNG again.',
      'not-file': 'The saved custom icon path is not a file. Choose the SVG or PNG again.',
      missing: 'The configured custom icon no longer exists. Choose it again or clear the setting.',
      unreadable: 'The configured custom icon cannot be read. Check its permissions or choose it again.',
    };
    throw iconError(
      'ICON_CONFIG_INVALID',
      messages[config.errorCode] || 'The saved custom icon setting is invalid.',
    );
  }
  return prepareCustomIcon(config.sourcePath);
}

module.exports = {
  CustomIconError,
  SVG_ICON_NAMES,
  PNG_ICON_NAME,
  CUSTOM_ICON_NAMES,
  prepareCustomIcon,
  prepareConfiguredCustomIcon,
};
