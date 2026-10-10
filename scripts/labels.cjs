'use strict';
// Fixed diagram labels are real outline data, not a renamed/encoded font file.
// PNG uses SVG paths; PDF uses vector Type 3 glyphs with a Unicode mapping.
const fs = require('node:fs');
const path = require('node:path');
let vectors;
function data() {
  if (!vectors) {
    vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/labels/glyphs.json'), 'utf8'));
    if (vectors.format !== 'bead-label-vectors-v1' || !vectors.glyphs['格']) throw new Error('图纸文字资源损坏。');
  }
  return vectors;
}
function layout(text) {
  const v = data(), chars = Array.from(String(text));
  let advance = 0;
  const glyphs = chars.map((char, i) => {
    const glyph = v.glyphs[char];
    if (!glyph) throw new Error(`图纸文字资源不支持字符 U+${char.codePointAt(0).toString(16).toUpperCase()}。`);
    const item = { char, glyph, x: advance };
    advance += glyph.advance + (v.kern[char + (chars[i + 1] || '')] || 0);
    return item;
  });
  return { glyphs, width: advance, unitsPerEm: v.unitsPerEm };
}
function pdfPath(commands) {
  const out = []; let x = 0, y = 0;
  const number = v => String(Math.round(v * 1000000) / 1000000);
  for (const c of commands) {
    const a = c.args;
    if (c.command === 'moveTo' || c.command === 'lineTo') {
      [x, y] = a; out.push(`${a.map(number).join(' ')} ${c.command === 'moveTo' ? 'm' : 'l'}`);
    } else if (c.command === 'quadraticCurveTo') {
      const [cx, cy, ex, ey] = a;
      out.push([x + (cx - x) * 2 / 3, y + (cy - y) * 2 / 3, ex + (cx - ex) * 2 / 3, ey + (cy - ey) * 2 / 3, ex, ey].map(number).join(' ') + ' c');
      x = ex; y = ey;
    } else if (c.command === 'bezierCurveTo') {
      out.push(a.map(number).join(' ') + ' c'); [x, y] = a.slice(-2);
    } else if (c.command === 'closePath') out.push('h');
    else throw new Error(`不支持的矢量字形命令：${c.command}`);
  }
  return out.join('\n') + '\nf\n';
}
function pdfLabels(doc, pdf) {
  const v = data(), entries = Object.entries(v.glyphs), ctx = doc.context;
  const fonts = [], mapping = new Map(), pageFonts = new WeakMap();
  for (let offset = 0; offset < entries.length; offset += 255) {
    const part = entries.slice(offset, offset + 255), procs = {}, widths = [], differences = [0], unicode = [];
    for (let i = 0; i < part.length; i++) {
      const [char, glyph] = part[i], name = `g${i}`;
      const content = `${glyph.advance} 0 ${v.bbox.join(' ')} d1\n${pdfPath(glyph.commands)}`;
      procs[name] = ctx.register(ctx.flateStream(Buffer.from(content, 'ascii')));
      widths.push(glyph.advance); differences.push(pdf.PDFName.of(name));
      const utf16 = Buffer.from(char, 'utf16le'); utf16.swap16();
      unicode.push(`<${i.toString(16).padStart(2, '0')}> <${utf16.toString('hex')}>`);
      mapping.set(char, { font: fonts.length, code: i.toString(16).padStart(2, '0') });
    }
    const blocks = [];
    for (let i = 0; i < unicode.length; i += 100) {
      const block = unicode.slice(i, i + 100);
      blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
    }
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Bead) /Ordering (Unicode) /Supplement 0 >> def\n/CMapName /BeadLabelsUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
    const ref = ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'Type3', Name: `BeadDiagramLabels${fonts.length}`,
      FontBBox: v.bbox, FontMatrix: [1 / v.unitsPerEm, 0, 0, 1 / v.unitsPerEm, 0, 0],
      CharProcs: procs, Encoding: { Type: 'Encoding', Differences: differences },
      FirstChar: 0, LastChar: part.length - 1, Widths: widths, Resources: {},
      ToUnicode: ctx.register(ctx.flateStream(Buffer.from(cmap, 'ascii')))
    }));
    fonts.push(ref);
  }
  return function draw(page, value, x, y, size, hex) {
    let keys = pageFonts.get(page);
    if (!keys) { keys = fonts.map((ref, i) => page.node.newFontDictionary(`BeadDiagramLabels${i}`, ref)); pageFonts.set(page, keys); }
    const color = hex.slice(1).match(/../g).map(h => parseInt(h, 16) / 255).join(' ');
    const run = layout(value), commands = [`q\n${color} rg\nBT`];
    for (const item of run.glyphs) {
      const m = mapping.get(item.char), gx = x + item.x * size / v.unitsPerEm;
      commands.push(`${keys[m.font]} ${size} Tf\n1 0 0 1 ${gx} ${y} Tm\n<${m.code}> Tj`);
    }
    commands.push('ET\nQ\n');
    page.node.addContentStream(ctx.register(ctx.flateStream(Buffer.from(commands.join('\n'), 'ascii'))));
  };
}
module.exports = { data, layout, pdfLabels };
