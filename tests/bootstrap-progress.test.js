import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));

test('bootstrap attributes ASR and alignment passes to the correct files while reusing models', { skip: !existsSync(python) }, async () => {
  const source = await readFile(new URL('../src/whisperx-bootstrap.py', import.meta.url), 'utf8');
  const harness = `
import sys, types, io, json
namespace = {'__name__': 'test_bootstrap'}
exec(${JSON.stringify(source)}, namespace)
calls = []
def transcribe(*args, **kwargs):
    print('Progress: 50.00%...')
    return {'segments': []}
def align(*args, **kwargs):
    print('Progress: 40.00%...')
    return {}
def load_model(*args, **kwargs):
    calls.append('model')
    return types.SimpleNamespace(transcribe=transcribe)
task = types.ModuleType('whisperx.transcribe')
task.load_audio = lambda path: object()
task.load_model = load_model
task.align = align
task.get_writer = lambda *args: lambda *args, **kwargs: None
package = types.ModuleType('whisperx')
package.transcribe = task
sys.modules['whisperx'] = package
sys.modules['whisperx.transcribe'] = task
output = io.StringIO()
sys.stdout = output
namespace['install_file_progress']()
model = task.load_model()
for path in ['one.mp4', '日本語.wav']:
    model.transcribe(task.load_audio(path))
for path in ['one.mp4', '日本語.wav']:
    task.align([], None, None, path)
    task.get_writer()({}, path)
sys.stdout = sys.__stdout__
print(json.dumps({'output': output.getvalue(), 'models': len(calls)}))
`;
  const { stdout } = await promisify(execFile)(python, ['-c', harness], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.models, 1);
  const events = result.output.split('\n').filter((line) => line.startsWith('[CapsProgress] ')).map((line) => JSON.parse(line.slice(15)));
  assert.deepEqual(events.filter((event) => event.percent === 35).map((event) => event.fileIndex), [0, 1]);
  assert.deepEqual(events.filter((event) => event.percent === 80).map((event) => event.fileIndex), [0, 1]);
  assert.equal(events.at(-1).fileIndex, 1);
  assert.equal(events.at(-1).percent, 95);
});
