import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppUpdates, compareVersions, selectRelease, validateAssetUrl, validateUpdateManifest } from '../src/desktop/app-updates.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const urlFor = name => `https://github.com/klyde1101/Caps/releases/download/v1.0.1/${name}`;
function fixture({ corrupt = false } = {}) {
  const archive = Buffer.from('Fixture update archive');
  const manifest = { schema: 1, version: '1.0.1', runtimeRevision: 1, runtimeDirectory: 'dist/app-' + 'a'.repeat(24),
    archive: 'Caps-1.0.1-Update-x64.zip', size: archive.length, sha256: hash(archive) };
  const metadata = Buffer.from(JSON.stringify(manifest));
  const release = { tag_name: 'v1.0.1', draft: false, prerelease: false, assets: [
    { name: 'Caps-1.0.1-Update.json', size: metadata.length, digest: 'sha256:' + hash(metadata), browser_download_url: urlFor('Caps-1.0.1-Update.json') },
    { name: manifest.archive, size: archive.length, digest: 'sha256:' + hash(archive), browser_download_url: urlFor(manifest.archive) }
  ] };
  const requests = [];
  return { manifest, release, requests, fetchImpl: async (url) => {
    requests.push(url);
    return new Response(url.includes('api.github.com') ? JSON.stringify([release])
      : url.endsWith('.json') ? metadata : corrupt ? Buffer.from('bad') : archive);
  } };
}

test('release order honors stable/prerelease versions, drafts, and numeric prerelease order', () => {
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.throws(() => compareVersions('1.0.0-beta.01', '1.0.0'));
  const releases = [{ tag_name: 'v1.1.0-beta.1', prerelease: true }, { tag_name: 'v1.0.1' }, { tag_name: 'v9.0.0', draft: true }];
  assert.equal(selectRelease(releases, '1.0.0').tag_name, 'v1.0.1');
  assert.equal(selectRelease(releases, '1.0.0-beta.1').tag_name, 'v1.1.0-beta.1');
  assert.equal(selectRelease(releases, '2.0.0'), undefined);
});

test('update addresses and manifests reject other hosts, traversal, incompatible runtimes and missing digests', () => {
  for (const url of ['http://github.com/file', 'https://github.com.evil.test/file', 'https://user@github.com/file', 'https://github.com:123/file']) {
    assert.throws(() => validateAssetUrl(url));
  }
  const { manifest, release } = fixture();
  assert.equal(validateUpdateManifest(manifest, release).version, '1.0.1');
  for (const change of [{ runtimeDirectory: '../models' }, { runtimeRevision: 2 }, { sha256: '0'.repeat(64) }, { size: 2 ** 31 }, { version: '0.1.0' }]) {
    assert.throws(() => validateUpdateManifest({ ...manifest, ...change }, release));
  }
});

