'use strict';

const zlib = require('zlib');
const { CustomIconError } = require('./errors');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 5 * 1024 * 1024;
const MAX_PNG_DIMENSION = 4096;
const MAX_PNG_PIXELS = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_COUNT = 10000;
const ADAM7_PASSES = Object.freeze([
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]);

function iconError(code, message, cause = null) {
  return new CustomIconError(code, message, cause);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(typeBuffer, data) {
  let crc = 0xffffffff;
  for (const buffer of [typeBuffer, data]) {
    for (let i = 0; i < buffer.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function legalBitDepth(colorType, bitDepth) {
  const legal = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return Boolean(legal[colorType] && legal[colorType].includes(bitDepth));
}

function channelsForColorType(colorType) {
  return { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 0;
}

function passLength(size, start, step) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function scanlineLayout(width, height, bitsPerPixel, interlace) {
  const passes = interlace === 1 ? ADAM7_PASSES : [[0, 0, 1, 1]];
  let total = 0;
  const layout = [];
  for (const [xStart, yStart, xStep, yStep] of passes) {
    const passWidth = passLength(width, xStart, xStep);
    const passHeight = passLength(height, yStart, yStep);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    const passBytes = passHeight * (rowBytes + 1);
    if (!Number.isSafeInteger(passBytes) || total + passBytes > MAX_DECODED_BYTES) {
      throw iconError('ICON_PNG_DECODE_LIMIT', 'The PNG would require too much decoded memory.');
    }
    total += passBytes;
    layout.push({ width: passWidth, height: passHeight, rowBytes });
  }
  return { total, passes: layout };
}

function parsePngChunks(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (!buffer.length) throw iconError('ICON_PNG_EMPTY', 'The PNG file is empty.');
  if (buffer.length > MAX_PNG_BYTES) throw iconError('ICON_PNG_TOO_LARGE', 'The PNG file is larger than 5 MB.');
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw iconError('ICON_PNG_SIGNATURE', 'The selected .png file does not have a valid PNG signature.');
  }

  let offset = 8;
  let chunkCount = 0;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  let seenIdat = false;
  let idatEnded = false;
  let seenIend = false;

  while (offset < buffer.length) {
    chunkCount++;
    if (chunkCount > MAX_CHUNK_COUNT) throw iconError('ICON_PNG_COMPLEXITY', 'The PNG contains too many chunks.');
    if (buffer.length - offset < 12) throw iconError('ICON_PNG_TRUNCATED', 'The PNG contains a truncated chunk.');
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) throw iconError('ICON_PNG_TRUNCATED', 'The PNG chunk length is invalid.');
    const typeBuffer = buffer.subarray(offset + 4, offset + 8);
    const type = typeBuffer.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type) || /[a-z]/.test(type[2])) {
      throw iconError('ICON_PNG_CHUNK_TYPE', 'The PNG contains an invalid chunk type.');
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32(typeBuffer, data) !== expectedCrc) {
      throw iconError('ICON_PNG_CRC', `The PNG ${type} chunk failed its integrity check.`);
    }
    offset = dataEnd + 4;

    if (!ihdr && type !== 'IHDR') throw iconError('ICON_PNG_ORDER', 'IHDR must be the first PNG chunk.');
    if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      throw iconError('ICON_PNG_CRITICAL_CHUNK', `The PNG uses unsupported critical chunk ${type}.`);
    }
    if (seenIend) throw iconError('ICON_PNG_TRAILING_DATA', 'The PNG contains data after IEND.');
    if (seenIdat && type !== 'IDAT') idatEnded = true;

    if (type === 'IHDR') {
      if (ihdr || length !== 13) throw iconError('ICON_PNG_IHDR', 'The PNG has an invalid IHDR chunk.');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (!width || !height || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION ||
          width * height > MAX_PNG_PIXELS) {
        throw iconError('ICON_PNG_DIMENSIONS', 'The PNG dimensions exceed the 4096 px / 16 megapixel icon limit.');
      }
      if (!legalBitDepth(colorType, bitDepth) || compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) {
        throw iconError('ICON_PNG_IHDR', 'The PNG uses an unsupported color, compression, filter, or interlace mode.');
      }
      ihdr = { width, height, bitDepth, colorType, interlace };
    } else if (type === 'PLTE') {
      if (seenIdat || palette || !length || length % 3 !== 0 || length > 768) {
        throw iconError('ICON_PNG_PALETTE', 'The PNG has an invalid palette.');
      }
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      if (seenIdat || transparency) throw iconError('ICON_PNG_TRANSPARENCY', 'The PNG has an invalid tRNS chunk.');
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      if (idatEnded) throw iconError('ICON_PNG_ORDER', 'PNG IDAT chunks must be consecutive.');
      seenIdat = true;
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      if (length !== 0 || !seenIdat) throw iconError('ICON_PNG_IEND', 'The PNG has an invalid IEND chunk.');
      seenIend = true;
      if (offset !== buffer.length) throw iconError('ICON_PNG_TRAILING_DATA', 'The PNG contains data after IEND.');
    }
  }

  if (!ihdr || !seenIdat || !seenIend) throw iconError('ICON_PNG_INCOMPLETE', 'The PNG is missing required chunks.');
  const paletteEntries = palette ? palette.length / 3 : 0;
  if (ihdr.colorType === 3 && (!palette || paletteEntries > (1 << ihdr.bitDepth))) {
    throw iconError('ICON_PNG_PALETTE', 'Indexed PNG icons require a valid palette.');
  }
  if ((ihdr.colorType === 0 || ihdr.colorType === 4) && palette) {
    throw iconError('ICON_PNG_PALETTE', 'This PNG color type cannot contain a palette.');
  }
  if (transparency) {
    if (ihdr.colorType === 0 && transparency.length !== 2) {
      throw iconError('ICON_PNG_TRANSPARENCY', 'The grayscale PNG has an invalid tRNS chunk.');
    }
    if (ihdr.colorType === 2 && transparency.length !== 6) {
      throw iconError('ICON_PNG_TRANSPARENCY', 'The RGB PNG has an invalid tRNS chunk.');
    }
    if (ihdr.colorType === 3 && (!transparency.length || transparency.length > paletteEntries)) {
      throw iconError('ICON_PNG_TRANSPARENCY', 'The indexed PNG has an invalid tRNS chunk.');
    }
    if (ihdr.colorType === 4 || ihdr.colorType === 6) {
      throw iconError('ICON_PNG_TRANSPARENCY', 'PNG images with alpha channels cannot also contain tRNS.');
    }
  }
  return { buffer, ihdr, paletteEntries, transparency, idat };
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterRow(filterType, raw, previous, bytesPerPixel) {
  const row = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const above = previous ? previous[i] : 0;
    const upperLeft = previous && i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
    let value;
    if (filterType === 0) value = raw[i];
    else if (filterType === 1) value = raw[i] + left;
    else if (filterType === 2) value = raw[i] + above;
    else if (filterType === 3) value = raw[i] + Math.floor((left + above) / 2);
    else if (filterType === 4) value = raw[i] + paethPredictor(left, above, upperLeft);
    else throw iconError('ICON_PNG_FILTER', `The PNG uses invalid scanline filter ${filterType}.`);
    row[i] = value & 0xff;
  }
  return row;
}

