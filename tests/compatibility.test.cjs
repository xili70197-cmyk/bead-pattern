'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), source = root;
const version = require('../scripts/version.cjs');
const evidence = path.join(require('node:os').tmpdir(), `bead-compatibility-${process.pid}-${Date.now()}`);
const npm = require('../scripts/npm.cjs');
const { writePng } = require('../scripts/png-stream.cjs');
fs.mkdirSync(evidence, { recursive: true });
const records = [];
test('PowerShell 5.1 and 7 parse the BOM wrapper and forward Chinese path arguments', { skip: process.platform !== 'win32' }, () => {
  assert.ok(fs.readFileSync(path.join(source, 'scripts/run.ps1')).subarray(0, 3).equals(Buffer.from([239, 187, 191])));
  for (const [shell, command] of [['powershell.exe', 'generate'], ['pwsh.exe', 'doctor']]) {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(source, 'scripts/run.ps1'), command];
    if (command === 'generate') args.push('--input', path.join(root, 'tests/fixtures/小狐狸 参考图.png'), '--sizes', '29', '--out', path.join(evidence, 'PowerShell 5.1 中文路径'));
    const result = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 100000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (command === 'generate') { assert.equal(json.status, 'complete'); assert.equal(json.variants[0].w, 29); }
    else assert.equal(json.ready, true);
    records.push({ shell, command, status: 'passed' });
  }
});
test('npm.cmd fallback preserves spaces, Chinese, ampersands, parentheses and literal percent arguments', { skip: process.platform !== 'win32' }, () => {
  const folder = path.join(evidence, '包装器 & (中文)'); fs.mkdirSync(folder);
  const script = path.join(folder, 'argv.cjs'), wrapper = path.join(folder, 'npm.cmd');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
  const args = ['ci', '--prefix', path.join(folder, '备料 %BEAD_TEST_TRAP% & (缓存)'), '--registry', 'https://registry.npmmirror.com/?a=1&b=2'];
  const result = npm.run({ kind: 'path', file: wrapper }, args, { env: { ...process.env, BEAD_TEST_TRAP: 'INCORRECT_EXPANSION' }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), args);
  records.push({ test: 'npm.cmd argument preservation', status: 'passed' });
});
test('managed Node without an npm JS layout installs locked dependencies through PATH npm.cmd', { skip: process.platform !== 'win32' }, () => {
  const folder = path.join(evidence, '托管 Node & (全新安装)'), cache = path.join(evidence, '新缓存 %BEAD_TEST_TRAP% & (中文)'); fs.mkdirSync(folder);
  const node = path.join(folder, 'node.exe'); fs.copyFileSync(process.execPath, node);
  const realNpm = npm.find(); assert.equal(realNpm.kind, 'js');
  fs.writeFileSync(path.join(folder, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${realNpm.file}" %*\r\n`);
  const env = { ...process.env, PATH: folder, BEAD_PATTERN_CACHE: cache, BEAD_TEST_TRAP: 'INCORRECT_EXPANSION' }; delete env.Path; delete env.npm_execpath;
  let result = spawnSync(node, [path.join(source, 'scripts/bead.cjs'), 'setup', '--registry', 'https://registry.npmmirror.com'], { env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1000000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout.trim().split('\n').at(-1)); assert.equal(json.ready, true); assert.equal(json.cache, cache);
  assert.equal(fs.existsSync(path.join(folder, 'node_modules/npm/bin/npm-cli.js')), false);
  result = spawnSync(node, [path.join(source, 'scripts/bead.cjs'), 'setup'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ready, true);
  records.push({ test: 'PATH fallback with fresh managed Node and fresh cache', ready: true, cache, node: json.node });
});
test('streamed PNG decodes to exact RGB across strips and has bounded row buffering', async () => {
  const w = 13, h = 31, rgb = Buffer.from(Array.from({ length: w * h * 3 }, (_, i) => (i * 73 + (i >> 6)) % 256));
  async function* strips() { for (let y = 0; y < h; y += 7) yield rgb.subarray(y * w * 3, Math.min(h, y + 7) * w * 3); }
  const out = path.join(evidence, '分块PNG.png'); await writePng(out, w, h, strips());
  const { sharp } = require('../scripts/runtime.cjs').load();
  const result = await sharp(out).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(result.data, rgb); assert.deepEqual([result.info.width, result.info.height], [w, h]);
  assert.equal(fs.existsSync(out + '.tmp'), false);
});
test('a truncated PNG stream fails and never leaves an advertised final or temporary file', async () => {
  const out = path.join(evidence, '不完整.png');
  await assert.rejects(writePng(out, 3, 2, [Buffer.alloc(9)]), /行数不足/);
  assert.equal(fs.existsSync(out), false); assert.equal(fs.existsSync(out + '.tmp'), false);
  const malformed = path.join(evidence, '错字节.png');
  await assert.rejects(writePng(malformed, 3, 2, [Buffer.alloc(8)]), /不完整/);
  assert.equal(fs.existsSync(malformed), false); assert.equal(fs.existsSync(malformed + '.tmp'), false);
});
test('a host with no npm executable gets a clear recovery error', { skip: process.platform !== 'win32' }, () => {
  const folder = path.join(evidence, '完全无npm'); fs.mkdirSync(folder);
  const node = path.join(folder, 'node.exe'); fs.copyFileSync(process.execPath, node);
  const env = { ...process.env, PATH: folder, BEAD_PATTERN_CACHE: path.join(folder, '缓存') }; delete env.Path; delete env.npm_execpath;
  const result = spawnSync(node, [path.join(source, 'scripts/bead.cjs'), 'setup'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 1); assert.match(JSON.parse(result.stdout).error, /未找到可用 npm/);
  records.push({ test: 'no npm executable', status: 'clear recovery error' });
});
test('transient Windows rename locks retry atomically; permanent failures retain the last state', { skip: process.platform !== 'win32' }, () => {
  const { writeAtomic } = require('../scripts/job.cjs');
  const file = path.join(evidence, '受控锁定状态.json'); fs.writeFileSync(file, '{"previous":true}');
  const original = fs.renameSync; let attempts = 0;
  fs.renameSync = (...args) => { if (args[1] === file && ++attempts <= 2) { const e = new Error('受控短暂锁'); e.code = 'EPERM'; throw e; } return original(...args); };
  try { writeAtomic(file, { complete: true }); } finally { fs.renameSync = original; }
  assert.equal(attempts, 3); assert.deepEqual(JSON.parse(fs.readFileSync(file)), { complete: true });
  fs.renameSync = (...args) => { if (args[1] === file) { const e = new Error('受控持续锁'); e.code = 'EACCES'; throw e; } return original(...args); };
  try { assert.throws(() => writeAtomic(file, { incomplete: true }), /受控持续锁/); }
  finally { fs.renameSync = original; }
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { complete: true });
  records.push({ test: 'Windows transient lock retry and permanent lock preservation', status: 'passed' });
});
test.after(() => {
  assert.equal(records.length, process.platform === 'win32' ? 6 : 0);
  fs.writeFileSync(path.join(evidence, 'compatibility-validation.json'), JSON.stringify({ status: 'passed', records }, null, 2));
});
