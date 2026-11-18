import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

export const REQUIRED_RUNTIME_FILES = [
  'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'ffmpeg.dll', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
  'vulkan-1.dll', 'locales/en-US.pak'
];

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function sourceFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(join(directory, entry.name), name));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}

export async function verifyWindowsPackage({ unpackedRoot, electronRoot, artifactPath, projectRoot }) {
  // These are runtime data, not disposable build output. Electron cannot start without ICU.
  for (const name of ['Caps.exe', ...REQUIRED_RUNTIME_FILES, 'resources/app.asar']) {
    const file = join(unpackedRoot, name);
    assert.ok((await stat(file).catch(() => null))?.size > 0, `Missing packaged runtime file: ${name}`);
  }
  for (const name of REQUIRED_RUNTIME_FILES) {
    assert.equal(await digest(join(unpackedRoot, name)), await digest(join(electronRoot, name)),
      `Packaged Electron runtime file is damaged: ${name}`);
  }
  const archive = join(unpackedRoot, 'resources/app.asar');
  const files = (await sourceFiles(join(projectRoot, 'src')))
    .filter((name) => normalize(name) !== 'main.js').map((name) => join('src', name));
  files.push('build/caps-icon.png');
  files.push('build/caps-icon.ico');
  files.push('LICENSE');
  for (const name of files) {
    assert.ok(asar.extractFile(archive, normalize(name)).equals(await readFile(join(projectRoot, name))),
      `Packaged application file is stale: ${name}`);
  }
  // electron-builder removes development-only metadata and reformats package.json.
  const packagedMetadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  const sourceMetadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  for (const name of ['name', 'version', 'main', 'type', 'dependencies']) {
    assert.deepEqual(packagedMetadata[name], sourceMetadata[name], `Packaged application metadata is stale: ${name}`);
  }
  if (artifactPath) {
    const executable = await readFile(artifactPath);
    assert.equal(executable.subarray(0, 2).toString('ascii'), 'MZ', 'Portable executable is invalid');
    assert.ok(executable.subarray(0, 1024 * 1024).includes(Buffer.from('NullsoftInst')),
      'Expected a self-contained NSIS portable executable, not the bare Electron executable');
  }
  return { runtimeFiles: REQUIRED_RUNTIME_FILES.length, applicationFiles: files.length + 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [unpackedRoot, electronRoot, artifactPath, projectRoot] = process.argv.slice(2);
  try {
    const result = await verifyWindowsPackage({ unpackedRoot, electronRoot, artifactPath: artifactPath === '-' ? undefined : artifactPath, projectRoot });
    console.log(`Verified ${result.runtimeFiles} Electron runtime files and ${result.applicationFiles} current application files.`);
  } catch (error) {
    console.error(`Package verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
