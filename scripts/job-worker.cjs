'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { generate } = require('./bead.cjs');
const { writeAtomic, jobPaths, restoreCompleted } = require('./job.cjs');
const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = request.options.out, paths = jobPaths(out);
const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
state.pid = process.pid; state.status = 'running';
const cancellation = () => {
  if (fs.existsSync(paths.cancel)) { const error = new Error('用户已取消生成。'); error.code = 'BEAD_CANCELLED'; throw error; }
};
function record(event) {
  state.cursor++; state.updatedAt = new Date().toISOString();
  const value = { ...event, cursor: state.cursor, timestamp: state.updatedAt };
  fs.appendFileSync(paths.events, JSON.stringify(value) + '\n');
  if (event.event !== 'heartbeat') state.current = { phase: event.phase, size: event.size ?? null, message: event.message, files: event.files || {} };
  if (event.event === 'variant-complete') {
    state.completedSizes.push(event.size);
    state.variants.push({ size: event.size, w: event.w, h: event.h, status: 'complete', colorCount: event.colors, totalBeads: event.totalBeads, files: event.files });
  } else if (event.event === 'variant-failed') state.variants.push({ size: event.size, w: event.w, h: event.h, status: 'failed', error: event.error });
  if (event.event === 'batch-stage' && event.files) state.files = { ...state.files, ...event.files };
  writeAtomic(paths.state, state);
}
record({ event: 'job-start', phase: 'input', message: '正在读取图片，稍后逐档通知完成情况。' });
const heartbeat = setInterval(() => { try { cancellation(); record({ event: 'heartbeat', phase: state.current.phase, size: state.current.size, message: state.current.message }); } catch {} }, 10000);
(async () => {
  try {
    cancellation();
    const result = await generate(request.options, { preparedOut: true, onProgress: event => { cancellation(); record(event); } });
    state.status = result.status; state.files = result.files; state.result = result;
    record({ event: 'job-complete', phase: 'finished', message: result.status === 'complete' ? '全部图纸和交付 ZIP 已完成。' : '任务已结束，部分内容未完成；已完成档位可以下载。' });
  } catch (error) {
    state.status = error.code === 'BEAD_CANCELLED' ? 'cancelled' : 'failed'; state.error = error.message;
    const manifestFile = path.join(out, 'manifest.json');
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); manifest.status = state.status;
      restoreCompleted(state, out, manifest);
      manifest.error = error.message; writeAtomic(manifestFile, manifest);
    }
    record({ event: 'job-failed', phase: state.status, message: error.message });
    process.exitCode = 1;
  } finally { clearInterval(heartbeat); }
})();
