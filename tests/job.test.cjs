'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/bead.cjs');
const { generate } = require(script);
const job = require('../scripts/job.cjs');
const exporter = require('../scripts/export.cjs');
const runtime = require('../scripts/runtime.cjs');
const version = require('../scripts/version.cjs');
const evidence = path.resolve(process.env.BEAD_JOB_OUT || path.join(require('node:os').tmpdir(), `bead-job-${process.pid}-${Date.now()}`));
const fixture = name => path.join(root, 'tests/fixtures', name);
fs.mkdirSync(evidence, { recursive: true });
const records = [];
function cli(...args) {
  const start = Date.now();
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4000000 });
  assert.ifError(r.error);
  return { code: r.status, json: JSON.parse(r.stdout.trim().split('\n').at(-1)), elapsedMs: Date.now() - start };
}
async function until(out, predicate, after = -1) {
  const deadline = Date.now() + 180000; let state;
  do {
    state = await job.status({ out, after, 'wait-ms': 5000 });
    after = state.cursor;
    if (predicate(state)) return state;
    if (job.terminal(state.status)) throw new Error(`任务过早结束：${state.status} ${state.error || ''}`);
  } while (Date.now() < deadline);
  throw new Error('后台任务超时');
}
let completed;
test('background returns promptly; six completion events have usable files before batch ends', async () => {
  const out = path.join(evidence, '满格六档');
  const r = cli('start', '--input', fixture('满格压力图.png'), '--out', out);
  assert.equal(r.code, 0); assert.equal(r.json.status, 'starting'); assert.ok(r.elapsedMs < 5000);
  let cursor = 0, observedBeforeEnd = false; const notified = new Set(), snapshots = [];
  completed = await until(out, s => {
    assert.ok(s.cursor >= cursor);
    for (const e of s.events) {
      assert.ok(e.cursor > cursor);
      if (e.event === 'variant-complete') {
        assert.equal(notified.has(e.size), false); notified.add(e.size);
        for (const file of Object.values(e.files)) assert.ok(fs.statSync(file).size > 0);
        snapshots.push({ size: e.size, elapsedMs: s.elapsedMs, status: s.status, filesReady: true });
        if (!job.terminal(s.status)) observedBeforeEnd = true;
      }
    }
    cursor = s.cursor;
    return job.terminal(s.status);
  }, 0);
  assert.equal(completed.status, 'complete'); assert.equal(observedBeforeEnd, true);
  assert.deepEqual([...notified], [29, 48, 100, 200, 300, 500]);
  assert.deepEqual(completed.completedSizes, [...notified]);
  records.push({ test: 'six-live-completions', startReturnMs: r.elapsedMs, snapshots, peakRssMB: completed.result.peakRssMB });
});
test('archive excludes task metadata and contains a truthful final manifest', () => {
  const { zip } = runtime.load();
  const files = zip.unzipSync(fs.readFileSync(completed.files.archive));
  assert.equal(Object.keys(files).length, 33);
  assert.ok(Object.keys(files).every(n => !n.includes('.bead-job') && !n.endsWith('.tmp')));
  assert.deepEqual(JSON.parse(Buffer.from(files['manifest.json'])), JSON.parse(fs.readFileSync(completed.files.manifest)));
});
test('same job cannot start twice; terminal polling never replays consumed events', async () => {
  const r = cli('start', '--input', fixture('白色.png'), '--out', completed.out);
  assert.equal(r.code, 1); assert.match(r.json.error, /非空/);
  const state = await job.status({ out: completed.out, after: completed.cursor, 'wait-ms': 5000 });
  assert.deepEqual(state.events, []); assert.equal(state.status, 'complete');
  assert.equal((await job.cancel({ out: completed.out })).status, 'complete');
});
test('corrupt image reports a terminal error instead of hanging or claiming success', async () => {
  const out = path.join(evidence, '损坏图片');
  assert.equal(cli('start', '--input', fixture('损坏图片.png'), '--out', out).code, 0);
  const state = await until(out, s => job.terminal(s.status));
  assert.equal(state.status, 'failed'); assert.deepEqual(state.completedSizes, []);
  assert.ok(state.error); assert.equal(fs.existsSync(path.join(out, '拼豆图纸-全部规格.zip')), false);
});
test('cancellation preserves a ready size and stops after the current step', async () => {
  const out = path.join(evidence, '取消验证');
  assert.equal(cli('start', '--input', fixture('满格压力图.png'), '--sizes', '29,500', '--out', out).code, 0);
  await until(out, s => s.completedSizes.includes(29));
  const cancellation = await job.cancel({ out }); assert.equal(cancellation.status, 'cancelling');
  const state = await until(out, s => job.terminal(s.status));
  assert.equal(state.status, 'cancelled'); assert.ok(state.completedSizes.includes(29));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json')));
  assert.deepEqual(state.completedSizes, manifest.variants.filter(v => v.status === 'complete').map(v => v.size));
  for (const v of manifest.variants.filter(v => v.status === 'complete')) for (const file of Object.values(v.files)) assert.ok(fs.statSync(path.join(out, file)).size > 0);
  assert.equal(manifest.status, 'cancelled'); assert.equal(fs.existsSync(path.join(out, '拼豆图纸-全部规格.zip')), false);
  records.push({ test: 'cancel', completedSizes: state.completedSizes, status: state.status });
});
test('unexpected exit is detected and already completed files remain usable', async () => {
  const out = path.join(evidence, '进程中断');
  const r = cli('start', '--input', fixture('满格压力图.png'), '--sizes', '29,500', '--out', out);
  assert.equal(r.code, 0);
  await until(out, s => s.completedSizes.includes(29));
  // This PID is the newly created test worker, never an unrelated application.
  process.kill(r.json.pid);
  await new Promise(resolve => setTimeout(resolve, 2200));
  const state = await job.status({ out });
  assert.equal(state.status, 'failed'); assert.ok(state.completedSizes.includes(29));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'))).status, 'failed');
  for (const file of Object.values(state.variants[0].files)) assert.ok(fs.statSync(file).size > 0);
});
test('archive failure is partial, with no missing ZIP advertised as complete', async () => {
  const original = exporter.archiveDirectory;
  exporter.archiveDirectory = () => { throw new Error('受控打包故障'); };
  let r;
  try { r = await generate({ input: fixture('白色.png'), sizes: '29', out: path.join(evidence, '打包失败') }); }
  finally { exporter.archiveDirectory = original; }
  assert.equal(r.status, 'partial'); assert.match(r.finalizationError, /受控打包故障/);
  assert.equal(r.files.archive, undefined); assert.equal(r.variants[0].status, 'complete');
  assert.equal(JSON.parse(fs.readFileSync(r.files.manifest)).status, 'partial');
});
test('output directory junction cannot place generated files inside the installed skill', () => {
  const junction = path.join(evidence, '技能目录连接');
  fs.symlinkSync(root, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const out = path.join(junction, '禁止生成');
  const r = cli('start', '--input', fixture('白色.png'), '--sizes', '29', '--out', out);
  assert.equal(r.code, 1); assert.match(r.json.error, /技能安装目录/); assert.equal(fs.existsSync(out), false);
});
test('a finished manifest restores results if the worker exits before its final state write', async () => {
  const out = path.join(evidence, '最终状态恢复');
  const r = await generate({ input: fixture('白色.png'), sizes: '29', out });
  const paths = job.jobPaths(out); fs.mkdirSync(paths.dir);
  job.writeAtomic(paths.state, { status: 'running', cursor: 0, pid: 0, startedAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString(), requestedSizes: [29], completedSizes: [], variants: [], files: {} });
  const state = await job.status({ out });
  assert.equal(state.status, 'complete'); assert.deepEqual(state.completedSizes, [29]);
  assert.equal(state.files.archive, r.files.archive); assert.equal(state.error, undefined);
});
test('status argument errors and absent tasks fail cleanly', () => {
  assert.equal(cli('status', '--out', completed.out, '--wait-ms', '10001').code, 1);
  assert.equal(cli('status', '--out', path.join(evidence, '不存在')).code, 1);
  fs.writeFileSync(path.join(evidence, 'job-validation.json'), JSON.stringify({ status: 'passed', records }, null, 2));
});
