'use strict';
const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createDeflate } = require('node:zlib');
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i; for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length, 0); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++) crc = crcTable[(crc ^ result[i]) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}
async function writePng(filename, width, height, strips) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 20000)) throw new Error('PNG 尺寸无效。');
  const rowBytes = width * 3, temporary = filename + '.tmp';
  async function* filtered() {
    let previous = Buffer.alloc(rowBytes), rows = 0;
    for await (const rgb of strips) {
      if (!Buffer.isBuffer(rgb) || rgb.length % rowBytes) throw new Error('PNG 分块数据不完整。');
      const count = rgb.length / rowBytes, block = Buffer.allocUnsafe((rowBytes + 1) * count);
      for (let y = 0; y < count; y++) {
        if (++rows > height) throw new Error('PNG 行数超过指定尺寸。');
        const source = rgb.subarray(y * rowBytes, (y + 1) * rowBytes), offset = y * (rowBytes + 1);
        // PNG filter 2 (Up); carry the previous row across strip boundaries.
        block[offset] = 2;
        for (let i = 0; i < rowBytes; i++) block[offset + 1 + i] = (source[i] - previous[i]) & 255;
        previous = source;
      }
      previous = Buffer.from(previous); yield block;
    }
    if (rows !== height) throw new Error('PNG 行数不足。');
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  let first = true;
  const encoder = new Transform({
    transform(data, encoding, callback) {
      if (first) { this.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); this.push(chunk('IHDR', header)); this.push(chunk('sRGB', Buffer.from([0]))); first = false; }
      callback(null, chunk('IDAT', data));
    },
    flush(callback) { callback(null, chunk('IEND')); }
  });
  try {
    await pipeline(Readable.from(filtered(), { objectMode: false, highWaterMark: 65536 }), createDeflate({ level: 6 }), encoder, fs.createWriteStream(temporary, { flags: 'wx' }));
    await fs.promises.rename(temporary, filename);
  } catch (error) { await fs.promises.rm(temporary, { force: true }); throw error; }
}
module.exports = { writePng };
