import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('runtime trimming removes compiler inputs while retaining runtime and legal files',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'caps-trim-'));
    const run = promisify(execFile);
    try {
      await mkdir(join(root, 'scripts'));
      const script = join(root, 'scripts/trim-runtime-development.ps1');
      await copyFile(new URL('../scripts/trim-runtime-development.ps1', import.meta.url), script);
      const python = join(root, 'whisperx/cpu/python');
      const libs = join(python, 'Lib/site-packages/torch/lib');
      await mkdir(libs, { recursive: true });
      for (const file of ['dnnl.lib', 'torch_cpu.dll', 'torch.pyd']) await writeFile(join(libs, file), 'fixture');
      await writeFile(join(python, 'keep.lib'), 'outside allowlist');
      const headers = join(python, 'Lib/site-packages/torch/include/deep');
      await mkdir(headers, { recursive: true });
      for (const file of ['tensor.h', 'kernel.cuh', 'LICENSE.h', 'NOTICE.txt', 'runtime.py', 'runtime.dll']) await writeFile(join(headers, file), 'keep unless compiler input');
      await mkdir(join(python, 'Include')); await writeFile(join(python, 'Include/Python.h'), 'C API');
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
      await run('powershell', args, { windowsHide: true });
      assert.equal(await readFile(join(libs, 'dnnl.lib'), 'utf8'), 'fixture');
      await run('powershell', [...args, '-Apply'], { windowsHide: true });
      await assert.rejects(readFile(join(libs, 'dnnl.lib')), { code: 'ENOENT' });
      assert.equal(await readFile(join(libs, 'torch_cpu.dll'), 'utf8'), 'fixture');
      assert.equal(await readFile(join(libs, 'torch.pyd'), 'utf8'), 'fixture');
      assert.equal(await readFile(join(python, 'keep.lib'), 'utf8'), 'outside allowlist');
      for (const file of ['tensor.h','kernel.cuh']) await assert.rejects(readFile(join(headers, file)), { code: 'ENOENT' });
      await assert.rejects(readFile(join(python, 'Include/Python.h')), { code: 'ENOENT' });
      for (const file of ['LICENSE.h','NOTICE.txt','runtime.py','runtime.dll']) assert.equal(await readFile(join(headers, file), 'utf8'), 'keep unless compiler input');
      const protectedHeaders = join(root, 'protected-headers'); await mkdir(protectedHeaders);
      await writeFile(join(protectedHeaders, 'outside.h'), 'must survive');
      await writeFile(join(headers, 'fresh.h'), 'preflight must be atomic');
      await symlink(protectedHeaders, join(headers, 'linked'), 'junction');
      await assert.rejects(run('powershell', [...args, '-Apply'], { windowsHide: true }), /linked header/);
      assert.equal(await readFile(join(protectedHeaders, 'outside.h'), 'utf8'), 'must survive');
      assert.equal(await readFile(join(headers, 'fresh.h'), 'utf8'), 'preflight must be atomic');
      await assert.rejects(run('powershell', [...args, '-PythonRoot', tmpdir(), '-Apply'], { windowsHide: true }), /within this checkout/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
