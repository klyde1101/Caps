import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';
import { createJobEventForwarder } from '../src/desktop/job-event-forwarder.js';
import { createPreviewStore } from '../src/desktop/preview-store.js';
import { validateBatchRequests } from '../src/desktop/ipc-contract.js';
import { buildWhisperxArgs } from '../src/whisperx-runner.js';

const alignedSrt = '1\n00:00:00,000 --> 00:00:00,300\n<u>Hello</u>\n\n2\n00:00:00,300 --> 00:00:00,700\n<u>world.</u>\n';

function mediaRequest(index) {
  return {
    inputPath: `C:\\Media\\clip-${index}.mp4`,
    outputPath: `C:\\Media\\clip-${index}_SOCIAL-MEDIA.srt`,
    mode: 'social-media',
    language: 'en',
    model: 'large-v3-turbo',
    device: 'cpu',
    computeType: 'default'
  };
}

test('batch transcription reuses one model process for compatible files', async () => {
  const transcriptionCalls = [];
  let active = 0;
  let maximumActive = 0;
  const results = await generateCaptionBatchJob({ requests: [mediaRequest(1), mediaRequest(2), mediaRequest(3)] }, {
    transcribeMediaBatch: async (paths) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      transcriptionCalls.push(paths);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return paths.map(() => ({ srt: alignedSrt, executable: 'whisperx.exe' }));
    },
    generateCaptionJob: async (request, dependencies) => {
      return { outputPath: request.outputPath, cues: [{ text: dependencies.alignedSrt }] };
    },
    finalizeResult: ({ cues: _cues, ...summary }) => summary
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(transcriptionCalls.map((paths) => paths.length), [3]);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => !('cues' in result)));
});

test('WhisperX batch arguments keep all media inputs before command options', () => {
  const args = buildWhisperxArgs(['C:\\Media\\one.mp4', 'D:\\Audio\\two.wav'], 'C:\\Temp\\captions', { language: 'en', model: 'large-v3-turbo' });
  assert.deepEqual(args.slice(0, 4), ['C:\\Media\\one.mp4', 'D:\\Audio\\two.wav', '--language', 'en']);
});

test('preview store removes bulk cues from job results and returns bounded searchable pages', async () => {
  const store = createPreviewStore({ readFile: async () => alignedSrt });
  const summary = store.register({ outputPath: 'C:\\Media\\clip.srt', generatedCaptionCount: 2, cues: [{ text: 'not retained' }] });
  assert.equal('cues' in summary, false);
  assert.equal(typeof summary.previewToken, 'string');

  const page = await store.page({ previewToken: summary.previewToken, query: 'world', offset: 0, limit: 1 });
  assert.equal(page.matches, 1);
  assert.equal(page.total, 2);
  assert.deepEqual(page.cues.map(({ index, text }) => ({ index, text })), [{ index: 2, text: '<u>world.</u>' }]);
  await assert.rejects(store.page({ previewToken: 'unknown' }), { code: 'INVALID_REQUEST' });
});

test('job event forwarding batches logs and flushes the latest progress', () => {
  const sent = [];
  const pending = [];
  const forwarder = createJobEventForwarder((type, payload) => sent.push({ type, payload }), {
    setTimeout: (callback) => { pending.push(callback); return pending.length; },
    clearTimeout: () => {}
  });
  forwarder.log({ message: 'first' });
  forwarder.log({ message: ' second' });
  forwarder.progress({ stage: 'transcribing-and-aligning', percent: 1 });
  forwarder.progress({ stage: 'transcribing-and-aligning', percent: 2 });
  forwarder.flush();

  assert.deepEqual(sent.filter(({ type }) => type === 'log').map(({ payload }) => payload.message), ['first second']);
  assert.equal(sent.filter(({ type }) => type === 'progress').at(-1).payload.percent, 2);
});

test('batch validation rejects duplicate output destinations', () => {
  const requests = [mediaRequest(1), { ...mediaRequest(2), outputPath: mediaRequest(1).outputPath.toLowerCase() }];
  assert.throws(() => validateBatchRequests(requests), { code: 'INVALID_REQUEST' });
});
