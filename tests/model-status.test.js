import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelStatus, AVAILABLE_MODELS, NO_MODEL, modelInformation } from '../src/model-catalog.js';
import { settingsChanged } from '../src/desktop/renderer/settings-draft.js';
import { createPlaybackFollower } from '../src/desktop/renderer/playback-follow.js';
import { createSettingsStore } from '../src/desktop/settings-store.js';
import { validateStartRequest } from '../src/desktop/ipc-contract.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GiB = 1024 ** 3;
const hardware = () => ({ models: AVAILABLE_MODELS.map(spec => ({ id: spec.id, installed: true })),
  runtimes: { cpu: { available: true }, cuda: { available: true } },
  memory: { totalBytes: 32 * GiB }, cuda: { devices: [{ index: 0, totalMemoryBytes: 8 * GiB, freeMemoryBytes: 8 * GiB }] } });
test('healthy 8 GB CUDA models have no warning; equality fits and only insufficient free VRAM blocks', () => {
  const hw = hardware();
  for (const spec of AVAILABLE_MODELS) {
    assert.equal(getModelStatus(spec.id, hw, 'cuda').status, 'ready');
    assert.equal(getModelStatus(spec.id, hw, 'cuda').reason, '');
    hw.cuda.devices[0].freeMemoryBytes = spec.gpuVramGiB * GiB;
    assert.equal(getModelStatus(spec.id, hw, 'cuda').status, 'ready');
    hw.cuda.devices[0].freeMemoryBytes -= 1;
    assert.equal(getModelStatus(spec.id, hw, 'cuda').status, 'insufficient_vram');
    hw.cuda.devices[0].freeMemoryBytes = 8 * GiB;
  }
  hw.cuda.devices[0].freeMemoryBytes = 2 * GiB;
  assert.equal(getModelStatus('large-v3-turbo', hw, 'cuda').reason, 'Not enough VRAM: recommended ~4 GiB, 2 GiB available');
  assert.equal(getModelStatus('small', hw, 'cuda').status, 'ready');
  hw.cuda.devices.push({ index: 1, totalMemoryBytes: 12 * GiB, freeMemoryBytes: 12 * GiB });
  assert.equal(getModelStatus('large-v3-turbo', hw, { device: 'cuda', deviceIndex: 1 }).status, 'ready');
});
test('CPU ignores VRAM and slow-CPU advice never blocks; CUDA detection and installations are authoritative', () => {
  const hw = hardware(); hw.cuda.devices = []; hw.memory.totalBytes = 2 * GiB;
  const cpu = getModelStatus('large-v3-turbo', hw, 'cpu');
  assert.equal(cpu.status, 'ready'); assert.match(cpu.advisory, /slow on CPU/);
  assert.equal(getModelStatus('large-v3-turbo', hw, 'auto').device, 'cpu');
  assert.equal(getModelStatus('large-v3-turbo', hw, 'cuda').reason, 'No CUDA device detected');
  hw.cuda.devices = [{ index: 0, freeMemoryBytes: 8 * GiB }]; hw.runtimes.cuda.available = false;
  assert.equal(getModelStatus('small', hw, 'cuda').reason, 'CUDA runtime unavailable');
  hw.downloads = { models: { small: { state: 'idle' } } };
  assert.equal(getModelStatus('small', hw, 'cpu').status, 'not_installed');
  hw.downloads.models.small.state = 'installed';
  assert.equal(getModelStatus('small', hw, 'cpu').status, 'ready');
  assert.equal(getModelStatus(NO_MODEL, hw, 'cpu').status, 'not_installed');
});
test('model information uses measured bytes or the catalog and dirty Settings compare saved values', () => {
  const hw = hardware(); hw.models[0].sizeBytes = 1621667428;
  assert.equal(modelInformation('large-v3-turbo', hw).modelSize, '1.62');
  assert.equal(modelInformation('small', hw).modelSize, '0.49');
  for (const spec of AVAILABLE_MODELS) { assert.equal(spec.cudaComputeType, 'float16'); assert.equal(spec.cpuComputeType, 'int8'); }
  const saved = { model: 'small', device: 'cpu', deviceIndex: 0, timing: { minDurationMs: 100, bridgeGapMs: 80 } };
  assert.equal(settingsChanged(saved, structuredClone(saved)), false);
  assert.equal(settingsChanged(saved, { ...saved, device: 'cuda' }), true);
  assert.equal(settingsChanged(saved, { ...saved, timing: { ...saved.timing, bridgeGapMs: 90 } }), true);
});
test('None survives restart after deleting the last model; subtitle-only requests remain valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-no-model-'));
  try {
    await createSettingsStore(root).save({ model: NO_MODEL });
    assert.equal((await createSettingsStore(root).read()).model, NO_MODEL);
    assert.equal(validateStartRequest({ inputPath: 'C:/captions.srt', model: NO_MODEL }).model, NO_MODEL);
    assert.throws(() => validateStartRequest({ inputPath: 'C:/video.mp4', model: NO_MODEL }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('playback follows only its own scroll pane and respects wheel/keyboard manual scrolling', () => {
  let time = 100, top;
  const events = {};
  const pane = { scrollTop: 30, addEventListener: (name, fn) => { events[name] = fn; },
    getBoundingClientRect: () => ({ top: 100, bottom: 300 }), querySelector: () => null,
    scrollTo: value => { top = value.top; } };
  const row = { getBoundingClientRect: () => ({ top: 400, bottom: 450 }) };
  const follower = createPlaybackFollower(pane, { now: () => time });
  follower.follow(row); assert.equal(top, 322);
  events.wheel(); top = undefined; follower.follow(row); assert.equal(top, undefined);
  time += 4001; follower.follow(row); assert.equal(top, 322);
  events.keydown(); assert.equal(follower.allowed(), false);
  follower.resume(); assert.equal(follower.allowed(), true);
});
