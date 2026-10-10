#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('./runtime.cjs');
const core = require('./core.cjs');
const VERSION = require('./version.cjs');

function argumentsOf(argv) {
  const [command = 'help', ...rest] = argv, options = {};
  const known = new Set(['input', 'sizes', 'max-colors', 'out', 'pattern', 'registry', 'brightness', 'contrast', 'saturation', 'sharpness', 'hue', 'after', 'wait-ms']);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    if (!rest[i]?.startsWith('--') || !known.has(key) || rest[i + 1] === undefined || rest[i + 1].startsWith('--') || key in options) throw new Error(`命令参数无效：${rest[i]}`);
    options[key] = rest[i + 1];
  }
  return { command, options };
}
function log(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function progress(value) { process.stderr.write(JSON.stringify(value) + '\n'); }
function required(value, name) { if (!value) throw new Error(`缺少 --${name} 参数。`); return path.resolve(value); }
async function emptyDirectory(dir) {
  await fsp.mkdir(dir, { recursive: true });
  if ((await fsp.readdir(dir)).length) throw new Error('输出目录非空。请选择新的目录，避免覆盖已有图纸。');
}
function ensureExternalOutput(out, input) {
  const resolveFuture = value => {
    let existing = path.resolve(value); const suffix = [];
    while (!fs.existsSync(existing)) { const parent = path.dirname(existing); if (parent === existing) throw new Error('输出路径没有可用的父目录。'); suffix.unshift(path.basename(existing)); existing = parent; }
    return path.join(fs.realpathSync(existing), ...suffix);
  };
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  const realOut = resolveFuture(out), rel = path.relative(root, realOut);
  if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('输出目录不能位于技能安装目录内。');
  if (realOut === resolveFuture(input)) throw new Error('输出路径不能覆盖输入文件。');
}
function generateOptions(o) {
  const input = required(o.input, 'input'), out = required(o.out, 'out');
  const sizes = (o.sizes || '29,48,100,200,300,500').split(',').map(Number);
  if (!sizes.length || sizes.length > 12 || new Set(sizes).size !== sizes.length || !sizes.every(n => Number.isInteger(n) && n >= 4 && n <= 500)) throw new Error('sizes 需要 1～12 个不重复的 4～500 整数，以逗号分隔。');
  const limit = Number(o['max-colors'] || 16);
  const settings = { ...core.neutral };
  for (const key of Object.keys(settings)) if (o[key] !== undefined) settings[key] = Number(o[key]);
  core.validateSettings(settings, limit);
  ensureExternalOutput(out, input);
  return { input, out, sizes, limit, settings };
}
async function generate(o, context = {}) {
  const { input, out, sizes, limit, settings } = generateOptions(o);
  const emit = event => { const value = { ...event, timestamp: new Date().toISOString() }; progress(value); context.onProgress?.(value); };
  emit({ event: 'input-start', phase: 'input', message: '正在读取图片并校正手机照片方向。', total: sizes.length });
  const stat = await fsp.stat(input);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('输入必须是小于 50 MB 的图片文件。');
  const { sharp, ...libs } = runtime.load();
  const exports = require('./export.cjs');
  sharp.cache(false); sharp.concurrency(2);
  const bytes = await fsp.readFile(input);
  const meta = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) throw new Error('首版支持 PNG、JPEG、WebP 图片。');
  if (meta.pages > 1) throw new Error('请提供静态图片；动画图片需要先选择其中一帧。');
  const decoded = await sharp(bytes, { limitInputPixels: 40000000 }).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (context.preparedOut) {
    if ((await fsp.readdir(out)).some(name => name !== '.bead-job')) throw new Error('后台任务输出目录包含已有文件。');
  } else await emptyDirectory(out);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const name = path.basename(input, path.extname(input)).slice(0, 120);
  const manifest = { version: 1, skillVersion: VERSION, status: 'running', sourceFile: path.basename(input), sourceSha256: hash, original: { w: decoded.info.width, h: decoded.info.height }, requestedSizes: sizes, paletteId: core.palette.id, maxColors: limit, settings, variants: [], warnings: ['色卡未经实物校准；PDF 为参考图纸，不是实物 1:1 底板。'], files: {} };
  const writeManifest = () => require('./job.cjs').writeAtomic(path.join(out, 'manifest.json'), manifest);
  await writeManifest();
  for (const size of sizes) {
    const start = performance.now(), { w, h } = core.dimensions(decoded.info.width, decoded.info.height, size);
    const folder = `${String(size).padStart(3, '0')}-grid`, variantDir = path.join(out, folder);
    await fsp.mkdir(variantDir);
    emit({ event: 'variant-start', phase: 'convert', size, w, h, index: manifest.variants.length + 1, total: sizes.length, message: `正在生成 ${size} 格图纸并匹配 Hama 色号。` });
    try {
      const rgba = await sharp(decoded.data, { raw: decoded.info }).resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' }).raw().toBuffer();
      const cells = core.convert(rgba, w, h, limit, settings);
      const pattern = { version: 1, id: crypto.randomUUID(), name: `${name}-${size}格`, w, h, cells, updated: Date.now(), settings: { ...settings, limit }, paletteId: core.palette.id, generator: `bead-pattern-${VERSION}`, conversion: { longEdge: size, sourceSha256: hash, fit: 'contain', alphaThreshold: 100, algorithm: 'CIEDE2000-all-colors' } };
      const stats = core.statistics(pattern);
      const prefix = `${size}-${w}x${h}`;
      const files = await exports.exportPattern(pattern, variantDir, prefix, { sharp, ...libs }, event => emit({ ...event, size, w, h }));
      const count = stats.reduce((sum, c) => sum + c.count, 0);
      manifest.variants.push({ size, w, h, status: 'complete', colorCount: stats.length, totalBeads: count, recommendedBeads: stats.reduce((sum, c) => sum + c.recommended, 0), elapsedMs: Math.round(performance.now() - start), stats, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, path.relative(out, v).split(path.sep).join('/')])) });
      await writeManifest();
      emit({ event: 'variant-complete', phase: 'ready', size, w, h, colors: stats.length, totalBeads: count, files, message: `${size} 格已生成完毕：${w}×${h} 格，${stats.length} 色，${count} 颗豆子，可先下载。` });
    } catch (error) {
      if (error.code === 'BEAD_CANCELLED') throw error;
      manifest.variants.push({ size, w, h, status: 'failed', error: error.message });
      await writeManifest();
      emit({ event: 'variant-failed', phase: 'failed', size, w, h, error: error.message, message: `${size} 格生成失败，其余档位继续处理。` });
    }
    await writeManifest();
    if (global.gc) global.gc();
  }
  const finalStatus = manifest.variants.every(v => v.status === 'complete') ? 'complete' : 'partial';
  manifest.status = 'finalizing';
  manifest.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  await writeManifest();
  try {
  emit({ event: 'batch-stage', phase: 'overview', message: '各档处理已结束，正在制作规格对比总览。' });
  manifest.files = await exports.exportOverview(manifest, out, { sharp, ...libs });
  // Manifest uses portable relative paths; stdout resolves paths for the host.
  manifest.files = Object.fromEntries(Object.entries(manifest.files).map(([k, v]) => [k, path.relative(out, v).split(path.sep).join('/')]));
  manifest.files.manifest = 'manifest.json';
  manifest.files.archive = '拼豆图纸-全部规格.zip';
  await writeManifest();
  emit({ event: 'batch-stage', phase: 'archive', files: { overview: path.join(out, manifest.files.overview), summary: path.join(out, manifest.files.summary) }, message: '对比总览已完成，正在打包全部图纸。' });
  await exports.archiveDirectory(out, path.join(out, manifest.files.archive), libs.zip, { 'manifest.json': Buffer.from(JSON.stringify({ ...manifest, status: finalStatus }, null, 2) + '\n') });
  manifest.status = finalStatus;
  } catch (error) {
    if (error.code === 'BEAD_CANCELLED') throw error;
    manifest.status = 'partial'; manifest.finalizationError = error.message;
    // Only advertise root files that were actually created.
    manifest.files = Object.fromEntries(Object.entries(manifest.files).filter(([, file]) => fs.existsSync(path.join(out, file))));
    emit({ event: 'batch-failed', phase: 'failed', error: error.message, message: '总览或打包失败，已完成的档位文件仍可下载。' });
  }
  await writeManifest();
  return { ...manifest, out, files: Object.fromEntries(Object.entries(manifest.files).map(([k, v]) => [k, path.join(out, v)])), variants: manifest.variants.map(v => ({ ...v, files: v.files ? Object.fromEntries(Object.entries(v.files).map(([k, p]) => [k, path.join(out, p)])) : undefined })) };
}
async function render(o) {
  const input = required(o.pattern, 'pattern'), out = required(o.out, 'out');
  ensureExternalOutput(out, input);
  if ((await fsp.stat(input)).size > 10 * 1024 * 1024) throw new Error('工程文件过大。');
  const pattern = core.validatePattern(JSON.parse(await fsp.readFile(input, 'utf8')));
  const libs = runtime.load();
  libs.sharp.cache(false); libs.sharp.concurrency(2);
  await emptyDirectory(out);
  const files = await require('./export.cjs').exportPattern(pattern, out, `${pattern.w}x${pattern.h}`, libs);
  return { status: 'complete', w: pattern.w, h: pattern.h, totalBeads: core.statistics(pattern).reduce((s, c) => s + c.count, 0), files };
}
async function main() {
  const { command, options } = argumentsOf(process.argv.slice(2));
  if (command === 'doctor') { const d = runtime.doctor(); log(d); if (!d.ready) process.exitCode = 2; }
  else if (command === 'setup') log(runtime.setup(options.registry));
  else if (command === 'generate') { const result = await generate(options); log(result); if (result.status !== 'complete') process.exitCode = 1; }
  else if (command === 'start') log(await require('./job.cjs').start(options, generateOptions));
  else if (command === 'status') log(await require('./job.cjs').status(options));
  else if (command === 'cancel') log(await require('./job.cjs').cancel(options));
  else if (command === 'render') log(await render(options));
  else if (command === 'help') log({ name: 'bead-pattern', version: VERSION, usage: ['doctor', 'setup [--registry HTTPS镜像地址]', 'start --input 图片 --out 新目录 [--sizes 29,48,100,200,300,500]', 'status --out 任务目录 [--after 进度游标] [--wait-ms 5000]', 'cancel --out 任务目录', 'generate --input 图片 --out 新目录 [--sizes 29,48,100,200,300,500] [--max-colors 16]', 'render --pattern 工程.bead.json --out 新目录'], defaults: { sizes: [29, 48, 100, 200, 300, 500], maxColors: 16, palette: core.palette.id, cellPixels: 24 } });
  else throw new Error(`未知命令：${command}`);
}
if (require.main === module) main().catch(error => { log({ status: 'failed', error: error.message }); process.exitCode = 1; });
module.exports = { argumentsOf, generate, render };
