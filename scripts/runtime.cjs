'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const VERSION = require('./version.cjs');

const dependencies = Object.freeze({ sharp: '0.34.5', 'pdf-lib': '1.17.1', fflate: '0.8.2' });
const lockPath = path.join(__dirname, '../assets/runtime/package-lock.json');
const signature = crypto.createHash('sha256').update(JSON.stringify(dependencies)).update(fs.readFileSync(lockPath)).digest('hex').slice(0, 12);
const cache = process.env.BEAD_PATTERN_CACHE || path.join(os.homedir(), '.cache', 'bead-pattern', `${VERSION}-${process.platform}-${process.arch}-${signature}`);

function load() {
  const req = createRequire(path.join(cache, 'package.json'));
  for (const [name, version] of Object.entries(dependencies)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(cache, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
    if (pkg.version !== version) throw new Error(`依赖版本不符：${name}，需要 ${version}`);
  }
  return { sharp: req('sharp'), pdf: req('pdf-lib'), zip: req('fflate') };
}

function requireSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 9)) throw new Error('需要 Node.js 20.9 或以上版本。请使用宿主提供的 Node.js 或安装受支持版本。');
}
function doctor() {
  requireSupportedNode();
  try {
    for (const resource of ['../assets/labels/glyphs.json', '../assets/palettes/hama.json']) if (!fs.statSync(path.join(__dirname, resource)).size) throw new Error(`资源为空：${resource}`);
    require('./labels.cjs').data();
    load(); return { ready: true, node: process.versions.node, platform: process.platform, arch: process.arch, cache, dependencies };
  }
  catch (error) { return { ready: false, node: process.versions.node, cache, dependencies, recovery: '运行 node scripts/bead.cjs setup，然后重试 doctor。', reason: error.message }; }
}

function setup(registry) {
  requireSupportedNode();
  // Check in a separate process: loading sharp in this process before npm ci
  // would lock its DLL on Windows and prevent repairing an existing cache.
  const check = spawnSync(process.execPath, [path.join(__dirname, 'bead.cjs'), 'doctor'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (!check.error && check.status === 0) {
    try { const ready = JSON.parse(check.stdout.trim()); if (ready.ready) return ready; } catch {}
  }
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'package.json'), JSON.stringify({ name: 'bead-pattern-runtime', version: '1.0.0', private: true, dependencies }, null, 2));
  fs.copyFileSync(lockPath, path.join(cache, 'package-lock.json'));
  const npm = require('./npm.cjs');
  const args = ['ci', '--include=optional', '--no-audit', '--no-fund', '--prefix', cache];
  if (registry) {
    const url = new URL(registry);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('依赖镜像必须是无凭据的 HTTPS 地址。');
    args.push('--registry', url.href);
  }
  const result = npm.run(npm.find(), args, { cwd: cache, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`依赖安装失败：${result.error?.message || `退出码 ${result.status}`}。可以通过 --registry 指定可用的 HTTPS 镜像后重试。`);
  return doctor();
}

module.exports = { load, doctor, setup, dependencies, cache };
