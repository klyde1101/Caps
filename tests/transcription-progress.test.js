import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptionProgressParser } from '../src/transcription-progress.js';
import { createProgressTracker, formatRemaining } from '../src/desktop/renderer/job-progress.js';
import { createJobEventForwarder } from '../src/desktop/job-event-forwarder.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';

test('structured progress handles split Unicode chunks and rejects invalid telemetry', () => {
  const events = [];
  const parse = createTranscriptionProgressParser((event) => events.push(event));
  parse('unrelated download 100%\n[CapsPro');
  parse('gress] {"fileIndex":1,"phase":"aligning","percent":82.5}\n');
  parse('[CapsProgress] broken\n[CapsProgress] {"fileIndex":-1,"phase":"transcribing","percent":45}\n');
  assert.deepEqual(events, [{ fileIndex: 1, phase: 'aligning', percent: 82.5, indeterminate: false }]);
});

test('batch routes runtime file offsets correctly across reused model chunks', async () => {
  const events = [];
  const requests = ['one.mp4', 'two.mp4', 'one.wav', 'three.mp4'].map((inputPath) => ({ inputPath }));
  await generateCaptionBatchJob({ requests, onProgress: (event) => events.push(event) }, {
    transcribeMediaBatch: async (paths, options) => {
      paths.forEach((_, fileIndex) => options.onProgress({ fileIndex, phase: 'aligning', percent: 80 }));
      return paths.map(() => ({ srt: '' }));
    },
    generateCaptionJob: async () => ({})
  });
  assert.deepEqual(events.filter((event) => event.phase === 'aligning').map(({ fileIndex, fileEndIndex }) => [fileIndex, fileEndIndex]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
});

test('progress forwarding preserves rapid changes between files', () => {
  const events = [];
  const forwarder = createJobEventForwarder((type, event) => { if (type === 'progress') events.push(event); });
  forwarder.progress({ stage: 'transcribing-and-aligning', fileIndex: 0, percent: 20 });
  forwarder.progress({ stage: 'transcribing-and-aligning', fileIndex: 0, percent: 30 });
  forwarder.progress({ stage: 'transcribing-and-aligning', fileIndex: 1, percent: 40 });
  forwarder.flush();
  assert.deepEqual(events.map((event) => [event.fileIndex, event.percent]), [[0, 20], [0, 30], [1, 40]]);
});

test('individual progress does not copy range percentages or count ASR as complete', () => {
  const tracker = createProgressTracker([{ name: 'one' }, { name: 'two' }], 0);
  tracker.update({ stage: 'transcribing-and-aligning', fileIndex: 0, fileEndIndex: 1, percent: 75 }, 1000);
  assert.deepEqual(tracker.snapshot(1000).items.map((item) => item.percent), [0, 0]);
  tracker.update({ stage: 'transcribing-and-aligning', fileIndex: 0, percent: 70, phase: 'awaiting-alignment' }, 2000);
  tracker.update({ stage: 'transcribing-and-aligning', fileIndex: 1, percent: 20, phase: 'transcribing' }, 3000);
  assert.equal(tracker.snapshot(3000).percent, 45);
  tracker.update({ stage: 'transcribing-and-aligning', fileIndex: 0, percent: 5, phase: 'aligning' }, 4000);
  assert.equal(tracker.snapshot(4000).items[0].percent, 70);
  tracker.update({ stage: 'complete', fileIndex: 0 }, 5000);
  assert.equal(tracker.snapshot(5000).completed, 1);
  assert.equal(tracker.snapshot(5000).percent, 60);
});

test('ETA waits for samples, expires on stalls, resets on retry, and completes only after export', () => {
  const tracker = createProgressTracker([{ name: 'one' }], 0);
  assert.equal(tracker.snapshot(0).remaining, null);
  tracker.update({ stage: 'transcribing-and-aligning', percent: 10 }, 1000);
  assert.equal(tracker.snapshot(1000).remaining, null);
  tracker.update({ stage: 'transcribing-and-aligning', percent: 30 }, 5000);
  assert.ok(tracker.snapshot(5000).remaining > 0);
  assert.ok(tracker.snapshot(5000).items[0].remaining > 0);
  assert.equal(tracker.snapshot(40000).remaining, null);
  tracker.update({ stage: 'transcribing-and-aligning', indeterminate: true, fallback: 'cpu' }, 41000);
  assert.equal(tracker.snapshot(41000).remaining, null);
  tracker.update({ stage: 'transcribing-and-aligning', percent: 100 }, 42000);
  assert.equal(tracker.snapshot(42000).percent, 95);
  tracker.update({ stage: 'complete' }, 43000);
  assert.equal(tracker.snapshot(43000).remaining, 0);
  assert.equal(formatRemaining(null), 'Estimating…');
  assert.equal(formatRemaining(65000), 'About 2 min left');
});
