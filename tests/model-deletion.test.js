import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelDownloadManager } from '../src/desktop/model-download-manager.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'caps-delete-model-'));
  try {
    for (const id of ['small', 'large-v3-turbo']) {
      await mkdir(join(root, 'models', id), { recursive: true });
      for (const file of ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'])
        await writeFile(join(root, 'models', id, file), 'fixture');
    }
    await mkdir(join(root, 'models/alignment')); await writeFile(join(root, 'models/alignment/keep.pt'), 'alignment');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('deleting a model updates the snapshot immediately and preserves the other model and alignment', async () => fixture(async root => {
  const snapshots = []; const manager = new ModelDownloadManager({ root, onChange: value => snapshots.push(value) });
  await manager.initialize(); assert.equal(manager.snapshot().models.small.state, 'installed');
  const result = await manager.deleteModel('small');
  assert.equal(result.models.small.state, 'idle');
  assert.equal(snapshots.at(-1).models.small.state, 'idle');
  await assert.rejects(access(join(root, 'models/small')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'models/large-v3-turbo/model.bin'), 'utf8'), 'fixture');
  assert.equal(await readFile(join(root, 'models/alignment/keep.pt'), 'utf8'), 'alignment');
  await manager.deleteModel('small'); // Repeated requests are harmless.
}));

test('a Windows locked model fails before any file is removed and leaves its installed state unchanged', { skip: process.platform !== 'win32' }, async () => fixture(async root => {
  const path = join(root, 'models/small/model.bin');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[System.IO.File]::Open($env:CAPS_TEST_LOCK,'Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Dispose()"],
  { windowsHide: true, env: { ...process.env, CAPS_TEST_LOCK: path }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await once(holder.stdout, 'data');
    const manager = new ModelDownloadManager({ root }); await manager.initialize();
    await assert.rejects(manager.deleteModel('small'), { code: 'MODEL_LOCKED' });
    assert.equal(manager.snapshot().models.small.state, 'installed');
  } finally { holder.stdin.end('\n'); await once(holder, 'close'); }
  for (const file of ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt']) assert.equal(await readFile(join(root, 'models/small', file), 'utf8'), 'fixture');
}));
test('jobs, downloads and invalid IDs prevent model deletion; deletion reserves the operation synchronously', async () => fixture(async root => {
  let busy = true;
  const manager = new ModelDownloadManager({ root, isModelInUse: () => busy }); await manager.initialize();
  await assert.rejects(manager.deleteModel('small'), { code: 'MODEL_BUSY' });
  busy = false; manager.active = { id: 'large-v3-turbo' };
  await assert.rejects(manager.deleteModel('small'), { code: 'MODEL_BUSY' }); manager.active = null;
  for (const id of ['alignment', '../small', 'C:/other']) await assert.rejects(manager.deleteModel(id), { code: 'INVALID_REQUEST' });
  const removing = manager.deleteModel('small');
  assert.equal(manager.deleting, 'small');
  assert.throws(() => manager.start('large-v3-turbo'), { code: 'MODEL_BUSY' });
  await removing; assert.equal(manager.deleting, null);
}));
