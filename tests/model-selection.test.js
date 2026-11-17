import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, AVAILABLE_MODELS, modelLabel } from '../src/model-catalog.js';
import { defaultModel, resolveModelSelection, inspectLocalModel, inspectInstalledModels, validateModelSelection, buildWhisperxArgs, transcribeMediaBatch } from '../src/whisperx-runner.js';
import { validateStartRequest } from '../src/desktop/ipc-contract.js';
import { createSettingsStore } from '../src/desktop/settings-store.js';
import { resolveDesktopRuntimeRequest } from '../src/desktop/runtime-request.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';

const TURBO = 'large-v3-turbo';

test('Turbo is the default and Small is supported by WhisperX', async () => {
  assert.equal(DEFAULT_MODEL, TURBO);
  assert.deepEqual(AVAILABLE_MODELS.map(({ id }) => id), [TURBO, 'small']);
  assert.equal(modelLabel(TURBO), 'Large v3 Turbo');
  for (const model of [TURBO, 'small']) {
    assert.equal(validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', model }).model, model);
    await validateModelSelection(model);
    const args = buildWhisperxArgs('clip.mp4', 'output', { model, device: 'cpu' });
    assert.equal(args[args.indexOf('--model') + 1], model);
  }
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', model: 'large-v3' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(validateModelSelection('large-v3'), { code: 'INVALID_INPUT' });
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', model: 'canary-qwen-2.5b' }), { code: 'INVALID_REQUEST' });
});

test('the selected model survives settings save and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caps-model-settings-'));
  try {
    assert.equal((await createSettingsStore(directory).read()).model, DEFAULT_MODEL);
    assert.equal((await createSettingsStore(directory).save({ model: TURBO })).model, TURBO);
    assert.equal((await createSettingsStore(directory).read()).model, TURBO);
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ model: 'large-v3', device: 'cpu' }));
    const migrated = await createSettingsStore(directory).read();
    assert.equal(migrated.model, TURBO);
    assert.equal(migrated.device, 'cpu');
    assert.equal((await createSettingsStore(directory).save(migrated)).model, TURBO);
    assert.equal((await createSettingsStore(directory).read()).model, TURBO);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('portable Turbo resolves independently, passes the selected local model to CPU fallback, and cleans up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caps-turbo-runtime-'));
  const previous = process.env.PORTABLE_EXECUTABLE_DIR;
  const previousModel = process.env.CAPS_MODEL;
  try {
    process.env.PORTABLE_EXECUTABLE_DIR = directory;
    delete process.env.CAPS_MODEL;
    assert.equal(resolveModelSelection(TURBO), TURBO);
    assert.throws(() => resolveDesktopRuntimeRequest({ inputPath: 'clip.mp4', model: TURBO }), {
      code: 'MODEL_NOT_FOUND', message: /Large v3 Turbo/
    });
    const modelPath = join(directory, 'models', TURBO);
    await mkdir(modelPath, { recursive: true });
    for (const name of ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json']) await writeFile(join(modelPath, name), '{}');
    assert.equal(resolveModelSelection(TURBO), modelPath);
    assert.equal(defaultModel(), modelPath);
    assert.equal(inspectLocalModel(TURBO).valid, true);
    assert.equal(resolveDesktopRuntimeRequest({ inputPath: 'clip.mp4', model: TURBO }).model, modelPath);
    const installed = await inspectInstalledModels();
    assert.equal(installed.find(({ id }) => id === TURBO).installed, true);
    assert.equal(installed.some(({ id }) => id === 'large-v3'), false);
    const calls = [];
    const output = await transcribeMediaBatch(['clip.mp4'], {
      model: modelPath, device: 'auto', whisperxPath: process.execPath,
      inspectWhisperxRuntime: async () => ({ cudaSupport: 'supported' }),
      runProcess: async (_executable, args) => {
        calls.push(args);
        if (calls.length === 1) throw new Error('Torch not compiled with CUDA enabled');
        await writeFile(join(args[args.indexOf('--output_dir') + 1], 'clip.srt'), 'aligned output');
      }
    });
    assert.equal(output[0].srt, 'aligned output');
    assert.equal(calls.length, 2);
    for (const args of calls) assert.equal(args[args.indexOf('--model') + 1], modelPath);
    assert.equal(calls[1][calls[1].indexOf('--device') + 1], 'cpu');
  } finally {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
    else process.env.PORTABLE_EXECUTABLE_DIR = previous;
    if (previousModel === undefined) delete process.env.CAPS_MODEL;
    else process.env.CAPS_MODEL = previousModel;
    await rm(directory, { recursive: true, force: true });
  }
});

test('mixed-model batches never reuse one model for the other selection', async () => {
  const calls = [];
  await generateCaptionBatchJob({ requests: [
    { inputPath: 'one.mp4', model: 'small' },
    { inputPath: 'two.mp4', model: TURBO },
    { inputPath: 'three.mp4', model: TURBO }
  ] }, {
    transcribeMediaBatch: async (paths, options) => { calls.push([paths.length, options.model]); return paths.map(() => ({ srt: '' })); },
    generateCaptionJob: async () => ({})
  });
  assert.deepEqual(calls, [[1, 'small'], [2, TURBO]]);
});
