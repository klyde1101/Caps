import test from 'node:test';
import assert from 'node:assert/strict';
import { generationAvailability, modelInstalled } from '../src/desktop/renderer/generation-availability.js';

const GiB = 1024 ** 3;
function fixture(device = 'auto') {
  return { files: [{ path: 'C:/clip.mp4' }], settings: { model: 'large-v3-turbo', device, deviceIndex: 0 },
    diagnostics: { models: [{ id: 'large-v3-turbo', installed: true }], memory: { totalBytes: 32 * GiB },
      runtimes: { cpu: { available: true }, cuda: { available: true } },
      cuda: { devices: [{ index: 0, totalMemoryBytes: 8 * GiB, freeMemoryBytes: 8 * GiB }] } } };
}
test('Generate follows the selected model, runtime, free memory and processing policy', () => {
  const options = fixture('cuda');
  assert.equal(generationAvailability(options).enabled, true);
  options.settings.model = 'small';
  assert.equal(generationAvailability(options).reason, 'Model not downloaded');
  options.settings.model = 'large-v3-turbo';
  options.diagnostics.cuda.devices[0].freeMemoryBytes = 2 * GiB;
  assert.match(generationAvailability(options).reason, /Not enough VRAM: recommended ~4 GiB, 2 GiB available/);
  options.settings.device = 'auto'; // CPU fallback is a healthy, supported setup.
  assert.equal(generationAvailability(options).enabled, true);
  options.settings.device = 'cpu'; options.diagnostics.runtimes.cpu.available = false;
  assert.equal(generationAvailability(options).reason, 'CPU runtime unavailable');
  options.settings.device = 'cuda'; options.diagnostics.runtimes.cuda.available = false;
  assert.equal(generationAvailability(options).reason, 'CUDA runtime unavailable');
});
test('deletion events override stale installed diagnostics and SRT-only conversion remains available', () => {
  const options = fixture(); options.downloads = { models: { 'large-v3-turbo': { state: 'idle' } } };
  assert.equal(modelInstalled('large-v3-turbo', options.diagnostics, options.downloads), false);
  assert.equal(generationAvailability(options).enabled, false);
  options.downloads.models['large-v3-turbo'].state = 'installed';
  assert.equal(generationAvailability(options).enabled, true);
  options.downloads.models['large-v3-turbo'].state = 'idle'; options.files = [{ path: 'C:/captions.srt' }];
  assert.equal(generationAvailability(options).enabled, true);
  options.running = true; assert.equal(generationAvailability(options).enabled, false);
  options.running = false; options.files = []; assert.equal(generationAvailability(options).enabled, false);
});
