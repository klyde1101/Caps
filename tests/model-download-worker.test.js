import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));
const worker = fileURLToPath(new URL('../src/model-download-worker.py', import.meta.url));
const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('bundled Python worker uses anonymous snapshot_download and redacts its log streams', { skip: !existsSync(python) }, async () => {
  const code = `import sys, types
module = types.ModuleType('huggingface_hub')
def download(**kw):
 assert kw['token'] is False
 assert kw['revision'] == 'a' * 40
 assert kw['repo_id'] == 'Systran/faster-whisper-small'
 print('Authorization: Bearer verySecretToken')
 print('https://example.com/file?token=secretQuery')
 print('worker-ok')
module.snapshot_download = download
sys.modules['huggingface_hub'] = module
worker = sys.argv[1]
sys.argv = [worker, sys.argv[2], 'Systran/faster-whisper-small', 'a'*40, '.', '["model.bin"]']
exec(compile(open(worker, encoding='utf-8').read(), worker, 'exec'), {'__name__':'__main__'})`;
  const result = await run(python, ['-c', code, worker, String(process.pid)], { windowsHide: true, timeout: 5000 });
  assert.match(result.stdout, /worker-ok/);
  assert.doesNotMatch(result.stdout + result.stderr, /verySecretToken|secretQuery/);
});

test('worker exits when its parent is killed, leaving only resumable staged data', { skip: !existsSync(python), timeout: 7000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-worker-parent-'));
  const heartbeat = join(root, 'heartbeat');
  let parent; let workerPid;
  const code = `import sys, types, time, pathlib
module=types.ModuleType('huggingface_hub')
heartbeat=pathlib.Path(sys.argv[3])
def download(**kw):
 while True:
  heartbeat.write_text(str(time.time()))
  time.sleep(.03)
module.snapshot_download=download
sys.modules['huggingface_hub']=module
worker=sys.argv[1]
sys.argv=[worker,sys.argv[2],'Systran/faster-whisper-small','a'*40,'.','["model.bin"]']
exec(compile(open(worker,encoding='utf-8').read(),worker,'exec'),{'__name__':'__main__'})`;
  const helper = join(root, 'parent.cjs');
  await writeFile(helper, `const {spawn}=require('node:child_process'); const child=spawn(${JSON.stringify(python)}, ['-c', ${JSON.stringify(code)}, ${JSON.stringify(worker)}, String(process.pid), ${JSON.stringify(heartbeat)}], {windowsHide:true,stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`);
  try {
    parent = spawn(process.execPath, [helper], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const [data] = await once(parent.stdout, 'data'); workerPid = Number(data.toString().trim());
    for (let attempt = 0; !existsSync(heartbeat) && attempt < 50; attempt++) await delay(30);
    assert.equal(existsSync(heartbeat), true, 'Worker never started');
    parent.kill(); await once(parent, 'close');
    await delay(650);
    const first = await readFile(heartbeat, 'utf8'); await delay(250);
    assert.equal(await readFile(heartbeat, 'utf8'), first, 'Orphaned worker kept downloading');
  } finally {
    parent?.kill();
    if (workerPid) try { process.kill(workerPid); } catch { /* Already stopped by its parent monitor. */ }
    await rm(root, { recursive: true, force: true });
  }
});
