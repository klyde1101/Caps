import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanProject } from '../scripts/clean-project.mjs';
import { REQUIRED_RUNTIME_FILES } from '../scripts/verify-windows-package.mjs';

const currentName = 'app-' + 'a'.repeat(24), legacyName = 'app-' + 'b'.repeat(24), oldName = 'app-' + 'c'.repeat(24);
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'caps-cleanup-'));
  const put = async (path, text = 'fixture') => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  try {
    for (const folder of [currentName, legacyName, oldName])
      for (const name of ['Caps.exe', ...REQUIRED_RUNTIME_FILES, 'resources/app.asar']) await put(`dist/${folder}/${name}`);
    await put('Caps.exe', `MZ\0dist\\${currentName}`);
    await put('Caps-rollback.exe', `MZ\0dist\\${legacyName}`);
    for (const name of ['runtime-verification', 'uv-cache', 'electron-probe-runtime']) await put(`data/${name}/temporary.bin`);
    await put('data/settings.json', 'settings'); await put('data/timing-qa/video.mp4', 'personal media');
    await put('data/review-checkout/src/code.js', 'reviewed source'); await put('models/small/model.bin', 'weights');
    await action({ root, put, clean: options => cleanProject({ root, verify: async () => {}, inUse: async () => false, ...options }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('cleanup previews first, removes only allowlisted files, and retains only current and personal data', async () => {
  await fixture(async ({ root, clean }) => {
    const preview = await clean({});
    assert.equal(preview.applied, false); assert.equal(preview.targets.length, 6);
    assert.ok(await stat(join(root, 'dist', oldName)));
    const report = await clean({ apply: true }); assert.equal(report.removedBytes, preview.removedBytes);
    await assert.rejects(stat(join(root, 'dist', oldName)), { code: 'ENOENT' });
    for (const name of ['data/settings.json', 'data/timing-qa/video.mp4', 'data/review-checkout/src/code.js', 'models/small/model.bin',
      `dist/${currentName}/icudtl.dat`]) assert.ok(await stat(join(root, name)));
    assert.equal(JSON.parse(await readFile(join(root, 'data/logs/project-cleanup.json'))).applied, true);
  });
});

test('cleanup preserves every file of an older running build and fails closed if lock inspection fails', async () => {
  await fixture(async ({ root, clean }) => {
    const active = join(root, 'dist', oldName, 'Caps.exe');
    const report = await clean({ apply: true, inUse: async path => path === join(root, 'dist', oldName) });
    assert.deepEqual(report.retainedRunning, [join(root, 'dist', oldName)]);
    assert.ok(await stat(join(root, 'dist', oldName, 'resources/app.asar')));
    assert.ok(await stat(join(root, 'dist', oldName, 'icudtl.dat')));
    await assert.rejects(clean({ apply: true, inUse: async () => { throw Error('lock inspection unavailable'); } }), /lock inspection unavailable/);
    assert.ok(await stat(active));
  });
});

test('incomplete retained builds and failed source verification prevent every deletion', async () => {
  await fixture(async ({ root, clean }) => {
    await assert.rejects(clean({ apply: true, verify: async () => { throw Error('stale application'); } }), /stale application/);
    await rm(join(root, 'dist', currentName, 'icudtl.dat'));
    await assert.rejects(clean({ apply: true }), /retained runtime is incomplete/);
    assert.ok(await stat(join(root, 'data/uv-cache/temporary.bin')));
    assert.ok(await stat(join(root, 'dist', oldName)));
  });
});

test('cleanup refuses junctions into external folders before removing any target', async (t) => {
  await fixture(async ({ root, clean }) => {
    const external = await mkdtemp(join(tmpdir(), 'caps-cleanup-external-'));
    try {
      await writeFile(join(external, 'keep.txt'), 'keep');
      try {
        await symlink(external, join(root, 'data/uv-cache/external'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error.code !== 'EPERM') throw error;
        t.skip('This Windows sandbox does not permit creating junctions.'); return;
      }
      await assert.rejects(clean({ apply: true }), /Refusing linked cleanup entry/);
      assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'keep');
      assert.ok(await stat(join(root, 'dist', oldName)));
    } finally { await rm(external, { recursive: true, force: true }); }
  });
});

test('portable publication verifies the artifact and removes legacy builds', async () => {
  await fixture(async ({ root, put, clean }) => {
    await put('Caps.exe', 'MZ portable NullsoftInst binary');
    const staged = join(root, 'dist', currentName);
    let artifact;
    await clean({ apply: true, publishedRuntime: staged, verify: async options => { artifact = options.artifactPath; } });
    assert.equal(artifact, join(root, 'Caps.exe'));
    await assert.rejects(stat(join(root, 'dist', legacyName)), { code: 'ENOENT' });
    await assert.rejects(stat(join(root, 'dist', oldName)), { code: 'ENOENT' });
  });
});

test('cleanup removes legacy launcher and runtime and never recreates backups', async () => {
  await fixture(async ({ root, clean }) => {
    await clean({ apply: true });
    for (const name of ['Caps-rollback.exe', 'dist/' + legacyName, 'dist/' + oldName])
      await assert.rejects(stat(join(root, name)), { code: 'ENOENT' });
    const repeated = await clean({ apply: true });
    assert.equal(repeated.targets.length, 0);
    assert.ok(await stat(join(root, 'Caps.exe')));
    assert.ok(await stat(join(root, 'dist', currentName, 'icudtl.dat')));
  });
});
