import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { REQUIRED_RUNTIME_FILES } from '../scripts/verify-windows-package.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';

test('the EXE launcher preserves the runtime root and literal arguments without a shell or batch file', { skip: !windows }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-exe-launcher-'));
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'build'));
    await copyFile(new URL('../build/caps-icon.ico', import.meta.url), join(root, 'build/caps-icon.ico'));
    for (const name of ['build-windows-launcher.ps1', 'windows-launcher.cs'])
      await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
    const relativeRuntime = 'dist/app-0123456789abcdef01234567';
    await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-windows-launcher.ps1', '-OutputPath', join(root, 'Caps.exe'), '-RuntimeDirectory', relativeRuntime],
      { cwd: root, windowsHide: true });
    const folder = join(root, relativeRuntime);
    for (const name of [...REQUIRED_RUNTIME_FILES, 'resources/app.asar']) {
      await mkdir(join(folder, name, '..'), { recursive: true });
      await writeFile(join(folder, name), 'test runtime data');
    }
    // A real 64-bit child verifies Windows argument parsing and the launched environment.
    const childSource = `using System; using System.IO; using System.Text;
      class Probe { static int Main(string[] args) {
        var lines = new string[args.Length + 3];
        lines[0] = Directory.GetCurrentDirectory();
        lines[1] = Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_DIR");
        lines[2] = Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") ?? "unset";
        for(int i=0; i<args.Length; i++) lines[i+3] = Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i]));
        File.WriteAllLines(Path.Combine(Directory.GetCurrentDirectory(), "probe.txt"), lines); return 0;
      } }`;
    await writeFile(join(root, 'probe.cs'), childSource);
    const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', `/out:${join(folder, 'Caps.exe')}`, join(root, 'probe.cs')],
      { cwd: root, windowsHide: true });
    const args = ['file with spaces.mp4', 'a"quoted"name', 'trailing slash\\', '', '& literal %PATH%'];
    await run(join(root, 'Caps.exe'), args, { cwd: tmpdir(), windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORTABLE_EXECUTABLE_DIR: 'wrong root' }, timeout: 15000 });
    const [cwd, runtimeRoot, nodeMode, ...encoded] = (await readFile(join(root, 'probe.txt'), 'utf8')).trimEnd().split(/\r?\n/);
    assert.equal(resolve(cwd), resolve(root)); assert.equal(resolve(runtimeRoot), resolve(root));
    assert.equal(nodeMode, 'unset');
    const received = encoded.map((value) => Buffer.from(value, 'base64').toString('utf8'));
    assert.equal(received[0], '--enable-logging');
    assert.equal(received[1], `--log-file=${join(root, 'data/launch.log')}`);
    assert.equal(received[2], '--crash-dumps-dir=' + join(root, 'data/crashes'));
    assert.deepEqual(received.slice(3), args);
    // The PE header declares Windows GUI (2), not a console executable (3).
    const exe = await readFile(join(root, 'Caps.exe'));
    const peOffset = exe.readUInt32LE(0x3c);
    assert.equal(exe.readUInt16LE(peOffset + 24 + 68), 2);
    assert.equal(exe.readUInt16LE(peOffset + 4), 0x8664);
  } finally { await rm(root, { recursive: true, force: true }); }
});
