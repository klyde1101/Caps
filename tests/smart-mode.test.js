import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartScheduler, cpuThreads, SMART_VERSION } from '../src/smart-scheduler.js';
import { validateSettings, validateStartRequest } from '../src/desktop/ipc-contract.js';
import { DEFAULT_SETTINGS, createSettingsStore } from '../src/desktop/settings-store.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueueTranscriber } from '../src/queue-transcriber.js';

const model = 'large-v3-turbo';
const profile = () => ({ version: SMART_VERSION, model, threads: cpuThreads(), created: Date.now(), validated: true,
  hardware: 'test GPU', samples: 3, cpuRtf: .1, gpuRtf: .2, transcriptionRtf: .5, startupSeconds: 1,
  ramBytes: 1024 ** 3, minDuration: 10, maxDuration: 100 });
const resources = () => ({ freeRam: 12 * 1024 ** 3, totalRam: 16 * 1024 ** 3, threads: 8, cpuLoad: .2 });
const job = { duration: 60, remaining: 30, pendingAlignment: 120, model, cuda: true };
function scheduler(p = profile(), r = resources) {
  let time = 0;
  const s = new SmartScheduler(p, { now: () => time, resources: r });
  s.observe({ duration: 60, seconds: 30, model }); s.observe({ duration: 60, seconds: 30, model });
  return { s, advance: () => { time += 6000; } };
}

test('retired Smart Mode fields cannot enter settings or job requests', () => {
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS, 'smartMode'), false);
  assert.throws(() => validateSettings({ smartMode: true }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateStartRequest({ inputPath: 'C:/media.wav', smartMode: true }), { code: 'INVALID_REQUEST' });
});

test('legacy Smart Mode settings migrate while preserving supported preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-retired-smart-'));
  try {
    await writeFile(join(root, 'settings.json'), JSON.stringify({ smartMode: true, model: 'small', device: 'cpu' }));
    const settings = await createSettingsStore(root).read();
    assert.equal(Object.hasOwn(settings, 'smartMode'), false);
    assert.equal(settings.model, 'small');
    assert.equal(settings.device, 'cpu');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing, stale, unvalidated and malformed measurements fall back', () => {
  for (const p of [undefined, { ...profile(), validated: false }, { ...profile(), created: 0 },
    { ...profile(), cpuRtf: NaN }, { ...profile(), samples: 1 }, { ...profile(), model: 'another' }]) {
    const s = new SmartScheduler(p, { resources });
    assert.equal(s.decide(job), false);
    assert.equal(s.state, 'paused');
  }
});
test('scheduler requires a minimum observation window and predicts complete batch time', () => {
  const s = new SmartScheduler(profile(), { resources });
  assert.equal(s.decide(job), false);
  assert.match(s.reason, /Observing/);
  assert.equal(scheduler().s.decide(job), true);
  assert.equal(scheduler({ ...profile(), cpuRtf: 10 }).s.decide(job), false);
  assert.equal(scheduler().s.decide({ ...job, remaining: 0 }), false);
  assert.equal(scheduler().s.decide({ ...job, overheadSeconds: 30 }), false);
});
test('high CPU, limited RAM, unsupported CPU mode, recovery and unmeasured durations stay on baseline', () => {
  for (const r of [{ ...resources(), cpuLoad: .95 }, { ...resources(), freeRam: 1e9 }, { ...resources(), threads: 2 }]) {
    assert.equal(scheduler(profile(), () => r).s.decide(job), false);
  }
  for (const change of [{ cuda: false }, { recovery: true }, { duration: 600 }, { gpuFreeBytes: 100 * 1024 ** 2 }]) {
    assert.equal(scheduler().s.decide({ ...job, ...change }), false);
  }
});
test('hysteresis prevents immediate restart and repeated measured contention disables assistance', () => {
  const { s, advance } = scheduler();
  s.decide({ ...job, cuda: false });
  assert.equal(s.decide(job), false);
  advance(); assert.equal(s.decide(job), true);
  s.observe({ duration: 60, seconds: 40, overlap: true, model });
  assert.equal(s.state, 'active');
  s.observe({ duration: 60, seconds: 40, overlap: true, model });
  assert.equal(s.state, 'disabled');
  advance(); assert.equal(s.decide(job), false);
});

test('legacy internal Smart Mode options cannot create a CPU assistance worker or duplicate alignment', async () => {
  const actions = [], items = [];
  const transcriber = await createQueueTranscriber({ smartMode: true, smartProfile: profile(),
    createWorker: async (options) => {
      actions.push('worker:' + options.device);
      return {
        async transcribe(request, fileIndex) { items.push({ fileIndex, srt: request.inputPath }); },
        async release() { actions.push('release'); },
        async align() { actions.push('align'); return [...items]; },
        async close() { actions.push('close'); }
      };
    }
  });
  try {
    for (let index = 0; index < 3; index++) await transcriber.transcribe({ inputPath: index + '.wav', device: 'cuda', model }, index);
    assert.deepEqual((await transcriber.align()).map(item => item.fileIndex), [0, 1, 2]);
    assert.deepEqual(actions, ['worker:cuda', 'release', 'align']);
  } finally { await transcriber.close(); }
  assert.equal(actions.at(-1), 'close');
});
