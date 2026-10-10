'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function invocation(launcher, args, env = process.env) {
  if (launcher.kind === 'js') return { command: process.execPath, args: [launcher.file, ...args], env };
  if (process.platform !== 'win32') return { command: launcher.file, args, env };
  // .cmd needs cmd.exe. Keep values in individually quoted environment arguments,
  // rather than interpolating user paths/URLs into shell source or using shell:true.
  const childEnv = { ...env };
  const tokens = [launcher.file, ...args].map((value, i) => {
    if (/["\r\n\0]/.test(value)) throw new Error('npm 参数含不支持的引号或控制字符。');
    childEnv[`BEAD_NPM_VALUE_${i}`] = value;
    return `"%BEAD_NPM_VALUE_${i}%"`;
  });
  return { command: env.ComSpec || path.join(env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe'), args: ['/d', '/s', '/c', `"${tokens.join(' ')}"`], env: childEnv };
}
function run(launcher, args, options = {}) {
  const call = invocation(launcher, args, options.env || process.env);
  return spawnSync(call.command, call.args, { ...options, env: call.env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: launcher.kind === 'path' && process.platform === 'win32' });
}
function find(env = process.env) {
  const dirs = [path.dirname(process.execPath), ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(d => d.replace(/^"|"$/g, ''))];
  const candidates = dirs.flatMap(dir => [path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js')]);
  if (env.npm_execpath) candidates.unshift(env.npm_execpath);
  if (process.platform !== 'win32') {
    for (const dir of dirs) {
      try { const real = fs.realpathSync(path.join(dir, 'npm')); if (path.basename(real) === 'npm-cli.js') candidates.push(real); } catch {}
    }
    candidates.push('/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js');
  }
  const cli = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (cli) return { kind: 'js', file: cli };
  // Managed hosts can expose an npm shim whose actual JS lives in an ASAR archive.
  // Invoke the host's wrapper instead of trying to read inside that archive.
  for (const dir of dirs) {
    const file = path.join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!fs.existsSync(file)) continue;
    const launcher = { kind: 'path', file };
    const probe = run(launcher, ['--version'], { env, timeout: 30000, maxBuffer: 100000 });
    if (!probe.error && probe.status === 0 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/m.test(probe.stdout.trim())) return launcher;
  }
  throw new Error('未找到可用 npm。请使用宿主提供的 npm/npm.cmd，或安装附带 npm 的 Node.js 并加入 PATH，然后重试 setup。');
}
module.exports = { find, run };