test('verified updates stage for normal exit, keep their manifest, and persist the opt-out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-'));
  try {
    const { fetchImpl, requests } = fixture(); const spawned = [];
    const updates = new AppUpdates({ root, version: '1.0.0', fetchImpl, spawnImpl: (...args) => {
      spawned.push(args);
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
    await updates.initialize();
    const result = await updates.check();
    assert.equal(result.state, 'ready'); assert.equal(requests.length, 3); assert.equal(spawned.length, 0);
    const pending = JSON.parse(await readFile(updates.pending.record));
    assert.match(updates.pending.record, /pending-[a-f0-9-]{36}\.json$/);
    assert.equal(pending.root, root); assert.equal(pending.parentPid, process.pid);
    await Promise.all([updates.applyOnExit(), updates.applyOnExit()]);
    assert.equal(spawned.length, 1); assert.equal(spawned[0][2].shell, false); assert.equal(spawned[0][2].windowsHide, true);
    await updates.setAutomatic(false);
    const reopened = new AppUpdates({ root, version: '1.0.0', fetchImpl });
    assert.equal((await reopened.initialize()).automatic, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disabling updates during final staging removes the queued record and prevents installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-race-'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let staged;
  let stagedPath;
  const reached = new Promise(resolve => { staged = resolve; });
  try {
    const updates = new AppUpdates({ root, version: '1.0.0', ...fixture(),
      writeFileImpl: async (path, content) => {
        await writeFile(path, content);
        if (path.includes('pending-')) { stagedPath = path; staged(); await gate; }
      },
      spawnImpl: () => { assert.fail('A cancelled update must never launch'); }
    });
    const check = updates.check();
    await reached;
    updates.abort.signal.addEventListener('abort', release, { once: true });
    await updates.setAutomatic(false);
    await check;
    await updates.applyOnExit();
    assert.equal(updates.pending, undefined);
    assert.equal(updates.snapshot().state, 'idle');
    await assert.rejects(readFile(stagedPath), { code: 'ENOENT' });
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('switching off and immediately closing waits for the save without launching a queued update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-close-'));
  let release, saving;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { saving = resolve; });
  try {
    const updates = new AppUpdates({ root, version: '1.0.0', ...fixture(),
      writeFileImpl: async (path, content) => {
        if (path.includes('preferences-')) { saving(); await gate; }
        await writeFile(path, content);
      }, spawnImpl: () => assert.fail('A revoked update cannot start') });
    await updates.check();
    const record = updates.pending.record;
    const off = updates.setAutomatic(false);
    assert.equal(updates.pending, undefined, 'clear permission before the first await');
    let stopped = false;
    const shutdown = updates.shutdown().then(() => { stopped = true; });
    const exiting = updates.applyOnExit();
    await entered;
    assert.equal(stopped, false, 'shutdown must wait for persistence');
    release();
    await Promise.all([off, shutdown, exiting]);
    assert.equal(JSON.parse(await readFile(join(root, 'data/updates/preferences.json'))).automatic, false);
    await assert.rejects(readFile(record), { code: 'ENOENT' });
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('a failed opt-out save reports the failure without resurrecting the cancelled update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-save-error-'));
  try {
    const updates = new AppUpdates({ root, version: '1.0.0', ...fixture(),
      writeFileImpl: (path, content) => path.includes('preferences-') ? Promise.reject(new Error('Disk full')) : writeFile(path, content),
      spawnImpl: () => assert.fail('A preference failure must not resurrect installation') });
    await updates.check();
    const failed = assert.rejects(updates.setAutomatic(false), /Disk full/);
    await updates.shutdown();
    await failed;
    await updates.applyOnExit();
    assert.equal(updates.pending, undefined);
    assert.equal(updates.snapshot().automatic, true, 'do not claim that persistence succeeded');
    assert.match(updates.snapshot().message, /Could not save/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('helper launch failures survive reopening and can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-launch-'));
  try {
    let fail = true, launches = 0;
    const updates = new AppUpdates({ root, version: '1.0.0', ...fixture(), spawnImpl: () => {
      launches++;
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', new Error('Access denied')));
      return child;
    } });
    await updates.check();
    await updates.applyOnExit();
    assert.ok(updates.pending, 'retain queued update until a helper starts');
    const reopened = new AppUpdates({ root, version: '1.0.0' });
    assert.match((await reopened.initialize()).message, /Access denied.*retry/);
    assert.equal(reopened.snapshot().state, 'error');
    fail = false;
    await updates.applyOnExit();
    assert.equal(launches, 2);
    assert.equal(updates.pending, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the real Windows helper executes with hidden-window launch options', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-real-launch-'));
  try {
    const updates = new AppUpdates({ root, version: '1.0.0', ...fixture() });
    await updates.check();
    await writeFile(updates.pending.helper, 'param([string]$Record)\n[IO.File]::WriteAllText($Record + ".ran", "executed")');
    const record = updates.pending.record;
    await updates.applyOnExit();
    let executed;
    for (let attempt = 0; attempt < 100; attempt++) {
      executed = await readFile(record + '.ran', 'utf8').catch(() => undefined);
      if (executed) break;
      await setTimeout(50);
    }
    assert.equal(executed, 'executed', 'PowerShell must execute the helper, not merely emit a spawn event');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt archives and untrusted redirects never become installable updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-'));
  try {
    const updates = new AppUpdates({ root, version: '1.0.0', ...fixture({ corrupt: true }) });
    assert.equal((await updates.check()).state, 'error'); assert.equal(updates.pending, undefined);
    await assert.rejects(readFile(join(root, 'data/updates/pending.json')), { code: 'ENOENT' });
    const redirect = new AppUpdates({ root, version: '1.0.0', fetchImpl: async () => new Response(null,
      { status: 302, headers: { Location: 'https://example.test/update.exe' } }) });
    assert.equal((await redirect.check()).state, 'error'); assert.equal(redirect.pending, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('turning automatic updates off clears an already downloaded update without applying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-update-'));
  try {
    const updates = new AppUpdates({ root, version: '1.0.0', ...fixture() });
    await updates.check(); assert.equal(updates.snapshot().state, 'ready');
    await updates.setAutomatic(false);
    assert.equal(updates.pending, undefined); assert.equal(updates.snapshot().state, 'idle');
  } finally { await rm(root, { recursive: true, force: true }); }
});
