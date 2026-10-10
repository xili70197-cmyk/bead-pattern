'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const core = require('./core.cjs');
const VERSION = require('./version.cjs');
const CELL = 24;
const labels = require('./labels.cjs');
const theme = { ink: '#233647', muted: '#637181', paper: '#F8F6F0', line: '#C7CECF', accent: '#397781' };
const tileCache = new Map();

function xmlPathText(libs, text, x, y, size, color = theme.ink, align = 'left') {
  const run = labels.layout(text), scale = size / run.unitsPerEm;
  const width = run.width * scale;
  if (align === 'center') x -= width / 2;
  if (align === 'right') x -= width;
  return run.glyphs.map(item => `<path fill="${color}" transform="translate(${x + item.x * scale},${y}) scale(${scale},${-scale})" d="${item.glyph.svg}"/>`).join('');
}
function svg(w, h, body) { return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`); }
function luminance(hex) { const [r, g, b] = hex.slice(1).match(/../g).map(h => parseInt(h, 16)); return .299 * r + .587 * g + .114 * b; }
function csvCell(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }
function csv(rows) { return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
function gridPixels(p) {
  const data = Buffer.alloc(p.w * p.h * 4);
  for (let i = 0; i < p.cells.length; i++) {
    const c = p.cells[i];
    if (c >= 0) { data.set(core.rgbs[c], i * 4); data[i * 4 + 3] = 255; }
  }
  return data;
}
async function preview(p, filename, libs) {
  // Integer nearest-neighbour magnification preserves the independently calculated cells.
  const scale = Math.max(1, Math.floor(1000 / Math.max(p.w, p.h)));
  await libs.sharp(gridPixels(p), { raw: { width: p.w, height: p.h, channels: 4 } }).resize(p.w * scale, p.h * scale, { kernel: 'nearest' }).png().toFile(filename);
}
async function tiles(libs) {
  if (tileCache.size) return tileCache;
  for (let i = -1; i < core.palette.colors.length; i++) {
    const color = i >= 0 ? core.palette.colors[i] : null;
    let body = `<rect width="24" height="24" fill="${color?.hex || '#FFFFFF'}"/><path d="M0 .5H24M.5 0V24" stroke="${theme.line}" stroke-width="1"/>`;
    if (color) body += xmlPathText(libs, color.id, 12, 15, 8, luminance(color.hex) > 145 ? '#17242E' : '#FFFFFF', 'center');
    else body += '<path d="M10 12H14" stroke="#DDE2E3" stroke-width="1"/>';
    const raw = await libs.sharp(svg(24, 24, body)).removeAlpha().raw().toBuffer();
    tileCache.set(i, raw);
  }
  return tileCache;
}
function lineRGB(buffer, w, x0, y0, width, height, rgb, offset = 0) {
  const endY = Math.min(y0 + height, offset + buffer.length / (w * 3));
  for (let y = Math.max(y0, offset); y < endY; y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + width); x++) buffer.set(rgb, ((y - offset) * w + x) * 3);
}
async function chart(p, stats, filename, libs) {
  const left = 96, top = 120, boardW = p.w * CELL, boardH = p.h * CELL;
  const width = Math.max(760, left + boardW + 64), cols = Math.max(1, Math.min(4, Math.floor((width - 96) / 320)));
  const legendY = top + boardH + 78, rows = Math.max(1, Math.ceil(stats.length / cols)), height = legendY + rows * 48 + 68;
  const tileMap = await tiles(libs);
  const total = stats.reduce((s, c) => s + c.count, 0);
  let overlay = xmlPathText(libs, `拼豆图纸 | 长边 ${Math.max(p.w, p.h)} 格`, 40, 47, 30);
  overlay += xmlPathText(libs, `${p.w} × ${p.h} 格   ·   ${stats.length} 色   ·   ${total.toLocaleString('en-US')} 颗   ·   Hama Midi`, 40, 81, 18, theme.muted);
  for (let x = 0; x < p.w; x++) if (x === 0 || (x + 1) % 10 === 0 || x === p.w - 1) overlay += xmlPathText(libs, x + 1, left + x * CELL + 12, top - 12, 11, theme.muted, 'center');
  for (let y = 0; y < p.h; y++) if (y === 0 || (y + 1) % 10 === 0 || y === p.h - 1) overlay += xmlPathText(libs, y + 1, left - 16, top + y * CELL + 16, 11, theme.muted, 'right');
  overlay += xmlPathText(libs, '用豆统计', 40, legendY - 20, 22);
  if (!stats.length) overlay += xmlPathText(libs, '全透明图纸：没有需要放置的豆子。', 40, legendY + 20, 16, theme.muted);
  stats.forEach((c, i) => {
    const x = 40 + (i % cols) * 320, y = legendY + Math.floor(i / cols) * 48;
    overlay += `<rect x="${x}" y="${y}" width="24" height="24" rx="4" fill="${c.hex}" stroke="#ADB5B9"/>`;
    overlay += xmlPathText(libs, `${c.id} · ${c.name}`, x + 36, y + 14, 14);
    overlay += xmlPathText(libs, `${c.count} 颗 / 建议备 ${c.recommended} 颗`, x + 36, y + 34, 13, theme.muted);
  });
  overlay += xmlPathText(libs, '透明空格不放豆 · 建议备料含 10% 余量 · 色卡未经实物校准', 40, height - 24, 14, theme.muted);
  async function* strips() {
    // Bound RGB buffers and SVG rasterization to 192 pixel rows. The PNG writer
    // carries scanline filtering and deflate state continuously across strips.
    for (let offset = 0; offset < height; offset += 192) {
      const stripH = Math.min(192, height - offset), buffer = Buffer.alloc(width * stripH * 3, 255);
      const firstRow = Math.max(0, Math.floor((offset - top) / CELL));
      const lastRow = Math.min(p.h, Math.ceil((offset + stripH - top) / CELL));
      for (let y = firstRow; y < lastRow; y++) for (let x = 0; x < p.w; x++) {
        const tile = tileMap.get(p.cells[y * p.w + x]), y0 = top + y * CELL;
        for (let row = Math.max(0, offset - y0); row < Math.min(CELL, offset + stripH - y0); row++) tile.copy(buffer, ((y0 + row - offset) * width + left + x * CELL) * 3, row * CELL * 3, (row + 1) * CELL * 3);
      }
      for (let x = 0; x <= p.w; x += 10) lineRGB(buffer, width, left + x * CELL, top, 2, boardH, [103, 117, 122], offset);
      for (let y = 0; y <= p.h; y += 10) lineRGB(buffer, width, left, top + y * CELL, boardW, 2, [103, 117, 122], offset);
      lineRGB(buffer, width, left + boardW, top, 1, boardH + 1, [103, 117, 122], offset);
      lineRGB(buffer, width, left, top + boardH, boardW + 1, 1, [103, 117, 122], offset);
      yield await libs.sharp(buffer, { raw: { width, height: stripH, channels: 3 } }).composite([{ input: svg(width, stripH, `<g transform="translate(0 ${-offset})">${overlay}</g>`), left: 0, top: 0 }]).removeAlpha().raw().toBuffer();
    }
  }
  await require('./png-stream.cjs').writePng(filename, width, height, strips());
}

async function pdfDocument(p, stats, filename, libs) {
  const { PDFDocument, StandardFonts, rgb } = libs.pdf;
  const doc = await PDFDocument.create();
  doc.setTitle(`${p.name} - ${p.w}x${p.h}`); doc.setProducer(`bead-pattern ${VERSION}`);
  const chinese = labels.pdfLabels(doc, libs.pdf), latin = await doc.embedFont(StandardFonts.Helvetica);
  const text = (page, value, x, y, size = 10, color = '#233647') => {
    const [r, g, b] = color.slice(1).match(/../g).map(h => parseInt(h, 16) / 255);
    if (/^[\x20-\x7e]+$/.test(String(value))) page.drawText(String(value), { x, y, size, font: latin, color: rgb(r, g, b) });
    else chinese(page, value, x, y, size, color);
  };
  const tw = 5.5 * 72 / 25.4, x0 = 51, yTop = 723;
  const pageCount = Math.ceil(p.w / 32) * Math.ceil(p.h / 32) + 1;
  // Encode cell labels once, avoiding repeated font shaping for every bead.
  const encoded = new Map(core.palette.colors.map(c => [c.id, latin.encodeText(c.id)]));
  const number = value => String(Math.round(value * 1000000) / 1000000);
  let pageNumber = 0;
  for (let oy = 0; oy < p.h; oy += 32) for (let ox = 0; ox < p.w; ox += 32) {
    const page = doc.addPage([595.28, 841.89]); pageNumber++;
    text(page, `拼豆图纸 | ${p.w} × ${p.h} 格`, 36, 802, 17);
    text(page, `第 ${pageNumber} / ${pageCount} 页   行 ${oy + 1}-${Math.min(oy + 32, p.h)}   列 ${ox + 1}-${Math.min(ox + 32, p.w)}`, 36, 780, 10);
    text(page, 'Hama Midi · 每格 5.5 mm · 制作参考图纸，非实物 1:1 底板', 36, 760, 9, theme.muted);
    const fontKey = page.node.newFontDictionary(latin.name, latin.ref);
    const commands = [];
    for (let y = oy; y < Math.min(oy + 32, p.h); y++) for (let x = ox; x < Math.min(ox + 32, p.w); x++) {
      const cell = p.cells[y * p.w + x], bx = x0 + (x - ox) * tw, by = yTop - (y - oy + 1) * tw;
      const color = cell >= 0 ? core.rgbs[cell] : [255, 255, 255];
      commands.push(`q\n${color.map(v => number(v / 255)).join(' ')} rg\n0.7 0.75 0.77 RG\n0.2 w\n${number(bx)} ${number(by)} ${number(tw)} ${number(tw)} re\nB\nQ\n`);
      if (cell >= 0) {
        const c = core.palette.colors[cell], tc = luminance(c.hex) > 145 ? .1 : 1;
        const labelW = latin.widthOfTextAtSize(c.id, 5.1);
        commands.push(`q\n${tc} ${tc} ${tc} rg\nBT\n${fontKey} 5.1 Tf\n1 0 0 1 ${number(bx + (tw - labelW) / 2)} ${number(by + tw / 2 - 1.8)} Tm\n${encoded.get(c.id)} Tj\nET\nQ\n`);
      }
    }
    // One compressed content stream per page avoids retaining millions of small
    // pdf-lib operator objects for 250,000 cells. Geometry remains vector data.
    page.node.addContentStream(doc.context.register(doc.context.flateStream(Buffer.from(commands.join(''), 'ascii'))));
    page.resetPosition(); // Coordinates and bold lines must paint above the cell stream.
    const nx = Math.min(32, p.w - ox), ny = Math.min(32, p.h - oy);
    for (let i = 0; i < nx; i++) text(page, ox + i + 1, x0 + i * tw + 3, yTop + 6, 5.5, theme.muted);
    for (let i = 0; i < ny; i++) text(page, oy + i + 1, 29, yTop - (i + .7) * tw, 5.5, theme.muted);
    for (let x = ox; x <= ox + nx; x++) if (x % 10 === 0) page.drawLine({ start: { x: x0 + (x - ox) * tw, y: yTop }, end: { x: x0 + (x - ox) * tw, y: yTop - ny * tw }, thickness: .7, color: rgb(.35, .42, .45) });
    for (let y = oy; y <= oy + ny; y++) if (y % 10 === 0) page.drawLine({ start: { x: x0, y: yTop - (y - oy) * tw }, end: { x: x0 + nx * tw, y: yTop - (y - oy) * tw }, thickness: .7, color: rgb(.35, .42, .45) });
    text(page, '透明格不放豆。购买前核对实物色号；打印时保持页面比例。', 36, 45, 9, theme.muted);
  }
  const page = doc.addPage([595.28, 841.89]);
  text(page, '用豆统计与备料清单', 36, 802, 19);
  text(page, `${p.w} × ${p.h} 格 · ${stats.length} 色 · 共 ${stats.reduce((s, c) => s + c.count, 0)} 颗`, 36, 775, 11);
  text(page, '色块 / 色号', 36, 742, 10); text(page, '色名', 148, 742, 10); text(page, '精确用量', 365, 742, 10); text(page, '建议备料 (+10%)', 445, 742, 10);
  stats.forEach((c, i) => {
    const y = 713 - i * 15;
    page.drawRectangle({ x: 37, y: y - 2, width: 11, height: 11, color: rgb(...core.rgbs[c.i].map(v => v / 255)), borderColor: rgb(.7, .75, .77), borderWidth: .3 });
    text(page, c.id, 59, y, 9); text(page, c.name, 148, y, 9); text(page, c.count, 370, y, 9); text(page, c.recommended, 465, y, 9);
  });
  if (!stats.length) text(page, '全透明图纸：无需备豆。', 36, 706, 11);
  text(page, `第 ${pageCount} / ${pageCount} 页 · 色卡版本 ${core.palette.id}`, 36, 68, 9, theme.muted);
  text(page, '建议数量按各色独立向上取整；色卡未经实物校准。', 36, 45, 9, theme.muted);
  await fsp.writeFile(filename, await doc.save());
}

async function exportPattern(p, out, prefix, libs, onProgress = () => {}) {
  const stats = core.statistics(p), files = {
    chart: path.join(out, `${prefix}-色号图纸.png`), pdf: path.join(out, `${prefix}-打印图纸.pdf`), csv: path.join(out, `${prefix}-用豆清单.csv`), pattern: path.join(out, `${prefix}.bead.json`), preview: path.join(out, `${prefix}-预览.png`)
  };
  await fsp.writeFile(files.pattern, JSON.stringify(p) + '\n');
  await fsp.writeFile(files.csv, csv([['色号', '色名', '颜色HEX', '精确用量', '建议备料(+10%)'], ...stats.map(c => [c.id, c.name, c.hex, c.count, c.recommended])]));
  await preview(p, files.preview, libs);
  onProgress({ event: 'variant-stage', phase: 'chart', files: { preview: files.preview }, message: `${Math.max(p.w, p.h)} 格预览已就绪，正在生成带色号图纸。` });
  await chart(p, stats, files.chart, libs);
  onProgress({ event: 'variant-stage', phase: 'pdf', files: { preview: files.preview, chart: files.chart }, message: `${Math.max(p.w, p.h)} 格色号 PNG 已就绪，正在导出 A4 分页 PDF。` });
  if (global.gc) global.gc();
  await pdfDocument(p, stats, files.pdf, libs);
  for (const file of Object.values(files)) if (!(await fsp.stat(file)).size) throw new Error(`导出文件为空：${path.basename(file)}`);
  return files;
}

async function exportOverview(manifest, out, libs) {
  const variants = manifest.variants, cols = 3, cardW = 440, cardH = 410, rows = Math.ceil(variants.length / cols), width = 1424, height = 164 + rows * cardH + 68;
  let body = `<rect width="${width}" height="${height}" fill="${theme.paper}"/>`;
  body += xmlPathText(libs, `${variants.length} 种规格，选你喜欢的细节`, 40, 56, 34);
  body += xmlPathText(libs, `同一原图独立转换 · Hama 41 色色卡 · 每档最多 ${manifest.maxColors} 色`, 40, 93, 17, theme.muted);
  const overlays = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i], x = 40 + (i % cols) * (cardW + 12), y = 128 + Math.floor(i / cols) * cardH;
    body += `<rect x="${x}" y="${y}" width="${cardW}" height="${cardH - 16}" rx="14" fill="#FFFFFF" stroke="#DFE3DF"/>`;
    body += xmlPathText(libs, `${v.size} 格`, x + 22, y + 34, 22);
    if (v.status === 'complete') {
      body += xmlPathText(libs, `${v.w} × ${v.h} 格 · ${v.colorCount} 色`, x + 22, y + 61, 15, theme.muted);
      body += xmlPathText(libs, `${v.totalBeads.toLocaleString('en-US')} 颗豆子`, x + 22, y + 355, 21, theme.accent);
      body += xmlPathText(libs, `建议备料合计 ${v.recommendedBeads.toLocaleString('en-US')} 颗`, x + 22, y + 380, 13, theme.muted);
      const previewFile = path.join(out, v.files.preview);
      const box = await libs.sharp(previewFile).resize(390, 248, { fit: 'contain', kernel: 'nearest', background: '#F3F5F2' }).png().toBuffer();
      overlays.push({ input: box, left: x + 25, top: y + 80 });
    } else body += xmlPathText(libs, '本档生成失败，可单独重试', x + 22, y + 185, 18, '#A14F40');
  }
  body += xmlPathText(libs, '颜色数和豆子数量按实际矩阵统计 · 透明空格不放豆 · 色卡未经实物校准', 40, height - 27, 15, theme.muted);
  const overview = path.join(out, '规格对比总览.png'), summary = path.join(out, '全部规格统计.csv');
  await libs.sharp(svg(width, height, body)).composite(overlays).png().toFile(overview);
  await fsp.writeFile(summary, csv([['长边格数', '宽格数', '高格数', '状态', '实际颜色数', '精确总豆数', '建议备料合计'], ...variants.map(v => [v.size, v.w, v.h, v.status, v.colorCount ?? '', v.totalBeads ?? '', v.recommendedBeads ?? ''])]));
  return { overview, summary };
}
async function archiveDirectory(root, output, zip, overrides = {}) {
  const files = {};
  async function visit(dir) {
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, item.name);
      if (dir === root && item.name === '.bead-job') continue;
      if (item.isDirectory()) await visit(filename);
      else if (filename !== output && filename !== output + '.tmp') files[path.relative(root, filename).split(path.sep).join('/')] = new Uint8Array(await fsp.readFile(filename));
    }
  }
  await visit(root);
  for (const [name, bytes] of Object.entries(overrides)) files[name] = new Uint8Array(bytes);
  const temporary = output + '.tmp';
  await fsp.writeFile(temporary, zip.zipSync(files, { level: 6 }));
  await fsp.rename(temporary, output);
}
module.exports = { exportPattern, exportOverview, archiveDirectory, gridPixels, csv, CELL };
