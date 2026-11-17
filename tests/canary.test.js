import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, isSupportedModel } from '../src/model-catalog.js';
import { createSettingsStore } from '../src/desktop/settings-store.js';
import { validateStartRequest } from '../src/desktop/ipc-contract.js';

test('retired Canary settings migrate to WhisperX without losing device and timing preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-retired-canary-'));
  try {
    await writeFile(join(root, 'settings.json'), JSON.stringify({
      model: 'canary-qwen-2.5b', device: 'cpu', timing: { minDurationMs: 180, bridgeGapMs: 60 }
    }));
    const store = createSettingsStore(root);
    const settings = await store.read();
    assert.equal(settings.model, DEFAULT_MODEL);
    assert.equal(settings.device, 'cpu');
    assert.deepEqual(settings.timing, { minDurationMs: 180, bridgeGapMs: 60 });
    await store.save(settings);
    assert.deepEqual(await store.read(), settings);
    assert.equal(isSupportedModel('canary-qwen-2.5b'), false);
    assert.throws(() => validateStartRequest({ inputPath: join(root, 'clip.wav'), model: 'canary-qwen-2.5b' }), { code: 'INVALID_REQUEST' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
