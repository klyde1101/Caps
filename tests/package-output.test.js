import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const artifactName = 'Caps-0.0.0-test.exe';

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'caps-package-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'build'));
    await copyFile(new URL('../build/caps-icon.ico', import.meta.url), join(root, 'build/caps-icon.ico'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
    for (const name of ['package-win.ps1', 'clean-package-staging.ps1', 'verify-windows-package.mjs', 'build-windows-launcher.ps1', 'windows-launcher.cs']) {
      await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
    }
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('packaging replaces the root executable and removes temporary staging', { skip: !windows }, async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'Caps.exe'), 'previous binary');
    await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      function npx {
        $output = ($args | Where-Object { $_ -like '--config.directories.output=*' } | Select-Object -First 1).Substring('--config.directories.output='.Length)
        New-Item -ItemType Directory -Force -Path (Join-Path $output 'win-unpacked') | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $output '${artifactName}'), 'MZ portable NullsoftInst binary')
        [System.IO.File]::WriteAllText((Join-Path $output 'builder-debug.yml'), 'staging')
        $global:LASTEXITCODE = 0
      }
      function node { $global:LASTEXITCODE = 0 }
      & './scripts/package-win.ps1'
    `], { cwd: root, windowsHide: true });
    assert.equal(await readFile(join(root, 'Caps.exe'), 'utf8'), 'MZ portable NullsoftInst binary');
    assert.deepEqual((await readdir(root)).sort(), ['Caps.exe', 'build', 'package.json', 'scripts']);
  });
});

test('a failed replacement preserves the previous executable and complete runtime', { skip: !windows }, async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'Caps.exe'), 'previous portable binary');
    await mkdir(join(root, 'dist/win-unpacked'), { recursive: true });
    await writeFile(join(root, 'dist/win-unpacked/icudtl.dat'), 'previous ICU');
    await assert.rejects(run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      function npx { $global:LASTEXITCODE = 7 }
      & './scripts/package-win.ps1'
      exit $LASTEXITCODE
    `], { cwd: root, windowsHide: true }), { code: 7 });
    assert.equal(await readFile(join(root, 'Caps.exe'), 'utf8'), 'previous portable binary');
    assert.equal(await readFile(join(root, 'dist/win-unpacked/icudtl.dat'), 'utf8'), 'previous ICU');
  });
});

test('cleanup refuses a bare Electron executable and preserves its ICU data', { skip: !windows }, async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'Caps.exe'), 'MZ bare Electron executable');
    await mkdir(join(root, 'dist/win-unpacked'), { recursive: true });
    await writeFile(join(root, 'dist/win-unpacked/icudtl.dat'), 'runtime ICU');
    await assert.rejects(run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/clean-package-staging.ps1'],
      { cwd: root, windowsHide: true }), /not a self-contained portable executable/);
    assert.equal(await readFile(join(root, 'dist/win-unpacked/icudtl.dat'), 'utf8'), 'runtime ICU');
  });
});

test('folder packaging publishes an immutable runtime and EXE launcher without touching the previous runtime', { skip: !windows }, async () => {
  await fixture(async (root) => {
    await mkdir(join(root, 'dist/win-unpacked/resources'), { recursive: true });
    await writeFile(join(root, 'dist/win-unpacked/Caps.exe'), 'old executable');
    await writeFile(join(root, 'dist/win-unpacked/resources/app.asar'), 'previous application');
    await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      function npx {
        $output = ($args | Where-Object { $_ -like '--config.directories.output=*' } | Select-Object -First 1).Substring('--config.directories.output='.Length)
        New-Item -ItemType Directory -Force -Path (Join-Path $output 'win-unpacked') | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $output 'win-unpacked/resources') | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $output 'win-unpacked/Caps.exe'), 'MZ current Electron')
        [System.IO.File]::WriteAllText((Join-Path $output 'win-unpacked/icudtl.dat'), 'required ICU data')
        [System.IO.File]::WriteAllText((Join-Path $output 'win-unpacked/resources/app.asar'), 'current application')
        $global:LASTEXITCODE = 0
      }
      function node { $global:LASTEXITCODE = 0 }
      $held = [System.IO.File]::Open((Join-Path (Get-Location) 'dist/win-unpacked/resources/app.asar'), 'Open', 'Read', 'Read')
      try { & './scripts/package-win.ps1' -Folder } finally { $held.Dispose() }
    `], { cwd: root, windowsHide: true });
    assert.equal(await readFile(join(root, 'dist/win-unpacked/Caps.exe'), 'utf8'), 'old executable');
    assert.equal(await readFile(join(root, 'dist/win-unpacked/resources/app.asar'), 'utf8'), 'previous application');
    const builds = (await readdir(join(root, 'dist'))).filter((name) => /^app-[a-f0-9]{24}$/.test(name));
    assert.equal(builds.length, 1);
    assert.equal(await readFile(join(root, 'dist', builds[0], 'Caps.exe'), 'utf8'), 'MZ current Electron');
    assert.equal(await readFile(join(root, 'dist', builds[0], 'icudtl.dat'), 'utf8'), 'required ICU data');
    const launcher = await readFile(join(root, 'Caps.exe'));
    assert.equal(launcher.subarray(0, 2).toString('ascii'), 'MZ');
    assert.notEqual(launcher.toString('utf8'), 'MZ current Electron');
    assert.deepEqual((await readdir(join(root, 'dist'))).sort(), [builds[0], 'win-unpacked']);
  });
});

test('cleanup cannot target the published folder even when a caller supplies its path', { skip: !windows }, async () => {
  await fixture(async (root) => {
    await mkdir(join(root, 'dist/win-unpacked'), { recursive: true });
    await writeFile(join(root, 'dist/win-unpacked/icudtl.dat'), 'required ICU data');
    await assert.rejects(run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      function node { $global:LASTEXITCODE = 0 }
      & './scripts/clean-package-staging.ps1' -KeepUnpacked -StagingRoot (Join-Path (Get-Location) 'dist/win-unpacked')
    `], { cwd: root, windowsHide: true }), /live or unknown build folder/);
    assert.equal(await readFile(join(root, 'dist/win-unpacked/icudtl.dat'), 'utf8'), 'required ICU data');
  });
});

test('packaging propagates builder failure and does not create a root executable', { skip: !windows }, async () => {
  await fixture(async (root) => {
    await assert.rejects(run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      function npx { $global:LASTEXITCODE = 7 }
      & './scripts/package-win.ps1'
      exit $LASTEXITCODE
    `], { cwd: root, windowsHide: true }), { code: 7 });
    assert.deepEqual((await readdir(root)).sort(), ['build', 'package.json', 'scripts']);
  });
});
