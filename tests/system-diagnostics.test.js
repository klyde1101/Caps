import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { directorySize, inspectInstalledModels } from '../src/whisperx-runner.js';
import { detectCudaDevices, parseNvidiaSmiOutput } from '../src/desktop/system-diagnostics.js';

test('CUDA diagnostics parse GPU names and VRAM capacities', () => {
  const devices = parseNvidiaSmiOutput('0, NVIDIA GeForce RTX 3050, 8192, 7424\r\n1, NVIDIA RTX 6000 Ada, 49140, 48000\r\n');
  assert.deepEqual(devices.map(({ index, name, totalMemoryMiB, freeMemoryMiB }) => ({ index, name, totalMemoryMiB, freeMemoryMiB })), [
    { index: 0, name: 'NVIDIA GeForce RTX 3050', totalMemoryMiB: 8192, freeMemoryMiB: 7424 },
    { index: 1, name: 'NVIDIA RTX 6000 Ada', totalMemoryMiB: 49140, freeMemoryMiB: 48000 }
  ]);
  assert.equal(devices[0].totalMemoryBytes, 8192 * 1024 * 1024);
});

test('CUDA detection returns an empty supported result when nvidia-smi is unavailable', async () => {
  const result = await detectCudaDevices({ run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.deepEqual(result, { available: false, devices: [], error: 'ENOENT' });
});

test('installed model diagnostics report recursive folder sizes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caps-model-sizes-'));
  try {
    const modelPath = join(directory, 'large-v3');
    const nested = join(modelPath, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(modelPath, 'model.bin'), Buffer.alloc(10));
    await writeFile(join(nested, 'config.json'), Buffer.alloc(1));
    assert.equal(await directorySize(modelPath), 11);
    const models = await inspectInstalledModels(() => modelPath);
    assert.deepEqual(models, [
      { id: 'large-v3-turbo', label: 'Large v3 Turbo', path: modelPath, installed: true, sizeBytes: 11 },
      { id: 'small', label: 'Small', path: modelPath, installed: true, sizeBytes: 11 }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('model diagnostics retain the UI shape when a local model is absent', async () => {
  assert.deepEqual(await inspectInstalledModels((id) => id), [
    { id: 'large-v3-turbo', label: 'Large v3 Turbo', path: 'large-v3-turbo', installed: false, sizeBytes: 0 },
    { id: 'small', label: 'Small', path: 'small', installed: false, sizeBytes: 0 }
  ]);
});
