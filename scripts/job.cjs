'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const VERSION = require('./version.cjs');
const terminal = status => ['complete', 'partial', 'failed', 'cancelled'].includes(status);
function writeAtomic(filename, value) {
  const temporary = filename + '.tmp';
  const bytes = JSON.stringify(value, null, 2) + '\n';
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, filename); return; }
    catch (error) {
      // Windows scanners/readers can briefly hold a destination file. Retry the
      // atomic replacement; never unlink the previous valid state as a fallback.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, 10 * 2 ** attempt));
    }
  }
}
function jobPaths(out) {
  const dir = path.join(path.resolve(out), '.bead-job');
  return { dir, request: path.join(dir, 'request.json'), state: path.join(dir, 'state.json'), events: path.join(dir, 'events.ndjson'), pid: path.join(dir, 'worker.pid'), cancel: path.join(dir, 'cancel.flag'), log: path.join(dir, 'worker.log') };
}
async function start(options, validate) {
  const parsed = validate(options), { input, out, sizes } = parsed;
  const stat = await fs.promises.stat(input);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('输入必须是小于 50 MB 的图片文件。');
  await fs.promises.mkdir(out, { recursive: true });
  if ((await fs.promises.readdir(out)).length) throw new Error('输出目录非空。请选择新的目录，避免重复启动或覆盖已有图纸。');
  const paths = jobPaths(out); fs.mkdirSync(paths.dir);
  const jobId = crypto.randomUUID(), startedAt = new Date().toISOString();
  const state = { version: 1, skillVersion: VERSION, jobId, status: 'starting', startedAt, updatedAt: startedAt, cursor: 0, requestedSizes: sizes, completedSizes: [], variants: [], files: {}, current: { phase: 'starting', size: null, message: '生成任务已启动，正在准备读取图片。' } };
  writeAtomic(paths.state, state);
  writeAtomic(paths.request, { jobId, options: { ...options, input, out }, startedAt });
  const log = fs.openSync(paths.log, 'a');
  try {
    const child = spawn(process.execPath, ['--expose-gc', path.join(__dirname, 'job-worker.cjs'), paths.request], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    fs.writeFileSync(paths.pid, String(child.pid)); child.unref();
    return { status: 'starting', jobId, out, pid: child.pid, cursor: 0, requestedSizes: sizes, message: state.current.message, next: '调用 status --out 同一目录 --after 0 --wait-ms 5000，持续查询至结束。' };
  } catch (error) {
    state.status = 'failed'; state.error = error.message; writeAtomic(paths.state, state); throw error;
  } finally { fs.closeSync(log); }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function restoreCompleted(state, out, manifest) {
  state.variants = manifest.variants.filter(v => v.status === 'failed' || (v.status === 'complete' && Object.values(v.files || {}).every(file => fs.existsSync(path.join(out, file)))))
    .map(v => ({ ...v, files: v.files ? Object.fromEntries(Object.entries(v.files).map(([key, file]) => [key, path.join(out, file)])) : undefined }));
  state.completedSizes = state.variants.filter(v => v.status === 'complete').map(v => v.size);
  state.files = Object.fromEntries(Object.entries(manifest.files || {}).filter(([, file]) => fs.existsSync(path.join(out, file))).map(([key, file]) => [key, path.join(out, file)]));
}
function readState(out) {
  const paths = jobPaths(out);
  let state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  const pid = fs.existsSync(paths.pid) ? Number(fs.readFileSync(paths.pid, 'utf8')) : state.pid;
  if (!terminal(state.status) && !alive(pid) && Date.now() - Date.parse(state.startedAt) > 2000) {
    // Re-read to avoid racing with a worker's final successful write and exit.
    state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    if (!terminal(state.status)) {
      state.status = 'failed'; state.error = '后台进程已退出，任务未完整完成。已完成档位仍可下载。';
      const manifestFile = path.join(path.resolve(out), 'manifest.json');
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        restoreCompleted(state, path.resolve(out), manifest);
        if (['complete', 'partial'].includes(manifest.status)) {
          state.status = manifest.status; delete state.error;
          state.result = { ...manifest, out: path.resolve(out), files: state.files, variants: state.variants };
        } else { manifest.status = 'failed'; manifest.error = state.error; writeAtomic(manifestFile, manifest); }
      }
      state.current = { phase: 'failed', size: null, message: state.error };
      if (state.status !== 'failed') state.current = { phase: 'finished', size: null, message: '任务已结束，可下载完成的文件。' };
      state.updatedAt = new Date().toISOString(); writeAtomic(paths.state, state);
    }
  }
  const cancelled = fs.existsSync(paths.cancel) && !terminal(state.status);
  return { ...state, status: cancelled ? 'cancelling' : state.status, out: path.resolve(out), pid, elapsedMs: Date.now() - Date.parse(state.startedAt), updatedAgoMs: Date.now() - Date.parse(state.updatedAt), completedCount: state.completedSizes.length, total: state.requestedSizes.length, workerAlive: alive(pid) && !terminal(state.status), diagnosticLog: paths.log };
}
async function status(options) {
  if (!options.out) throw new Error('缺少 --out 参数。');
  const after = Number(options.after ?? -1), wait = Number(options['wait-ms'] ?? 0);
  if (!Number.isInteger(after) || after < -1 || !Number.isInteger(wait) || wait < 0 || wait > 10000) throw new Error('after 需要非负整数，wait-ms 需要 0～10000 毫秒。');
  const startTime = Date.now(); let state = readState(options.out);
  while (!terminal(state.status) && state.cursor <= after && Date.now() - startTime < wait) {
    await new Promise(resolve => setTimeout(resolve, 100)); state = readState(options.out);
  }
  const eventsFile = jobPaths(options.out).events;
  const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).filter(e => e.cursor > after && e.cursor <= state.cursor) : [];
  return { ...state, events: events.slice(-40) };
}
async function cancel(options) {
  if (!options.out) throw new Error('缺少 --out 参数。');
  const state = readState(options.out);
  if (terminal(state.status)) return state;
  fs.writeFileSync(jobPaths(options.out).cancel, new Date().toISOString());
  return { ...state, status: 'cancelling', message: '已请求取消；当前处理步骤结束后停止，已完成档位保留。' };
}
module.exports = { start, status, cancel, writeAtomic, jobPaths, terminal, restoreCompleted };
