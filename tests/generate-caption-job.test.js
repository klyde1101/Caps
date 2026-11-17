import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captionOutputPath } from '../src/application/generate-caption-job.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';
import { ERROR_CODES } from '../src/errors.js';

const alignedSrt = `1
00:00:00,000 --> 00:00:00,300
Hello

2
00:00:00,300 --> 00:00:00,700
world.
`;

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'caps-job-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('caption job converts aligned SRT and returns structured statistics', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'demo.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');

    const result = await generateCaptionBatchJob({ inputPath, mode: 'social-media' });

    assert.equal(result.outputPath, join(directory, 'demo_9X16.srt'));
    assert.equal(result.inputType, 'srt');
    assert.equal(result.sourceType, 'clean-word-timeline');
    assert.equal(result.sourceCueCount, 2);
    assert.equal(result.alignedWordCount, 2);
    assert.equal(result.generatedCaptionCount, 1);
    assert.equal(result.validation.valid, true);
    assert.match(await readFile(result.outputPath, 'utf8'), /Hello/);
  });
});

test('caption job processes media through an injected transcription runner', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'clip.mp4');
    let received;
    const result = await generateCaptionBatchJob({
      inputPath,
      mode: 'social-media',
      language: 'fil',
      model: 'test-model',
      whisperxPath: 'test-whisperx.exe',
      device: 'cuda',
      deviceIndex: 2,
      computeType: 'int8'
    }, {
      transcribeMediaBatch: async ([path], options) => {
        received = { path, options };
        return [{ srt: alignedSrt }];
      }
    });

    assert.equal(received.path, inputPath);
    assert.equal(received.options.language, 'fil');
    assert.equal(received.options.model, 'test-model');
    assert.equal(received.options.whisperxPath, 'test-whisperx.exe');
    assert.equal(received.options.device, 'cuda');
    assert.equal(received.options.deviceIndex, 2);
    assert.equal(received.options.computeType, 'int8');
    assert.equal(result.inputType, 'media');
    assert.equal(result.generatedCaptionCount, 1);
  });
});

test('caption output naming uses the default orientation', () => {
  assert.equal(captionOutputPath(join('somewhere', 'product.video.mp4'), '9:16'), join('somewhere', 'product.video_9X16.srt'));
});

test('caption jobs reject non-SRT and input-overwriting destinations', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'aligned.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');
    await assert.rejects(generateCaptionBatchJob({ inputPath, outputPath: join(directory, 'captions.txt') }), { code: 'INVALID_INPUT' });
    await assert.rejects(generateCaptionBatchJob({ inputPath, outputPath: inputPath }), { code: 'INVALID_INPUT' });
  });
});

test('caption job accepts an asynchronous output naming strategy', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'demo.srt');
    const customOutputPath = join(directory, 'chosen-name.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');

    const result = await generateCaptionBatchJob({
      inputPath,
      mode: 'social-media',
      namingStrategy: async ({ suggestedOutputPath }) => {
        assert.equal(suggestedOutputPath, join(directory, 'demo_9X16.srt'));
        return customOutputPath;
      }
    });

    assert.equal(result.outputPath, customOutputPath);
  });
});

test('an already-cancelled job performs no transcription or output writes', async () => {
  const controller = new AbortController();
  controller.abort();
  let transcribed = false;
  let wroteOutput = false;

  await assert.rejects(generateCaptionBatchJob({
    inputPath: 'cancelled.mp4',
    signal: controller.signal
  }, {
    transcribeMediaBatch: async () => { transcribed = true; return { srt: alignedSrt }; },
    writeFile: async () => { wroteOutput = true; }
  }), { name: 'AbortError' });

  assert.equal(transcribed, false);
  assert.equal(wroteOutput, false);
});

test('failed publication removes temporary output and leaves no final file', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'demo.srt');
    const outputPath = join(directory, 'custom.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');

    await assert.rejects(
      generateCaptionBatchJob({ inputPath, outputPath }, {
        rename: async () => { throw new Error('simulated publish failure'); }
      }),
      { code: ERROR_CODES.OUTPUT_UNWRITABLE, message: /publishing subtitle file.*custom\.srt.*simulated publish failure/ }
    );

    assert.deepEqual((await readdir(directory)).sort(), ['demo.srt']);
  });
});

test('successful publication atomically replaces an existing output file', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'demo.srt');
    const outputPath = join(directory, 'demo_9X16.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');
    await writeFile(outputPath, 'old output', 'utf8');

    await generateCaptionBatchJob({ inputPath, mode: 'social-media' });

    assert.match(await readFile(outputPath, 'utf8'), /Hello/);
    assert.deepEqual((await readdir(directory)).sort(), ['demo.srt', 'demo_9X16.srt']);
  });
});

test('caption job forwards grouping options to the conversion pipeline', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'demo.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');
    let receivedOptions;

    await generateCaptionBatchJob({
      inputPath,
      grouping: { timing: { bridgeGapMs: 0 } }
    }, {
      createCaptionCues(words, mode, options) {
        receivedOptions = options;
        return [{ start: 0, end: 700, text: 'Hello world.' }];
      }
    });

    assert.deepEqual(receivedOptions, { timing: { bridgeGapMs: 0 } });
  });
});

test('orientation determines the SRT and styled export names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caps-orientation-'));
  try {
    const inputPath = join(directory, 'sample.srt');
    await writeFile(inputPath, alignedSrt);
    for (const orientation of ['9:16', '4:5', '16:9']) {
      const result = await generateCaptionBatchJob({ inputPath, grouping: { orientation, fontFamily: 'proxima-nova-semibold', fontSize: 60 } });
      const suffix = orientation.replace(':', 'X');
      assert.equal(result.outputPath, join(directory, 'sample_' + suffix + '.srt'));
      assert.equal(result.styledOutputPath, join(directory, 'sample_' + suffix + '.ttml'));
      assert.match(await readFile(result.styledOutputPath, 'utf8'), /Proxima Nova Semibold/);
      assert.match(await readFile(result.styledOutputPath, 'utf8'), /60px/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
