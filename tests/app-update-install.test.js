import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));
const available = process.platform === 'win32' && existsSync(python);
const runtime = 'dist/app-' + 'a'.repeat(24);

async function fixture(mode, action) {
  const root = await mkdtemp(join(tmpdir(), 'caps update install '));
  try {
    const updates = join(root, 'data/updates');
    await mkdir(updates, { recursive: true });
    await mkdir(join(root, 'dist/old-runtime'), { recursive: true });
    await mkdir(join(root, 'models'), { recursive: true });
    await writeFile(join(root, 'Caps.exe'), 'old launcher');
    await writeFile(join(root, 'installed-files.txt'), 'Caps.exe\ndist\\old-runtime\\Caps.exe\ndist\\old-runtime\ndist\n');
    await writeFile(join(root, 'dist/old-runtime/Caps.exe'), 'old runtime');
    await writeFile(join(root, 'models/keep.bin'), 'keep my model');
    await writeFile(join(root, 'data/settings.json'), '{"model":"small"}');
    const archive = join(updates, 'Caps-1.0.1-Update-x64.zip');
    await run(python, ['-B', '-c', String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as output:
 for name in ['Caps.exe',sys.argv[2]+'/Caps.exe',sys.argv[2]+'/icudtl.dat',sys.argv[2]+'/resources/app.asar',sys.argv[2]+'/locales/en-US.pak']:
  output.writestr(name,b'new runtime contents' if name!='Caps.exe' else b'new launcher')
 if sys.argv[3]=='traversal': output.writestr(sys.argv[2]+'/../../../escape.txt',b'must never escape')
 if sys.argv[3]=='other-root': output.writestr('models/overwrite.bin',b'must never touch models')
`, archive, runtime, mode], { windowsHide: true });
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    const record = join(updates, 'pending.json');
    const info = { schema: 1, runtimeRevision: 1, version: '1.0.1', root, archive,
      size: (await readFile(archive)).length, sha256: mode === 'corrupt' ? '0'.repeat(64) : digest,
      runtimeDirectory: runtime, parentPid: 2147483647 };
    await writeFile(record, JSON.stringify(info));
    const helper = join(updates, 'apply-update.ps1');
    await copyFile(new URL('../src/desktop/apply-update.ps1', import.meta.url), helper);
    const execute = async (path = record) => {
      try { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Record', path], { windowsHide: true, timeout: 15000 }); return 0; }
      catch (error) { return error.code; }
    };
    if (mode === 'damaged-status') await writeFile(join(updates, 'result.json'), '{incomplete');
    const code = mode === 'concurrent' ? undefined : await execute();
    await action(root, code, { execute, record, info });
    assert.equal(await readFile(join(root, 'models/keep.bin'), 'utf8'), 'keep my model');
    assert.equal(await readFile(join(root, 'data/settings.json'), 'utf8'), '{"model":"small"}');
    assert.equal(await readFile(join(root, 'dist/old-runtime/Caps.exe'), 'utf8'), 'old runtime');
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('update helper switches the launcher after staging and retains the previous build and user files', { skip: !available }, async () => {
  await fixture('valid', async (root, code) => {
    assert.equal(code, 0, await readFile(join(root, 'data/updates/result.json'), 'utf8').catch(() => 'No helper result'));
    assert.equal(await readFile(join(root, 'Caps.exe'), 'utf8'), 'new launcher');
    assert.equal(await readFile(join(root, runtime, 'resources/app.asar'), 'utf8'), 'new runtime contents');
    assert.equal(await readFile(join(root, 'data/updates/previous-launcher.exe'), 'utf8'), 'old launcher');
    const owned = await readFile(join(root, 'installed-files.txt'), 'utf8');
    assert.ok(owned.includes(runtime.replaceAll('/', '\\') + '\\resources\\app.asar'));
    assert.ok(owned.includes('dist\\old-runtime\\Caps.exe'));
    const result = JSON.parse((await readFile(join(root, 'data/updates/result.json'), 'utf8')).replace(/^\uFEFF/, ''));
    assert.equal(result.state, 'installed');
  });
});

test('completed and concurrent helpers are idempotent and preserve the previous launcher', { skip: !available }, async () => {
  await fixture('concurrent', async (root, _code, { execute, record, info }) => {
    assert.deepEqual(await Promise.all([execute(), execute()]), [0, 0]);
    const result = join(root, 'data/updates/result.json');
    const firstResult = await readFile(result, 'utf8');
    assert.equal(JSON.parse(firstResult).state, 'installed');
    assert.equal(await execute(), 0, 'a duplicate whose record was consumed is successful');
    assert.equal(await readFile(result, 'utf8'), firstResult);
    const attemptId = randomUUID(), second = join(root, `data/updates/pending-${attemptId}.json`);
    await writeFile(second, JSON.stringify({ ...info, attemptId }));
    assert.equal(await execute(second), 0, 'another queued attempt for the installed archive is a no-op');
    assert.equal(await execute(second), 0);
    assert.equal(await readFile(result, 'utf8'), firstResult, 'do not replace a success with a false failure');
    assert.equal(await readFile(join(root, 'data/updates/previous-launcher.exe'), 'utf8'), 'old launcher');
    assert.equal(existsSync(record), false); assert.equal(existsSync(second), false);
  });
});

test('a damaged old status file does not block a fresh update', { skip: !available }, async () => {
  await fixture('damaged-status', async (root, code) => {
    assert.equal(code, 0);
    assert.equal(JSON.parse(await readFile(join(root, 'data/updates/result.json'))).state, 'installed');
  });
});

test('update helper rejects corruption, traversal and writes outside the runtime before replacing Caps', { skip: !available }, async () => {
  for (const mode of ['corrupt', 'traversal', 'other-root']) await fixture(mode, async (root, code) => {
    assert.equal(code, 1, mode);
    assert.equal(await readFile(join(root, 'Caps.exe'), 'utf8'), 'old launcher');
    assert.equal(existsSync(join(root, 'escape.txt')), false);
    assert.equal(existsSync(join(root, 'models/overwrite.bin')), false);
    assert.equal(existsSync(join(root, runtime)), false);
  });
});
