import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const run = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const python = join(project, 'whisperx/cpu/python/python.exe');
const seven = process.env.CAPS_7ZA_PATH || join(project, 'data/release-tools/7za.exe');
const available = process.platform === 'win32' && existsSync(python) && existsSync(seven);
const fixtureCode = String.raw`import importlib.util,pathlib,shutil,sys,zipfile
root=pathlib.Path(sys.argv[1])
source=root/'source';source.mkdir()
spec=importlib.util.spec_from_file_location('builder',sys.argv[2])
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
archive=source/'runtime.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_STORED) as output:
 output.writestr('Caps.exe',b'installer test fixture only')
 output.writestr('dist/app/resources/app.asar',b'caption fixture data'*90000)
with zipfile.ZipFile(archive) as output:
 names=[pathlib.PureWindowsPath(n) for n in output.namelist()]
mode=sys.argv[5]
if mode=='embedded':
 files=[archive]
else:
 data=archive.read_bytes();size=(len(data)+2)//3
 files=[]
 for offset in range(0,len(data),size):
  part=source/('runtime.zip.%03d'%(len(files)+1))
  part.write_bytes(data[offset:offset+size]);files.append(part)
builder.RELEASE=root/'installer';builder.RELEASE.mkdir()
builder.PREFIX='Caps-Test'
if mode=='corrupt':
 builder.digest=lambda p:'0'*64
if mode=='cancel':
 harness=root/'cancel.cs'
 harness.write_text('using System;using System.Threading;class CancelTest{static int Main(string[] args){using(var c=new CancellationTokenSource()){c.CancelAfter(2500);try{Setup.Install(args[1],false,c.Token,p=>{});return 9;}catch(OperationCanceledException){return 0;}}}}')
 original=builder.run
 def compile_cancel(*args,**kwargs):
  if '/target:winexe' in args: args=(*args,'/main:CancelTest',harness)
  return original(*args,**kwargs)
 builder.run=compile_cancel
builder.build_installer(pathlib.Path(sys.argv[3]),files,names,archive,mode=='embedded',sys.argv[4])
if mode=='mixed':
 shutil.copyfile(files[0],builder.RELEASE/files[0].name)
elif mode=='corrupt':
 for part in files: shutil.copyfile(part,builder.RELEASE/part.name)
`;

async function fixture(mode, action) {
  const root = await mkdtemp(join(tmpdir(), 'caps-installer-download-'));
  const requests = [];
  let ended = 0;
  const server = createServer(async (request, response) => {
    const name = basename(request.url);
    if (!/^runtime\.zip\.\d{3}$/.test(name)) { response.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(join(root, 'source', name));
      requests.push(name);
      response.writeHead(200, { 'Content-Length': bytes.length });
      let offset = 0;
      const interval = setInterval(() => {
        response.write(bytes.subarray(offset, offset + 32768));
        offset += 32768;
        if (offset >= bytes.length) { clearInterval(interval); response.end(); }
      }, mode === 'cancel' ? 1000 : 25);
      response.on('close', () => { ended++; clearInterval(interval); });
    } catch { response.writeHead(404).end(); }
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    await run(python, ['-B', '-c', fixtureCode, root, join(project, 'scripts/build-release.py'), seven, url, mode],
      { windowsHide: true, timeout: 20000 });
    await action({ root, requests, ended: () => ended, installer: join(root, 'installer/Caps-Test-Setup-x64.exe'), output: join(root, 'output') });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('Setup downloads missing volumes, verifies them, and reports real progress through extraction', { skip: !available }, async () => {
  await fixture('mixed', async ({ installer, output, requests }) => {
    await run(installer, ['--extract-to', output], { windowsHide: true, timeout: 20000 });
    assert.deepEqual(requests, ['runtime.zip.002', 'runtime.zip.003']);
    assert.equal(await readFile(join(output, 'Caps.exe'), 'utf8'), 'installer test fixture only');
    const events = (await readFile(output + '.setup-progress.log', 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    for (const stage of ['download', 'verify', 'extract']) {
      const samples = events.filter((event) => event.Stage === stage);
      assert.ok(samples.length >= 2, stage + ' must report real progress');
      assert.equal(samples.at(-1).Current, samples.at(-1).Total);
      assert.ok(samples.every((sample, index) => sample.Current >= 0 && sample.Current <= sample.Total &&
        (!index || sample.Current >= samples[index - 1].Current)));
    }
    assert.ok(events.some((event) => event.Stage === 'download' && event.Current > 0 && event.Current < event.Total));
  });
});

test('Setup rejects failed checksums before extracting files', { skip: !available }, async () => {
  await fixture('corrupt', async ({ installer, output, requests }) => {
    await assert.rejects(run(installer, ['--extract-to', output], { windowsHide: true, timeout: 20000 }), { code: 1 });
    assert.match(await readFile(output + '.setup-error.txt', 'utf8'), /Integrity check failed/);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
    assert.equal(requests.length, 0);
  });
});

test('Setup extracts a bundled archive from its signature-compatible payload footer', { skip: !available }, async () => {
  await fixture('embedded', async ({ installer, output, requests }) => {
    await run(installer, ['--extract-to', output], { windowsHide: true, timeout: 20000 });
    assert.equal(await readFile(join(output, 'Caps.exe'), 'utf8'), 'installer test fixture only');
    assert.equal(requests.length, 0);
  });
});

test('cancelling an active download stops its child process and closes the connection', { skip: !available }, async () => {
  await fixture('cancel', async ({ installer, output, requests, ended }) => {
    const started = Date.now();
    await run(installer, ['--extract-to', output], { windowsHide: true, timeout: 12000 });
    assert.ok(requests.length > 0, 'Cancellation must interrupt a real download');
    assert.ok(ended() > 0, 'The cancelled worker must release its download connection');
    assert.ok(Date.now() - started < 10000);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
  });
});
