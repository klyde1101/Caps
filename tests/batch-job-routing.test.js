import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';
import { generateCaptionJob, JOB_STAGES } from '../src/application/generate-caption-job.js';

const srt = '1\n00:00:00,000 --> 00:00:00,300\nHello\n\n2\n00:00:00,300 --> 00:00:00,700\nworld.\n';

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'caps-batch-routing-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a single request transcribes a batch of one with unchanged callbacks and per-file result', async () => {
  await temporary(async (directory) => {
    const inputPath = join(directory, 'clip.mp4');
    const events = [];
    const logs = [];
    const text = [];
    let ready = 0;
    let namingCalls = 0;
    const result = await generateCaptionBatchJob({
      inputPath,
      namingStrategy: async () => { namingCalls += 1; return join(directory, 'captions.srt'); },
      onProgress: (event) => events.push(event),
      onLog: (entry) => logs.push(entry),
      onTranscriptionOutput: (chunk) => text.push(chunk),
      onInputReady: () => { ready += 1; }
    }, {
      transcribeMediaBatch: async (paths, options) => {
        assert.deepEqual(paths, [inputPath]);
        options.onOutput('progress text');
        options.onProgress({ percent: 42, indeterminate: false });
        return [{ srt }];
      }
    });
    assert.equal(Array.isArray(result), false);
    assert.equal(result.inputType, 'media');
    assert.equal(result.alignedWordCount, 2);
    assert.equal(result.validation.valid, true);
    assert.match(await readFile(result.outputPath, 'utf8'), /Hello world\./);
    assert.equal(namingCalls, 1);
    assert.equal(ready, 1);
    assert.deepEqual(text, ['progress text']);
    assert.deepEqual(logs, [{ message: 'progress text', stream: 'stdout' }]);
    assert.deepEqual(events, [
      { stage: JOB_STAGES.INSPECTING_INPUT },
      { stage: JOB_STAGES.LOCATING_WHISPERX },
      { stage: JOB_STAGES.TRANSCRIBING, indeterminate: true },
      { stage: JOB_STAGES.TRANSCRIBING, percent: 42, indeterminate: false },
      { stage: JOB_STAGES.GROUPING },
      { stage: JOB_STAGES.VALIDATING },
      { stage: JOB_STAGES.WRITING },
      { stage: JOB_STAGES.COMPLETE }
    ]);
  });
});

test('an explicit batch of one keeps batch results and file progress metadata', async () => {
  await temporary(async (directory) => {
    const events = [];
    const results = await generateCaptionBatchJob({
      requests: [{ inputPath: join(directory, 'clip.mp4') }],
      onProgress: (event) => events.push(event)
    }, { transcribeMediaBatch: async () => [{ srt }] });
    assert.equal(results.length, 1);
    assert.ok(events.every(({ fileIndex, fileEndIndex, fileCount }) => fileIndex === 0 && fileEndIndex === 0 && fileCount === 1));
  });
});

test('mixed batches retain file order and split duplicate stems and runtime choices', async () => {
  const requests = [
    { inputPath: 'one.mp4', device: 'cpu' },
    { inputPath: 'two.mp4', device: 'cpu' },
    { inputPath: 'other/two.wav', device: 'cpu' },
    { inputPath: 'aligned.srt' },
    { inputPath: 'three.mp4', device: 'cuda' }
  ];
  const calls = [];
  const results = await generateCaptionBatchJob({ requests }, {
    transcribeMediaBatch: async (paths, { device }) => {
      calls.push({ paths, device });
      return paths.map((path) => ({ srt: path }));
    },
    generateCaptionJob: async (request, dependencies) => {
      if (!request.inputPath.endsWith('.srt')) assert.equal(dependencies.alignedSrt, request.inputPath);
      return { outputPath: request.inputPath };
    }
  });
  assert.deepEqual(calls, [
    { paths: ['one.mp4', 'two.mp4'], device: 'cpu' },
    { paths: ['other/two.wav'], device: 'cpu' },
    { paths: ['three.mp4'], device: 'cuda' }
  ]);
  assert.deepEqual(results.map(({ outputPath }) => outputPath), requests.map(({ inputPath }) => inputPath));
});

test('invalid single media output is rejected before transcription', async () => {
  await assert.rejects(generateCaptionBatchJob({ inputPath: 'clip.mp4', outputPath: 'clip.txt' }, {
    transcribeMediaBatch: async () => assert.fail('must validate before transcribing')
  }), { code: 'INVALID_INPUT' });
});

test('single and multiple transcription failures retain stable error codes', async () => {
  for (const request of [{ inputPath: 'clip.mp4' }, { requests: [{ inputPath: 'one.mp4' }, { inputPath: 'two.mp4' }] }]) {
    await assert.rejects(generateCaptionBatchJob(request, {
      transcribeMediaBatch: async () => { throw new Error('engine failed'); },
      generateCaptionJob: async () => assert.fail('must not process failed transcription')
    }), { code: 'TRANSCRIPTION_FAILED', message: 'engine failed' });
  }
});

test('cancelling active transcription stops a batch without publishing outputs', async () => {
  await temporary(async (directory) => {
    const controller = new AbortController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const running = generateCaptionBatchJob({
      requests: [{ inputPath: join(directory, 'one.mp4') }, { inputPath: join(directory, 'two.mp4') }],
      signal: controller.signal
    }, {
      transcribeMediaBatch: async (_paths, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true });
        started();
      })
    });
    const rejected = assert.rejects(running, { name: 'AbortError', code: 'CANCELLED' });
    await ready;
    controller.abort();
    await rejected;
    assert.deepEqual(await readdir(directory), []);
  });
});

test('cancellation between files prevents later processing and further transcription', async () => {
  const controller = new AbortController();
  let generated = 0;
  let transcribed = 0;
  await assert.rejects(generateCaptionBatchJob({
    requests: [{ inputPath: 'one.mp4' }, { inputPath: 'two.mp4' }, { inputPath: 'three.mp4', device: 'cpu' }],
    signal: controller.signal
  }, {
    transcribeMediaBatch: async (paths) => { transcribed += 1; return paths.map(() => ({ srt })); },
    generateCaptionJob: async () => { generated += 1; controller.abort(); return {}; }
  }), { code: 'CANCELLED' });
  assert.equal(generated, 1);
  assert.equal(transcribed, 1);
});

test('downstream caption processing requires an existing media transcription', async () => {
  await assert.rejects(generateCaptionJob({ inputPath: 'clip.mp4' }), { code: 'INVALID_INPUT' });
});
