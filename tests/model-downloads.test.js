import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelDownloadManager, parseHubManifest, downloadBytes, redactDownloadLog } from '../src/desktop/model-download-manager.js';

const contents = { 'config.json': '{}', 'model.bin': 'weights'.repeat(128), 'tokenizer.json': '{}', 'vocabulary.txt': 'test\n' };
const api = { sha: 'a'.repeat(40), siblings: Object.entries(contents).map(([rfilename, text]) => ({ rfilename, size: Buffer.byteLength(text) })) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'caps-model-download-'));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function childStub(run) {
  return (_python, args, options) => {
    const child = new EventEmitter(); child.exitCode = null;
    child.finish = (code) => { if (child.exitCode !== null) return; child.exitCode = code; child.emit('close', code); };
    child.kill = () => { queueMicrotask(() => child.finish(1)); return true; };
    void Promise.resolve().then(() => run(args[6], child, args, options)).catch((error) => child.emit('error', error));
    return child;
  };
}
function manager(root, extra = {}) {
  return new ModelDownloadManager({ root, fetchImpl: async () => ({ ok: true, json: async () => api }),
    findPython: async () => 'bundled/python.exe', freeBytes: async () => 10 ** 12, pollMs: 5, ...extra });
}
async function writeComplete(directory) { for (const [name, text] of Object.entries(contents)) await writeFile(join(directory, name), text); }
async function partial(directory) {
  const cache = join(directory, '.cache', 'huggingface', 'download'); await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'mBG94Lz8EYH5gU8b5axgj2RF9Tk=.hash.incomplete'), 'partial data');
}

test('Hub manifests require exact sizes and required runtime files and never accept renderer paths', () => {
  const manifest = parseHubManifest('small', api);
  assert.equal(manifest.totalBytes, Object.values(contents).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
  assert.equal(manifest.repoId, 'Systran/faster-whisper-small');
  assert.throws(() => parseHubManifest('../evil', api));
  assert.throws(() => parseHubManifest('small', { ...api, siblings: [{ rfilename: 'model.bin', size: 10 }] }));
  assert.throws(() => parseHubManifest('small', { ...api, siblings: api.siblings.map((file) => ({ ...file, size: undefined })) }));
  assert.throws(() => parseHubManifest('small', { ...api, sha: 'main' }));
  const safe = parseHubManifest('small', { ...api, siblings: [...api.siblings, { rfilename: 'LICENSE\\..\\..\\outside', size: 10 }] });
  assert.ok(!safe.files.some((file) => file.name.includes('\\')));
});

test('background download hides Windows, closes stdin, logs only to file descriptors and publishes atomically', async () => fixture(async (root) => {
  const snapshots = []; let hiddenOptions;
  const instance = manager(root, { onChange: (value) => snapshots.push(value), spawnImpl: childStub(async (directory, child, args, options) => {
    hiddenOptions = options;
    assert.equal(args[4], 'Systran/faster-whisper-small');
    assert.equal(args[5], api.sha);
    for (const [name, text] of Object.entries(contents)) {
      await writeFile(join(directory, name), text); await sleep(12);
      await assert.rejects(access(join(root, 'models', 'small')));
    }
    child.finish(0);
  }) });
  await instance.initialize(); instance.start('small');
  assert.throws(() => instance.start('large-v3-turbo'), { code: 'DOWNLOAD_BUSY' });
  await instance.active.done;
  assert.equal(instance.snapshot().models.small.state, 'installed');
  assert.equal(await readFile(join(root, 'models', 'small', 'model.bin'), 'utf8'), contents['model.bin']);
  assert.equal(hiddenOptions.windowsHide, true); assert.equal(hiddenOptions.shell, false);
  assert.equal(hiddenOptions.stdio[0], 'ignore');
  assert.equal(typeof hiddenOptions.stdio[1], 'number'); assert.equal(hiddenOptions.stdio[1], hiddenOptions.stdio[2]);
  assert.equal(hiddenOptions.env.HF_HUB_DISABLE_IMPLICIT_TOKEN, '1');
  assert.equal(hiddenOptions.env.HF_TOKEN, undefined);
  assert.ok(snapshots.some((snapshot) => snapshot.models.small.bytes > 0 && snapshot.models.small.percent < 100));
  assert.equal(instance.snapshot().activeId, null);
}));

test('incomplete files count toward bytes without double counting completed files', async () => fixture(async (root) => {
  const manifest = parseHubManifest('small', api); await partial(root);
  assert.equal(await downloadBytes(root, manifest), Buffer.byteLength('partial data'));
  await writeFile(join(root, 'model.bin'), contents['model.bin']);
  assert.equal(await downloadBytes(root, manifest), Buffer.byteLength(contents['model.bin']));
}));

test('failure retains a pinned resumable snapshot; retry does not restart from zero', async () => fixture(async (root) => {
  let calls = 0; let apiCalls = 0;
  const instance = manager(root, {
    fetchImpl: async () => { apiCalls++; return { ok: true, json: async () => api }; },
    spawnImpl: childStub(async (directory, child) => {
      if (++calls === 1) { await partial(directory); child.finish(1); }
      else { assert.ok(await downloadBytes(directory, parseHubManifest('small', api)) > 0); await writeComplete(directory); child.finish(0); }
    })
  });
  await instance.initialize(); instance.start('small'); await instance.active.done;
  assert.equal(instance.snapshot().models.small.state, 'failed');
  await assert.rejects(access(join(root, 'models', 'small')));
  instance.start('small'); await instance.active.done;
  assert.equal(instance.snapshot().models.small.state, 'installed'); assert.equal(apiCalls, 1);
}));

test('offline failure and insufficient disk space never publish an installed model', async () => fixture(async (root) => {
  const offline = manager(root, { fetchImpl: async () => { throw new Error('offline'); } });
  await offline.initialize(); offline.start('small'); await offline.active.done;
  assert.equal(offline.snapshot().models.small.state, 'failed');
  let spawned = false;
  const full = manager(root, { freeBytes: async () => 0, spawnImpl: () => { spawned = true; } });
  await full.initialize(); full.start('small'); await full.active.done;
  assert.equal(full.snapshot().models.small.state, 'failed');
  assert.match(full.snapshot().models.small.message, /disk space/); assert.equal(spawned, false);
  await assert.rejects(access(join(root, 'models', 'small')));
}));

test('Cancel stops the child and removes only its staging folder', async () => fixture(async (root) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const instance = manager(root, { spawnImpl: childStub(async (directory) => { await partial(directory); started(); }) });
  await mkdir(join(root, 'models', 'large-v3-turbo'), { recursive: true });
  await writeFile(join(root, 'models', 'large-v3-turbo', 'keep.txt'), 'keep');
  await instance.initialize(); instance.start('small'); await ready;
  await instance.cancel('small');
  assert.equal(instance.snapshot().models.small.state, 'idle');
  await assert.rejects(access(join(root, 'models', '.downloads', 'small')));
  assert.equal(await readFile(join(root, 'models', 'large-v3-turbo', 'keep.txt'), 'utf8'), 'keep');
}));

