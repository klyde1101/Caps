import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runWhisperxProcess } from '../src/whisperx-runner.js';

const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));

test('bootstrap registers FFmpeg before imports, keeps its handle alive, and preserves Unicode arguments', { skip: !existsSync(python) }, async () => {
  const source = await readFile(new URL('../src/whisperx-bootstrap.py', import.meta.url), 'utf8');
  const harness = `
import os, sys, runpy, types, weakref, json
class Handle: pass
handles = []
events = []
def add_directory(path):
    events.append(path)
    handle = Handle()
    handles.append(weakref.ref(handle))
    return handle
os.add_dll_directory = add_directory
os.environ['CAPS_FFMPEG_DIRECTORY'] = 'C:/Caps Folder/ffmpeg'
torch = types.SimpleNamespace(backends=types.SimpleNamespace(
    cuda=types.SimpleNamespace(matmul=types.SimpleNamespace(allow_tf32=True)),
    cudnn=types.SimpleNamespace(allow_tf32=True)))
sys.modules['torch'] = torch
def run_module(name, run_name):
    assert events == ['C:/Caps Folder/ffmpeg']
    assert handles[0]() is not None
    assert torch.backends.cuda.matmul.allow_tf32 is False
    assert torch.backends.cudnn.allow_tf32 is False
    assert name == 'whisperx' and run_name == '__main__'
    print(json.dumps(sys.argv))
runpy.run_module = run_module
exec(${JSON.stringify(source)}, {'__name__': '__main__'})
`;
  const { stdout } = await promisify(execFile)(python, ['-c', harness, 'C:/Media Folder/日本語.mp4', '--device', 'cpu'], { windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), ['whisperx', 'C:/Media Folder/日本語.mp4', '--device', 'cpu']);
});

test('standalone WhisperX executables keep their own entry point', async () => {
  await runWhisperxProcess('whisperx.exe', ['clip.mp4'], {
    spawnProcess(command, args) {
      assert.equal(command, 'whisperx.exe');
      assert.deepEqual(args, ['clip.mp4']);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }
  });
});

test('CUDA batching reserves memory and keeps all stages on the selected GPU; CPU keeps its batch', { skip: !existsSync(python) }, async () => {
  const source = await readFile(new URL('../src/whisperx-bootstrap.py', import.meta.url), 'utf8');
  const harness = `
import os, sys, types
namespace = {'__name__': 'test_bootstrap'}
exec(${JSON.stringify(source)}, namespace)
os.environ['CAPS_AUTO_BATCH_SIZE'] = '1'
selected = []
for free_gib, expected in [(3, 1), (7, 1), (9.9, 1), (10, 2), (13.9, 2), (14, 4), (40, 4)]:
    sys.argv = ['launcher', 'clip.mp4', '--device', 'cuda', '--device_index', '1', '--batch_size', '4']
    def memory(index):
        assert index == 1
        return (free_gib * 1024**3, 48 * 1024**3)
    torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True, set_device=selected.append, mem_get_info=memory))
    namespace['configure_batch_size'](torch)
    assert sys.argv[-1] == str(expected)
    assert selected[-1] == 1
sys.argv = ['launcher', 'clip.mp4', '--device', 'cpu', '--batch_size', '4']
before = sys.argv.copy()
namespace['configure_batch_size'](torch)
assert sys.argv == before
os.environ['CAPS_AUTO_BATCH_SIZE'] = '0'
sys.argv = ['launcher', 'clip.mp4', '--device', 'cuda', '--batch_size', '4']
before = sys.argv.copy()
namespace['configure_batch_size'](torch)
assert sys.argv == before
`;
  await promisify(execFile)(python, ['-c', harness], { windowsHide: true });
});
