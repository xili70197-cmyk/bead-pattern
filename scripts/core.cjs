'use strict';
const fs = require('node:fs');
const path = require('node:path');
const palette = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/palettes/hama.json'), 'utf8'));
const neutral = Object.freeze({ brightness: 100, contrast: 100, saturation: 100, sharpness: 0, hue: 0 });

// Extracted from the supplied conversion worker. All Lab values use D65.
function lab(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92; });
  const xyz = [(r * .4124564 + g * .3575761 + b * .1804375) / .95047, r * .2126729 + g * .7151522 + b * .072175, (r * .0193339 + g * .119192 + b * .9503041) / 1.08883].map(v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

function deltaE(a, b) {
  const rad = Math.PI / 180, atan = (y, x) => (Math.atan2(y, x) / rad + 360) % 360;
  let [L1, a1, b1] = a, [L2, a2, b2] = b;
  let C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), cm = (C1 + C2) / 2;
  const G = .5 * (1 - Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)));
  a1 *= 1 + G; a2 *= 1 + G; C1 = Math.hypot(a1, b1); C2 = Math.hypot(a2, b2);
  const h1 = atan(b1, a1), h2 = atan(b2, a2), dl = L2 - L1, dc = C2 - C1;
  let dh = h2 - h1;
  if (C1 * C2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin(dh * rad / 2), lm = (L1 + L2) / 2;
  cm = (C1 + C2) / 2;
  const hm = C1 * C2 === 0 ? h1 + h2 : Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2;
  const T = 1 - .17 * Math.cos((hm - 30) * rad) + .24 * Math.cos(2 * hm * rad) + .32 * Math.cos((3 * hm + 6) * rad) - .2 * Math.cos((4 * hm - 63) * rad);
  const sl = 1 + .015 * (lm - 50) ** 2 / Math.sqrt(20 + (lm - 50) ** 2), sc = 1 + .045 * cm, sh = 1 + .015 * cm * T;
  const rt = -2 * Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-1 * ((hm - 275) / 25) ** 2) * rad);
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}

function adjust(pixels, w, h, a = neutral) {
  const data = new Float32Array(pixels);
  const angle = a.hue * Math.PI / 180, cs = Math.cos(angle), sn = Math.sin(angle), contrast = a.contrast / 100, sat = a.saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 100) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const nr = (.213 + .787 * cs - .213 * sn) * r + (.715 - .715 * cs - .715 * sn) * g + (.072 - .072 * cs + .928 * sn) * b;
    const ng = (.213 - .213 * cs + .143 * sn) * r + (.715 + .285 * cs + .140 * sn) * g + (.072 - .072 * cs - .283 * sn) * b;
    const nb = (.213 - .213 * cs - .787 * sn) * r + (.715 - .715 * cs + .715 * sn) * g + (.072 + .928 * cs + .072 * sn) * b;
    const gray = .2126 * nr + .7152 * ng + .0722 * nb;
    [nr, ng, nb].forEach((v, k) => { data[i + k] = Math.max(0, Math.min(255, ((gray + (v - gray) * sat) * a.brightness / 100 - 128) * contrast + 128)); });
  }
  if (a.sharpness) {
    const old = data.slice(), amount = a.sharpness / 100;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (old[i + 3] < 100) continue;
      const ns = [i - 4, i + 4, i - w * 4, i + w * 4].filter(j => old[j + 3] >= 100);
      if (!ns.length) continue;
      for (let k = 0; k < 3; k++) data[i + k] = Math.max(0, Math.min(255, old[i + k] + amount * (old[i + k] - ns.reduce((s, j) => s + old[j + k], 0) / ns.length)));
    }
  }
  return data;
}

const rgbs = palette.colors.map(c => c.hex.slice(1).match(/../g).map(h => parseInt(h, 16)));
const labs = rgbs.map(lab);

