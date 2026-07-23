'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { sanitizeSvg } = require('../src/custom-icon/svg');
const { inspectTransparentPng } = require('../src/custom-icon/png');
const {
  prepareCustomIcon,
  SVG_ICON_NAMES,
  PNG_ICON_NAME,
} = require('../src/custom-icon');

function testCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(testCrc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function makePng({
  width = 1,
  height = 1,
  bitDepth = 8,
  colorType = 6,
  interlace = 0,
  scanlines,
  palette = null,
  transparency = null,
  extraChunks = [],
}) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const chunks = [pngChunk('IHDR', ihdr)];
  if (palette) chunks.push(pngChunk('PLTE', Buffer.from(palette)));
  if (transparency) chunks.push(pngChunk('tRNS', Buffer.from(transparency)));
  chunks.push(...extraChunks.map(([type, data]) => pngChunk(type, Buffer.from(data))));
  chunks.push(pngChunk('IDAT', zlib.deflateSync(Buffer.from(scanlines))));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([signature, ...chunks]);
}

const safeSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" onload="evil()">',
  '<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs>',
  '<script>alert(1)</script><foreignObject><div>bad</div></foreignObject>',
  '<image href="https://example.invalid/tracker.png"/>',
  '<path id="mark" style="fill:url(#paint);stroke:#000" d="M0 0h16v16z"/>',
  '</svg>',
].join('');
const sanitized = sanitizeSvg(Buffer.from(safeSvg));
assert.ok(sanitized.includes('<path'));
assert.ok(sanitized.includes('fill:url(#paint)'));
assert.ok(!/script|foreignObject|<image|onload|https:/i.test(sanitized));

assert.throws(
  () => sanitizeSvg(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><path d="M0 0"/></svg>')),
  error => error.code === 'ICON_SVG_DOCTYPE',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://evil.invalid/x)" d="M0 0"/></svg>')),
  error => error.code === 'ICON_SVG_EXTERNAL_REFERENCE',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(h\\74tps://evil.invalid/x)" d="M0 0"/></svg>')),
  error => error.code === 'ICON_SVG_EXTERNAL_REFERENCE',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72l(j\\61vascript:alert(1))" d="M0 0"/></svg>')),
  error => error.code === 'ICON_SVG_EXTERNAL_REFERENCE',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use href="#x"/></svg>')),
  error => error.code === 'ICON_SVG_NO_GRAPHIC',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path id="x" id="y" d="M0 0"/></svg>')),
  error => error.code === 'ICON_SVG_XML',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="urn:not-svg"><path d="M0 0"/></svg>')),
  error => error.code === 'ICON_SVG_NAMESPACE',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0">')),
  error => error.code === 'ICON_SVG_XML',
);
assert.throws(
  () => sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><widget/><path d="M0 0"/></svg>')),
  error => error.code === 'ICON_SVG_UNSUPPORTED_ELEMENT',
);

const rgbaTransparent = makePng({ scanlines: [0, 255, 0, 0, 0] });
assert.deepStrictEqual(inspectTransparentPng(rgbaTransparent), {
  width: 1,
  height: 1,
  bitDepth: 8,
  colorType: 6,
  interlaced: false,
});

const rgbaOpaque = makePng({ scanlines: [0, 255, 0, 0, 255] });
assert.throws(() => inspectTransparentPng(rgbaOpaque), error => error.code === 'ICON_PNG_OPAQUE');

const grayscaleTrns = makePng({
  bitDepth: 1,
  colorType: 0,
  transparency: [0, 1],
  scanlines: [0, 0x80],
});
assert.strictEqual(inspectTransparentPng(grayscaleTrns).colorType, 0);

const rgbTrns = makePng({
  colorType: 2,
  transparency: [0, 1, 0, 2, 0, 3],
  scanlines: [0, 1, 2, 3],
});
assert.strictEqual(inspectTransparentPng(rgbTrns).colorType, 2);

const indexedTransparent = makePng({
  bitDepth: 1,
  colorType: 3,
  palette: [255, 0, 0, 0, 0, 255],
  transparency: [255, 0],
  scanlines: [0, 0x80],
});
assert.strictEqual(inspectTransparentPng(indexedTransparent).colorType, 3);

const indexedUnusedAlpha = makePng({
  bitDepth: 1,
  colorType: 3,
  palette: [255, 0, 0, 0, 0, 255],
  transparency: [255, 0],
  scanlines: [0, 0x00],
});
assert.throws(() => inspectTransparentPng(indexedUnusedAlpha), error => error.code === 'ICON_PNG_OPAQUE');

const grayAlpha16 = makePng({
  bitDepth: 16,
  colorType: 4,
  scanlines: [0, 0, 1, 0xff, 0xfe],
});
assert.strictEqual(inspectTransparentPng(grayAlpha16).bitDepth, 16);

const adam7Transparent = makePng({
  colorType: 6,
  interlace: 1,
  scanlines: [0, 1, 2, 3, 0],
});
assert.strictEqual(inspectTransparentPng(adam7Transparent).interlaced, true);

for (const filter of [1, 2, 3, 4]) {
  const filtered = makePng({ scanlines: [filter, 10, 20, 30, 0] });
  assert.strictEqual(inspectTransparentPng(filtered).colorType, 6, `PNG filter ${filter} is decoded`);
}

const corruptCrc = Buffer.from(rgbaTransparent);
corruptCrc[corruptCrc.length - 5] ^= 1;
assert.throws(() => inspectTransparentPng(corruptCrc), error => error.code === 'ICON_PNG_CRC');

const unknownCritical = makePng({
  scanlines: [0, 0, 0, 0, 0],
  extraChunks: [['ABCD', [1]]],
});
assert.throws(() => inspectTransparentPng(unknownCritical), error => error.code === 'ICON_PNG_CRITICAL_CHUNK');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-custom-icon-'));
try {
  const svgPath = path.join(temp, 'custom.svg');
  fs.writeFileSync(svgPath, safeSvg);
  const svgPlan = prepareCustomIcon(svgPath);
  assert.strictEqual(svgPlan.sourceType, 'svg');
  assert.deepStrictEqual(svgPlan.slots.map(slot => slot.name), SVG_ICON_NAMES);
  assert.deepStrictEqual(svgPlan.restoreOfficialSlots, [PNG_ICON_NAME]);
  assert.ok(svgPlan.slots.every(slot => !/script|onload|https:/i.test(slot.bytes.toString('utf8'))));

  const pngPath = path.join(temp, 'custom.png');
  fs.writeFileSync(pngPath, rgbaTransparent);
  const pngPlan = prepareCustomIcon(pngPath);
  assert.strictEqual(pngPlan.sourceType, 'png');
  assert.deepStrictEqual(pngPlan.slots.map(slot => slot.name), [...SVG_ICON_NAMES, PNG_ICON_NAME]);
  const wrapper = pngPlan.slots[0].bytes.toString('utf8');
  assert.match(wrapper, /^<svg[^>]+><image[^>]+href="data:image\/png;base64,/);
  assert.deepStrictEqual(pngPlan.restoreOfficialSlots, []);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('custom-icon tests passed');
