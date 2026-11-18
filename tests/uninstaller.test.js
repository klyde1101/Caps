import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const csc = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');

test('native removal preserves personal files, rejects traversal and junctions, and can retry locked files', { skip: process.platform !== 'win32' }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'caps-remove-'));
  try {
    const harness = join(work, 'harness.cs');
    await writeFile(harness, `using System;using System.IO;
internal static class InstallerIdentity {internal const string Version="test",Publisher="test",Url="https://example.test";}
class RemovalTest {
 static int Main(string[] args) {
  try {
   if(args.Length>1 && args[1]=="register") {
    Setup.MergeInstalledFiles(args[0],new[]{"Caps.exe",args[2],"dist",Path.GetDirectoryName(args[2])});
   } else if(args.Length>1 && args[1]=="locked") {
    using(var file=File.Open(Path.Combine(args[0],"Caps.exe"),FileMode.Open,FileAccess.Read,FileShare.Read))
     CapsRemoval.RemoveFiles(args[0],(c,t)=>{});
   } else CapsRemoval.RemoveFiles(args[0],(c,t)=>{});
   return 0;
  } catch(Exception e) {Console.Error.WriteLine(e.Message);return 1;}
 }
}`);
    const exe = join(work, 'test.exe');
    const payload = join(work, 'payload.json'); await writeFile(payload, '{}');
    await run(csc, ['/nologo', '/target:exe', '/main:RemovalTest', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
      '/reference:System.Web.Extensions.dll', '/reference:Microsoft.CSharp.dll', '/resource:' + payload + ',payload.json', '/out:' + exe,
      harness, join(project, 'scripts/release-installer.cs'), join(project, 'scripts/release-skin.cs'), join(project, 'scripts/release-uninstaller.cs')], { windowsHide: true });
    const root = join(work, 'install');
    await mkdir(join(root, 'dist/app'), { recursive: true });
    await mkdir(join(root, 'models'));
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'Caps.exe'), 'launcher');
    await writeFile(join(root, 'dist/app/runtime.dll'), 'runtime');
    await writeFile(join(root, 'models/keep.bin'), 'model');
    await writeFile(join(root, 'data/settings.json'), 'settings');
    await writeFile(join(root, 'captions.srt'), 'captions');
    const manifest = join(root, 'installed-files.txt');
    const owned = 'Caps.exe\ndist\\app\\runtime.dll\ndist\\app\ndist\nmodels\\keep.bin\ndata\\settings.json';
    await writeFile(manifest, owned + '\n..\\outside.txt');
    await writeFile(join(work, 'outside.txt'), 'outside');
    await assert.rejects(run(exe, [root, 'register', 'dist\\new\\runtime.dll'], { windowsHide: true }), { code: 1 });
    assert.equal(await readFile(manifest, 'utf8'), owned + '\n..\\outside.txt', 'invalid old paths do not replace the manifest');
    await assert.rejects(run(exe, [root], { windowsHide: true }), { code: 1 });
    assert.ok(existsSync(join(root, 'Caps.exe')), 'validate every path before deleting');
    const linked = join(root, 'linked');
    const external = join(work, 'external');
    await mkdir(external);
    await writeFile(join(external, 'keep.txt'), 'outside link');
    await symlink(external, linked, 'junction');
    await writeFile(manifest, owned + '\nlinked\\keep.txt');
    await assert.rejects(run(exe, [root, 'register', 'dist\\new\\runtime.dll'], { windowsHide: true }), { code: 1 });
    await assert.rejects(run(exe, [root], { windowsHide: true }), { code: 1 });
    assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'outside link');
    await writeFile(manifest, owned);
    await assert.rejects(run(exe, [root, 'locked'], { windowsHide: true }), { code: 1 });
    assert.ok(existsSync(join(root, 'dist/app/runtime.dll')), 'locked file preflight precedes all deletion');
    for (const generation of ['update', 'reinstall']) {
      await mkdir(join(root, 'dist', generation));
      await writeFile(join(root, 'dist', generation, 'runtime.dll'), generation);
      await run(exe, [root, 'register', `dist\\${generation}\\runtime.dll`], { windowsHide: true });
    }
    const merged = await readFile(manifest, 'utf8');
    for (const generation of ['app', 'update', 'reinstall']) assert.ok(merged.includes(`dist\\${generation}\\runtime.dll`));
    assert.ok(!merged.includes('models\\keep.bin') && !merged.includes('data\\settings.json'));
    await run(exe, [root], { windowsHide: true });
    assert.equal(existsSync(join(root, 'Caps.exe')), false);
    assert.equal(existsSync(join(root, 'dist')), false);
    for (const [file, content] of [['models/keep.bin', 'model'], ['data/settings.json', 'settings'], ['captions.srt', 'captions']])
      assert.equal(await readFile(join(root, file), 'utf8'), content);
    assert.ok(existsSync(manifest), 'keep manifest until registration cleanup succeeds');
  } finally { await rm(work, { recursive: true, force: true }); }
});