function dimensions(width, height, longEdge) {
  if (![width, height, longEdge].every(Number.isInteger) || width < 1 || height < 1 || longEdge < 4 || longEdge > 500) throw new Error('尺寸无效；长边格数必须是 4～500 的整数。');
  const scale = longEdge / Math.max(width, height);
  return { w: Math.max(4, Math.round(width * scale)), h: Math.max(4, Math.round(height * scale)) };
}

function validateSettings(a, limit) {
  for (const [key, low, high] of [['brightness', 0, 200], ['contrast', 0, 200], ['saturation', 0, 200], ['sharpness', 0, 100], ['hue', -180, 180]]) {
    if (!Number.isFinite(a[key]) || a[key] < low || a[key] > high) throw new Error(`${key} 必须在 ${low}～${high} 之间。`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > palette.colors.length) throw new Error('max-colors 必须是 1～41 的整数。');
}

function convert(pixels, w, h, limit = 16, settings = neutral) {
  validateSettings(settings, limit);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 4 || h < 4 || w > 500 || h > 500 || pixels.length !== w * h * 4) throw new Error('RGBA 数据长度或图纸尺寸无效。');
  const data = adjust(pixels, w, h, settings);
  const cells = new Array(w * h), cache = new Map();
  let ids = palette.colors.map((_, i) => i);
  const nearest = i => {
    const offset = i * 4, r = data[offset], g = data[offset + 1], b = data[offset + 2];
    // Exact floating-point keys retain adjustment precision; cache is reset per palette subset.
    const key = `${r},${g},${b}`;
    if (cache.has(key)) return cache.get(key);
    const color = lab([r, g, b]);
    let best = -1, distance = Infinity;
    for (const id of ids) { const d = deltaE(color, labs[id]); if (d < distance) { best = id; distance = d; } }
    cache.set(key, best); return best;
  };
  const counts = new Array(ids.length).fill(0);
  for (let i = 0; i < cells.length; i++) { cells[i] = data[i * 4 + 3] < 100 ? -1 : nearest(i); if (cells[i] >= 0) counts[cells[i]]++; }
  const used = ids.filter(i => counts[i] > 0);
  if (used.length > limit) {
    ids = used.sort((a, b) => counts[b] - counts[a] || a - b).slice(0, limit); cache.clear();
    for (let i = 0; i < cells.length; i++) if (cells[i] >= 0) cells[i] = nearest(i);
  }
  return cells;
}

function validatePattern(p) {
  if (!p || p.version !== 1 || typeof p.id !== 'string' || typeof p.name !== 'string' || !Number.isInteger(p.w) || !Number.isInteger(p.h) || p.w < 4 || p.h < 4 || p.w > 500 || p.h > 500 || !Array.isArray(p.cells) || p.cells.length !== p.w * p.h || !p.cells.every(c => Number.isInteger(c) && c >= -1 && c < palette.colors.length)) throw new Error('工程无效：需要原网站 v1 格式和有效的 Hama 41 色索引。');
  if (p.paletteId && p.paletteId !== palette.id) throw new Error('工程色卡版本不匹配，不能按 Hama 索引重新解释。');
  if (p.settings) {
    if (!Number.isInteger(p.settings.limit) || p.settings.limit < 0 || p.settings.limit > 41) throw new Error('工程 settings.limit 必须是 0～41 的整数。');
    validateSettings(p.settings, p.settings.limit || 41);
  }
  if (p.source && (typeof p.source !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(p.source))) throw new Error('工程 source 必须是原网站支持的图片 data URL。');
  return p;
}

function statistics(p) {
  validatePattern(p);
  const counts = new Map();
  for (const i of p.cells) if (i >= 0) counts.set(i, (counts.get(i) || 0) + 1);
  // Integer multiplication avoids 50 * 1.1 becoming 55.00000000000001.
  return [...counts].map(([i, count]) => ({ ...palette.colors[i], i, count, recommended: Math.ceil(count * 11 / 10) })).sort((a, b) => b.count - a.count || a.i - b.i);
}

module.exports = { palette, neutral, lab, deltaE, adjust, dimensions, convert, validatePattern, statistics, validateSettings, rgbs };
