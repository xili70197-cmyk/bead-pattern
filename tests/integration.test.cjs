'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const core = require('../scripts/core.cjs');
const runtime = require('../scripts/runtime.cjs');
const { generate } = require('../scripts/bead.cjs');
const exporter = require('../scripts/export.cjs');
const root = path.resolve(__dirname, '..'), fixtures = path.join(__dirname, 'fixtures');
const cli = path.join(root, 'scripts/bead.cjs');
const evidence = path.resolve(process.env.BEAD_TEST_OUT || path.join(require('node:os').tmpdir(), `bead-integration-${process.pid}-${Date.now()}`));
fs.mkdirSync(evidence, { recursive: true });
const context = { d: core.palette.colors };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(fixtures, 'original-v1-validator.js'), 'utf8'), context);
function run(...args) {
  const r = spawnSync(process.execPath, ['--expose-gc', cli, ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 4000000, windowsHide: true });
  assert.ifError(r.error);
  const json = JSON.parse(r.stdout.trim().split('\n').at(-1));
  return { code: r.status, json, stderr: r.stderr };
}
function matrix(v) { return JSON.parse(fs.readFileSync(v.files.pattern, 'utf8')); }
function generateCase(input, folder, sizes = '29') {
  const r = run('generate', '--input', path.join(fixtures, input), '--sizes', sizes, '--out', path.join(evidence, folder));
  assert.equal(r.code, 0, JSON.stringify(r.json)); return r.json;
}
let six;
test('six real conversions, original browser validator, and independent source calculation', async () => {
  six = generateCase('小狐狸 参考图.png', '验收六档', '29,48,100,200,300,500');
  assert.equal(six.status, 'complete'); assert.equal(six.variants.length, 6);
  const { sharp, zip } = runtime.load();
  const decoded = await sharp(path.join(fixtures, '小狐狸 参考图.png')).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const v of six.variants) {
    assert.deepEqual([v.w, v.h], [v.size, Math.round(v.size / 2)]);
    const p = matrix(v); assert.equal(context.u(p), true);
    const scaled = await sharp(decoded.data, { raw: decoded.info }).resize(v.w, v.h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' }).raw().toBuffer();
    assert.deepEqual(p.cells, core.convert(scaled, v.w, v.h, 16));
    assert.ok(v.colorCount <= 16); assert.equal(v.totalBeads, p.cells.filter(c => c >= 0).length);
    assert.deepEqual(v.stats, core.statistics(p));
  }
  const unpacked = zip.unzipSync(fs.readFileSync(six.files.archive));
  assert.equal(Object.keys(unpacked).length, 33);
  for (const v of six.variants) for (const file of Object.values(v.files)) {
    const relative = path.relative(six.out, file).split(path.sep).join('/');
    assert.deepEqual(Buffer.from(unpacked[relative]), fs.readFileSync(file));
  }
});
test('portrait preserves aspect ratio', () => {
  const r = generateCase('竖版小狐狸.png', '竖图验收');
  assert.deepEqual([r.variants[0].w, r.variants[0].h], [15, 29]);
});
test('EXIF rotation is applied before target dimensions', () => {
  const r = generateCase('手机方向.jpg', '手机方向验收');
  assert.deepEqual(r.original, { w: 640, h: 320 });
  assert.deepEqual([r.variants[0].w, r.variants[0].h], [29, 15]);
});
test('white background is retained and counted', () => {
  const r = generateCase('白色.png', '白色验收'), v = r.variants[0];
  assert.equal(v.colorCount, 1); assert.equal(v.totalBeads, v.w * v.h);
  assert.equal(v.stats[0].id, 'H01');
});
test('transparent input has zero beads and a complete printable result', () => {
  const r = generateCase('全透明.png', '透明验收');
  assert.equal(r.variants[0].totalBeads, 0); assert.equal(r.variants[0].colorCount, 0);
});
test('very thin input gets transparent padding rather than four filled rows', () => {
  const r = generateCase('极细横图.png', '长图验收'), p = matrix(r.variants[0]);
  assert.deepEqual([p.w, p.h], [29, 4]);
  assert.ok(p.cells.filter(c => c >= 0).length <= 29); assert.ok(p.cells.includes(-1));
});
test('corrupt files, invalid flags and overwrites fail cleanly', () => {
  const bad = run('generate', '--input', path.join(fixtures, '损坏图片.png'), '--out', path.join(evidence, '损坏图片验收'));
  assert.equal(bad.code, 1); assert.equal(bad.json.status, 'failed');
  assert.equal(fs.existsSync(path.join(evidence, '损坏图片验收')), false);
  assert.equal(run('generate', '--input', path.join(fixtures, '白色.png'), '--out', path.join(evidence, '白色验收')).code, 1);
  assert.equal(run('generate', '--sizes', '29,29').code, 1);
});
test('v1 project renders offline and retains all cells and exact quantities', () => {
  const p = matrix(six.variants[0]);
  const r = run('render', '--pattern', six.variants[0].files.pattern, '--out', path.join(evidence, '工程重导验收'));
  assert.equal(r.code, 0); assert.deepEqual(JSON.parse(fs.readFileSync(r.json.files.pattern)), p);
  assert.deepEqual(fs.readFileSync(r.json.files.csv), fs.readFileSync(six.variants[0].files.csv));
  assert.deepEqual(fs.readFileSync(r.json.files.chart), fs.readFileSync(six.variants[0].files.chart));
});
test('legacy website template can be exported without new metadata', () => {
  const old = JSON.parse(fs.readFileSync(path.join(fixtures, 'sample-fox.json'), 'utf8'));
  const p = { version: 1, id: 'legacy-fox', name: '旧网站工程', w: old.w, h: old.h, cells: old.cells.map(c => c == null ? -1 : core.palette.colors.findIndex(p => p.id === c)) };
  assert.equal(context.u(p), true);
  const filename = path.join(evidence, '旧网站v1.bead.json'); fs.writeFileSync(filename, JSON.stringify(p));
  const r = run('render', '--pattern', filename, '--out', path.join(evidence, '旧工程验收'));
  assert.equal(r.code, 0); assert.deepEqual(JSON.parse(fs.readFileSync(r.json.files.pattern)), p);
});
test('controlled single-size export failure retains completed sizes and can rerun', async () => {
  const original = exporter.exportPattern;
  exporter.exportPattern = (p, ...args) => { if (p.w === 48) throw new Error('验收注入的单档导出错误'); return original(p, ...args); };
  let r;
  try { r = await generate({ input: path.join(fixtures, '小狐狸 参考图.png'), sizes: '29,48,100', out: path.join(evidence, '部分失败验收') }); }
  finally { exporter.exportPattern = original; }
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.variants.map(v => v.status), ['complete', 'failed', 'complete']);
  assert.ok(fs.statSync(r.variants[0].files.pdf).size > 0); assert.ok(fs.statSync(r.variants[2].files.pdf).size > 0);
  const retry = generateCase('小狐狸 参考图.png', '单档重跑验收', '48');
  assert.deepEqual(matrix(retry.variants[0]).cells, matrix(six.variants[1]).cells);
});
test('500 square chart and PDF export with sequential memory use', () => {
  const r = generateCase('方图小狐狸.png', '500方图二验收', '500'), v = r.variants[0];
  assert.deepEqual([v.w, v.h], [500, 500]); assert.ok(v.colorCount <= 16);
  assert.equal(context.u(matrix(v)), true);
  fs.writeFileSync(path.join(evidence, '500方图-result.json'), JSON.stringify(r, null, 2));
});
