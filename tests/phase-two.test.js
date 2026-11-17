import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { JOB_STAGES } from '../src/application/generate-caption-job.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';
import { CaptionJobError, ERROR_CODES } from '../src/errors.js';
import { isCudaUnavailableError, parseWhisperxProgress, runWhisperxProcess, terminateProcessTree, transcribeMedia, validateModelSelection } from '../src/whisperx-runner.js';

const alignedSrt = `1
00:00:00,000 --> 00:00:00,300
Hello

2
00:00:00,300 --> 00:00:00,700
world.
`;

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'caps-phase-two-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('SRT jobs report a predictable stage order', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'demo.srt');
    const stages = [];
    await writeFile(inputPath, alignedSrt, 'utf8');

    await generateCaptionBatchJob({ inputPath, onProgress: ({ stage }) => stages.push(stage) });

    assert.deepEqual(stages, [
      JOB_STAGES.INSPECTING_INPUT,
      JOB_STAGES.GROUPING,
      JOB_STAGES.VALIDATING,
      JOB_STAGES.WRITING,
      JOB_STAGES.COMPLETE
    ]);
  });
});

test('media jobs report discovery, transcription progress, and completion', async () => {
  await withTempDirectory(async (directory) => {
    const events = [];
    const logs = [];
    await generateCaptionBatchJob({
      inputPath: join(directory, 'clip.mp4'),
      onProgress: (event) => events.push(event),
      onLog: (entry) => logs.push(entry)
    }, {
      transcribeMediaBatch: async (_path, options) => {
        options.onOutput('technical detail\n', 'stderr');
        options.onProgress({ percent: 42, indeterminate: false });
        return [{ srt: alignedSrt }];
      }
    });

    assert.deepEqual(events.map(({ stage }) => stage), [
      JOB_STAGES.INSPECTING_INPUT,
      JOB_STAGES.LOCATING_WHISPERX,
      JOB_STAGES.TRANSCRIBING,
      JOB_STAGES.TRANSCRIBING,
      JOB_STAGES.GROUPING,
      JOB_STAGES.VALIDATING,
      JOB_STAGES.WRITING,
      JOB_STAGES.COMPLETE
    ]);
    assert.equal(events[3].percent, 42);
    assert.deepEqual(logs, [{ message: 'technical detail\n', stream: 'stderr' }]);
  });
});

test('cancelling mocked transcription leaves no output files', async () => {
  await withTempDirectory(async (directory) => {
    const controller = new AbortController();
    const inputPath = join(directory, 'clip.mp4');
    const job = generateCaptionBatchJob({ inputPath, signal: controller.signal }, {
      transcribeMediaBatch: async (_path, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    });

    controller.abort();
    await assert.rejects(job, { name: 'AbortError', code: ERROR_CODES.CANCELLED });
    assert.deepEqual(await readdir(directory), []);
  });
});

test('job failures expose stable public error codes', async () => {
  await assert.rejects(generateCaptionBatchJob({ inputPath: 'x.srt', mode: 'unknown' }), { code: ERROR_CODES.UNSUPPORTED_MODE });
  await assert.rejects(generateCaptionBatchJob({ inputPath: 'missing.srt' }, {
    readFile: async () => { throw new Error('missing'); }
  }), { code: ERROR_CODES.INVALID_INPUT });
  await assert.rejects(generateCaptionBatchJob({ inputPath: 'media.mp4' }, {
    transcribeMediaBatch: async () => { throw new CaptionJobError(ERROR_CODES.WHISPERX_NOT_FOUND, 'missing'); }
  }), { code: ERROR_CODES.WHISPERX_NOT_FOUND });
});

test('missing model paths have a stable error code', async () => {
  const missingPath = join(tmpdir(), `caps-missing-model-${randomUUID()}`);
  await assert.rejects(validateModelSelection(missingPath), { code: ERROR_CODES.MODEL_NOT_FOUND });
  await assert.doesNotReject(validateModelSelection('large-v3-turbo'));
});

test('WhisperX percentage parser accepts valid percentages only', () => {
  assert.equal(parseWhisperxProgress('Transcribing 47.5%'), 47.5);
  assert.equal(parseWhisperxProgress('done 100%'), 100);
  assert.equal(parseWhisperxProgress('rate 120%'), undefined);
  assert.equal(parseWhisperxProgress('no percentage'), undefined);
});

test('CUDA startup failures are recognized from WhisperX stderr', () => {
  assert.equal(isCudaUnavailableError({ stderr: 'AssertionError: Torch not compiled with CUDA enabled' }), true);
  assert.equal(isCudaUnavailableError(new Error('ordinary transcription failure')), false);
});

test('automatic processing retries a CUDA startup failure on CPU', async () => {
  await withTempDirectory(async (directory) => {
    const invocations = [];
    const inputPath = join(directory, 'clip.mp4');
    const result = await transcribeMedia(inputPath, {
      model: 'large-v3-turbo',
      whisperxPath: process.execPath,
      inspectWhisperxRuntime: async () => ({ cudaSupport: 'supported' }),
      runProcess: async (_executable, args) => {
        invocations.push(args);
        if (invocations.length === 1) {
          const error = new Error('WhisperX failed');
          error.stderr = 'AssertionError: Torch not compiled with CUDA enabled';
          throw error;
        }
        const outputDir = args[args.indexOf('--output_dir') + 1];
        await writeFile(join(outputDir, 'clip.srt'), alignedSrt, 'utf8');
      }
    });

    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].includes('--device'), false);
    assert.equal(invocations[1][invocations[1].indexOf('--device') + 1], 'cpu');
    assert.equal(result.srt, alignedSrt);
  });
});

