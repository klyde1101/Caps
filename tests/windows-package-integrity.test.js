import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { REQUIRED_RUNTIME_FILES, verifyWindowsPackage } from '../scripts/verify-windows-package.mjs';

const asar = createRequire(import.meta.url)('@electron/asar');

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'caps-runtime-integrity-'));
  try {
    const unpackedRoot = join(root, 'unpacked'); const electronRoot = join(root, 'electron');
    const projectRoot = join(root, 'project'); const artifactPath = join(root, 'Caps-portable.exe');
    for (const base of [unpackedRoot, electronRoot]) {
      for (const name of REQUIRED_RUNTIME_FILES) {
        await mkdir(join(base, name, '..'), { recursive: true });
        await writeFile(join(base, name), `runtime ${name}`);
      }
    }
    await mkdir(join(unpackedRoot, 'resources'), { recursive: true });
    await mkdir(join(projectRoot, 'src/desktop'), { recursive: true });
    await mkdir(join(projectRoot, 'build'), { recursive: true });
    await writeFile(join(projectRoot, 'src/desktop/main.js'), 'current application code');
    await writeFile(join(projectRoot, 'package.json'), '{"main":"src/desktop/main.js"}');
    await writeFile(join(projectRoot, 'build/caps-icon.png'), 'original icon');
    await writeFile(join(projectRoot, 'build/caps-icon.ico'), 'multi-resolution icon');
    await writeFile(join(unpackedRoot, 'Caps.exe'), 'MZ bare Electron');
    await writeFile(artifactPath, 'MZ portable NullsoftInst binary');
    await asar.createPackage(projectRoot, join(unpackedRoot, 'resources/app.asar'));
    await action({ unpackedRoot, electronRoot, projectRoot, artifactPath });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('packaged runtime and every included application file must match their sources', async () => {
  await fixture(async (options) => assert.equal((await verifyWindowsPackage(options)).applicationFiles, 4));
});

test('missing or damaged ICU data blocks publication before cleanup', async () => {
  await fixture(async (options) => {
    await unlink(join(options.unpackedRoot, 'icudtl.dat'));
    await assert.rejects(verifyWindowsPackage(options), /Missing packaged runtime file: icudtl.dat/);
    await writeFile(join(options.unpackedRoot, 'icudtl.dat'), 'corrupted ICU');
    await assert.rejects(verifyWindowsPackage(options), /runtime file is damaged: icudtl.dat/);
  });
});

test('stale renderer or main-process code cannot be published', async () => {
  await fixture(async (options) => {
    await writeFile(join(options.projectRoot, 'src/desktop/main.js'), 'new application code');
    await assert.rejects(verifyWindowsPackage(options), /application file is stale/);
  });
});

test('the raw Electron executable cannot be mistaken for the portable release', async () => {
  await fixture(async (options) => {
    await writeFile(options.artifactPath, 'MZ bare Electron');
    await assert.rejects(verifyWindowsPackage(options), /self-contained NSIS portable executable/);
  });
});

test('package metadata permits builder formatting while enforcing runtime entry points', async () => {
  await fixture(async (options) => {
    await writeFile(join(options.projectRoot, 'package.json'), '{\n  "main": "src/desktop/main.js", "scripts": {"test":"node --test"}\n}');
    await verifyWindowsPackage(options);
    await writeFile(join(options.projectRoot, 'package.json'), '{"main":"src/desktop/obsolete.js"}');
    await assert.rejects(verifyWindowsPackage(options), /metadata is stale: main/);
  });
});