test('quitting pauses downloads, and restart offers Retry without mistaking partial data for installation', async () => fixture(async (root) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const first = manager(root, { spawnImpl: childStub(async (directory) => { await partial(directory); started(); }) });
  await first.initialize(); first.start('small'); await ready; await first.shutdown();
  const second = manager(root, { spawnImpl: childStub(async (directory, child) => { await writeComplete(directory); child.finish(0); }) });
  await second.initialize();
  assert.equal(second.snapshot().models.small.state, 'failed');
  assert.match(second.snapshot().models.small.message, /interrupted/);
  assert.ok(second.snapshot().models.small.bytes > 0);
  second.start('small'); await second.active.done;
  assert.equal(second.snapshot().models.small.state, 'installed', await readFile(join(root, 'data/logs/model-download-small.log'), 'utf8').catch(() => JSON.stringify(second.snapshot())));
}));

test('successful child exit is insufficient without verified required files', async () => fixture(async (root) => {
  const instance = manager(root, { spawnImpl: childStub(async (_directory, child) => child.finish(0)) });
  await instance.initialize(); instance.start('small'); await instance.active.done;
  assert.equal(instance.snapshot().models.small.state, 'failed');
  await assert.rejects(access(join(root, 'models', 'small')));
}));

test('a closed or reloading renderer cannot interrupt an app-level download', async () => fixture(async (root) => {
  const instance = manager(root, { onChange: () => { throw new Error('Renderer destroyed'); },
    spawnImpl: childStub(async (directory, child) => { await writeComplete(directory); child.finish(0); }) });
  await instance.initialize(); instance.start('small'); await instance.active.done;
  assert.equal(instance.snapshot().models.small.state, 'installed');
  assert.equal(instance.snapshot().activeId, null);
}));

test('download logs redact tokens, authorization values, signed URL queries and embedded credentials', () => {
  const text = redactDownloadLog('Authorization: Bearer eyJsecret https://user:password@example.com/file?token=abc access_token=hidden hf_testsecret');
  for (const secret of ['eyJsecret', 'hf_testsecret', 'password', 'token=abc', 'access_token=hidden']) assert.ok(!text.includes(secret));
});
