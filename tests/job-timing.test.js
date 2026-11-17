import test from 'node:test';
import assert from 'node:assert/strict';
import { JobController } from '../src/desktop/job-controller.js';

const request = (name) => ({ inputPath: `C:\\Media\\${name}`, outputPath: `C:\\Media\\${name}.srt`, mode: 'social-media' });

test('queue timing measures each file independently and resets for a new run', async () => {
  let clock = 0;
  const jobs = new JobController(async (value) => {
    clock += value.inputPath.endsWith('a.mp4') ? 10000 : 2000;
    return { outputPath: value.outputPath };
  }, { now: () => clock });
  const results = await jobs.startQueue([request('a.mp4'), request('b.mp4')]);
  assert.deepEqual(results.map(result => result.processingDurationMs), [10000, 2000]);
  assert.deepEqual(results.map(result => result.totalElapsedMs), [12000, 12000]);
  clock += 90000;
  const next = await jobs.startQueue([request('b.mp4')]);
  assert.equal(next[0].processingDurationMs, 2000);
  assert.equal(next[0].totalElapsedMs, 2000);
});

test('deferred file timing excludes other files and alignment waits while overall includes setup and cleanup', async () => {
  let clock = 0;
  const jobs = new JobController(async (value) => {
    clock += 50;
    return { outputPath: value.outputPath };
  }, {
    now: () => clock,
    createTranscriber: async ({ onProgress }) => {
      clock += 100;
      return {
        transcribe: async (_request, index) => { clock += index === 0 ? 1000 : 2000; },
        align: async () => {
          clock += 500;
          for (const [fileIndex, duration] of [[0, 300], [1, 400]]) {
            onProgress({ fileIndex, phase: 'aligning', percent: 70 });
            clock += duration;
            onProgress({ fileIndex, phase: 'finishing', percent: 95 });
          }
          return [{ fileIndex: 0, srt: 'one' }, { fileIndex: 1, srt: 'two' }];
        },
        close: async () => { clock += 200; }
      };
    }
  });
  const results = await jobs.startQueue([request('a.mp4'), request('b.mp4'), request('import.srt')]);
  assert.deepEqual(results.map(result => result.processingDurationMs), [1450, 2450, 50]);
  assert.ok(results.every(result => result.totalElapsedMs === 4650));
  assert.ok(results.reduce((sum, result) => sum + result.processingDurationMs, 0) < results[0].totalElapsedMs);
});

test('recovery timing pauses before shared alignment setup and other files', async () => {
  let clock = 0;
  const jobs = new JobController(async () => { clock += 10; return {}; }, {
    now: () => clock,
    createTranscriber: async ({ onProgress }) => ({
      transcribe: async () => { clock += 100; },
      align: async () => {
        for (const fileIndex of [0, 1]) {
          onProgress({fileIndex, phase: 'recovering'}); clock += 200;
          onProgress({fileIndex, phase: 'awaiting-alignment'});
        }
        clock += 1000;
        for (const fileIndex of [0, 1]) {
          onProgress({fileIndex, phase: 'aligning'}); clock += 50;
          onProgress({fileIndex, phase: 'finishing'});
        }
        return [{fileIndex:0,srt:'a'}, {fileIndex:1,srt:'b'}];
      },
      close: async () => {}
    })
  });
  const results = await jobs.startQueue([request('a.mp4'), request('b.mp4')]);
  assert.deepEqual(results.map(result => result.processingDurationMs), [360, 360]);
  assert.equal(results[0].totalElapsedMs, 1720);
});