function readSample(row, sampleIndex, bitDepth) {
  if (bitDepth === 8) return row[sampleIndex];
  if (bitDepth === 16) return row.readUInt16BE(sampleIndex * 2);
  const perByte = 8 / bitDepth;
  const byte = row[Math.floor(sampleIndex / perByte)];
  const shift = 8 - bitDepth - (sampleIndex % perByte) * bitDepth;
  return (byte >>> shift) & ((1 << bitDepth) - 1);
}

function rowHasTransparency(row, width, metadata) {
  const { bitDepth, colorType } = metadata.ihdr;
  const max = bitDepth === 16 ? 0xffff : ((1 << bitDepth) - 1);
  const trns = metadata.transparency;
  for (let x = 0; x < width; x++) {
    if (colorType === 4) {
      if (readSample(row, x * 2 + 1, bitDepth) < max) return true;
    } else if (colorType === 6) {
      if (readSample(row, x * 4 + 3, bitDepth) < max) return true;
    } else if (colorType === 3) {
      const index = readSample(row, x, bitDepth);
      if (index >= metadata.paletteEntries) throw iconError('ICON_PNG_PALETTE', 'The PNG references a missing palette entry.');
      if (trns && index < trns.length && trns[index] < 0xff) return true;
    } else if (colorType === 0 && trns) {
      if (readSample(row, x, bitDepth) === trns.readUInt16BE(0)) return true;
    } else if (colorType === 2 && trns) {
      const base = x * 3;
      if (readSample(row, base, bitDepth) === trns.readUInt16BE(0) &&
          readSample(row, base + 1, bitDepth) === trns.readUInt16BE(2) &&
          readSample(row, base + 2, bitDepth) === trns.readUInt16BE(4)) return true;
    }
  }
  return false;
}

// Validates PNG structure and pixels, returning dimensions only when at least
// one actually used pixel is transparent. Merely having an alpha channel or an
// unused tRNS entry is deliberately insufficient for an activity-bar mask.
function inspectTransparentPng(input) {
  const metadata = parsePngChunks(input);
  const channels = channelsForColorType(metadata.ihdr.colorType);
  const bitsPerPixel = channels * metadata.ihdr.bitDepth;
  const layout = scanlineLayout(
    metadata.ihdr.width,
    metadata.ihdr.height,
    bitsPerPixel,
    metadata.ihdr.interlace,
  );
  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(metadata.idat), { maxOutputLength: layout.total + 1 });
  } catch (exc) {
    throw iconError('ICON_PNG_DECODE', 'The PNG pixel data could not be decoded safely.', exc);
  }
  if (inflated.length !== layout.total) {
    throw iconError('ICON_PNG_DECODE', 'The PNG pixel data length does not match its dimensions.');
  }

  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  let offset = 0;
  let hasTransparency = false;
  for (const pass of layout.passes) {
    let previous = null;
    for (let y = 0; y < pass.height; y++) {
      const filterType = inflated[offset++];
      const raw = inflated.subarray(offset, offset + pass.rowBytes);
      offset += pass.rowBytes;
      const row = unfilterRow(filterType, raw, previous, bytesPerPixel);
      if (rowHasTransparency(row, pass.width, metadata)) hasTransparency = true;
      previous = row;
    }
  }
  if (!hasTransparency) {
    throw iconError(
      'ICON_PNG_OPAQUE',
      'The PNG has a solid background. Use a transparent-background PNG or an SVG.',
    );
  }
  return {
    width: metadata.ihdr.width,
    height: metadata.ihdr.height,
    bitDepth: metadata.ihdr.bitDepth,
    colorType: metadata.ihdr.colorType,
    interlaced: metadata.ihdr.interlace === 1,
  };
}

module.exports = {
  PNG_SIGNATURE,
  MAX_PNG_BYTES,
  crc32,
  inspectTransparentPng,
};
