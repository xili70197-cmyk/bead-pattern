'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../scripts/core.cjs');
const { argumentsOf } = require('../scripts/bead.cjs');
const rgba = colors => colors.flatMap(c => [...c, 255]);
const legacy = { Math, Float32Array, Map, postMessage: () => {} };
vm.createContext(legacy);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'fixtures/original-worker.js'), 'utf8'), legacy);
function pattern(cells, w = 4, h = 4) { return { version: 1, id: 'test', name: '测试', w, h, cells }; }

test('CIEDE2000 published reference pairs, including chroma and hue boundaries', () => {
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
    [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0000],
    [[50, -.9009, -85.5211], [50, 0, -82.7485], 1.0000],
    [[50, 0, 0], [50, -1, 2], 2.3669]
  ];
  for (const [a, b, expected] of pairs) {
    assert.ok(Math.abs(core.deltaE(a, b) - expected) < .00005);
    assert.ok(Math.abs(core.deltaE(b, a) - expected) < .00005);
  }
});
test('all 41 exact palette colors preserve the original Hama index ordering', () => {
  assert.deepEqual(core.palette.colors, require('./fixtures/original-hama.json'));
  const colors = Array.from({ length: 64 }, (_, i) => core.rgbs[i % 41]);
  assert.deepEqual(core.convert(rgba(colors), 8, 8, 41), colors.map((_, i) => i % 41));
  assert.equal(core.palette.id, 'hama-midi-20260901-41');
});
test('all-color matching corrects the demonstrated shortlist miss', () => {
  const output = core.convert(rgba(Array(16).fill([146, 97, 114])), 4, 4, 41);
  assert.equal(core.palette.colors[output[0]].id, 'H29');
});
test('original adjustment, transparency, and sharpness match supplied worker numerically', () => {
  let seed = 77;
  const input = new Uint8Array(Array.from({ length: 8 * 8 * 4 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; }));
  const settings = { brightness: 117, contrast: 85, saturation: 135, hue: -12, sharpness: 35 };
  const baseline = legacy.adjust(new Float32Array(input), 8, 8, settings);
  assert.deepEqual(Array.from(core.adjust(input, 8, 8, settings)), Array.from(baseline));
});
test('alpha threshold 99 is empty, 100 is a bead; opaque white remains a bead', () => {
  const pixels = new Uint8Array(rgba(Array(16).fill([244, 243, 236])));
  pixels[3] = 0; pixels[7] = 99; pixels[11] = 100;
  const cells = core.convert(pixels, 4, 4);
  assert.deepEqual(cells.slice(0, 4), [-1, -1, 0, 0]);
  assert.equal(core.statistics(pattern(cells)).reduce((s, c) => s + c.count, 0), 14);
});
test('limit reduction is deterministic and does not create unknown colors', () => {
  const input = rgba(core.rgbs.slice(0, 16));
  const a = core.convert(input, 4, 4, 4), b = core.convert(input, 4, 4, 4);
  assert.deepEqual(a, b); assert.ok(new Set(a).size <= 4);
  assert.ok(a.every(i => i >= 0 && i < 41));
});
test('dimensions preserve landscape/portrait ratios and clamp thin images without stretching', () => {
  for (const size of [29, 48, 100, 200, 300, 500]) {
    assert.deepEqual(core.dimensions(640, 320, size), { w: size, h: Math.round(size / 2) });
    assert.deepEqual(core.dimensions(320, 640, size), { w: Math.round(size / 2), h: size });
  }
  assert.deepEqual(core.dimensions(10000, 1, 29), { w: 29, h: 4 });
  assert.throws(() => core.dimensions(10, 10, 501));
});
test('statistics count exact cells and round each color reserve independently', () => {
  const cells = [0, 0, 0, 1, ...Array(12).fill(-1)];
  const stats = core.statistics(pattern(cells));
  assert.equal(stats.reduce((s, c) => s + c.count, 0), 4);
  assert.equal(stats.reduce((s, c) => s + c.recommended, 0), 6);
  assert.deepEqual(stats.map(c => c.recommended), [4, 2]);
  assert.deepEqual(core.statistics(pattern(Array(16).fill(-1))), []);
  assert.equal(core.statistics(pattern(Array(50).fill(0), 10, 5))[0].recommended, 55);
});
test('legacy projects load; foreign palettes, invalid indices and invalid settings are rejected', () => {
  assert.doesNotThrow(() => core.validatePattern(pattern(Array(16).fill(0))));
  assert.doesNotThrow(() => core.validatePattern({ ...pattern(Array(16).fill(0)), name: '旧'.repeat(200), settings: { ...core.neutral, limit: 0 } }));
  assert.throws(() => core.validatePattern({ ...pattern(Array(16).fill(0)), settings: core.neutral }));
  assert.throws(() => core.validatePattern({ ...pattern(Array(16).fill(0)), source: 'https://invalid.example/image.png' }));
  assert.throws(() => core.validatePattern({ ...pattern(Array(16).fill(0)), paletteId: 'other-brand' }));
  assert.throws(() => core.validatePattern(pattern(Array(16).fill(41))));
  assert.throws(() => core.validatePattern(pattern([0])));
  assert.throws(() => core.validateSettings({ ...core.neutral, hue: NaN }, 16));
});
test('CLI rejects misspelled, duplicate and missing arguments', () => {
  assert.throws(() => argumentsOf(['generate', '--imput', 'photo.png']));
  assert.throws(() => argumentsOf(['generate', '--out']));
  assert.throws(() => argumentsOf(['generate', '--out', 'a', '--out', 'b']));
});