test('automatic processing sends a known CPU-only runtime directly to CPU', async () => {
  await withTempDirectory(async (directory) => {
    let invocation;
    const result = await transcribeMedia(join(directory, 'clip.mp4'), {
      model: 'large-v3-turbo',
      whisperxPath: process.execPath,
      inspectWhisperxRuntime: async () => ({ pytorchVersion: '2.8.0+cpu', cudaSupport: 'unsupported' }),
      runProcess: async (_executable, args) => {
        invocation = args;
        const outputDir = args[args.indexOf('--output_dir') + 1];
        await writeFile(join(outputDir, 'clip.srt'), alignedSrt, 'utf8');
      }
    });

    assert.equal(invocation[invocation.indexOf('--device') + 1], 'cpu');
    assert.equal(result.runtime.cudaSupport, 'unsupported');
  });
});

test('explicit CUDA selection returns a stable error instead of silently using CPU', async () => {
  let attempts = 0;
  await assert.rejects(transcribeMedia('clip.mp4', {
    model: 'large-v3-turbo',
    device: 'cuda',
    whisperxPath: process.execPath,
    inspectWhisperxRuntime: async () => ({ cudaSupport: 'supported' }),
    runProcess: async () => {
      attempts += 1;
      const error = new Error('WhisperX failed');
      error.stderr = 'AssertionError: Torch not compiled with CUDA enabled';
      throw error;
    }
  }), { code: ERROR_CODES.CUDA_UNAVAILABLE });
  assert.equal(attempts, 1);
});

test('cancelling a running WhisperX process terminates its process tree', async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let terminatedPid;
  const running = runWhisperxProcess('whisperx.exe', [], {
    signal: controller.signal,
    spawnProcess: () => child,
    terminate: async (target) => { terminatedPid = target.pid; }
  });

  controller.abort();
  await assert.rejects(running, { name: 'AbortError', code: ERROR_CODES.CANCELLED });
  assert.equal(terminatedPid, 1234);
});

test('Windows process-tree termination uses taskkill for descendants', async () => {
  const child = { pid: 9876, kill: () => assert.fail('fallback kill should not be needed') };
  let invocation;
  await terminateProcessTree(child, {
    platform: 'win32',
    spawnProcess(executable, args, options) {
      invocation = { executable, args, options };
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit('close', 0));
      return killer;
    }
  });

  assert.equal(invocation.executable, 'taskkill');
  assert.deepEqual(invocation.args, ['/pid', '9876', '/T', '/F']);
  assert.equal(invocation.options.windowsHide, true);
});

test('cancelled transcription removes its isolated temporary directory', async () => {
  let transcriptionDirectory;
  await assert.rejects(transcribeMedia('clip.mp4', {
    whisperxPath: process.execPath,
    runProcess: async (_executable, args) => {
      transcriptionDirectory = args[args.indexOf('--output_dir') + 1];
      const error = new Error('cancelled');
      error.name = 'AbortError';
      error.code = ERROR_CODES.CANCELLED;
      throw error;
    }
  }), { name: 'AbortError' });

  await assert.rejects(access(transcriptionDirectory), { code: 'ENOENT' });
});
