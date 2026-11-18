import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));
const builder = fileURLToPath(new URL('../scripts/build-release.py', import.meta.url));

test('installer rebuilding reads ZIP records and file contents across volume boundaries', { skip: !existsSync(python) }, async () => {
  const code = String.raw`import importlib.util, io, pathlib, sys, tempfile, zipfile
spec = importlib.util.spec_from_file_location('builder', sys.argv[1])
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
buffer = io.BytesIO()
expected = {'Caps.exe': bytes(range(256)) * 4, 'dist/app/resources/app.asar': b'current app contents'}
with zipfile.ZipFile(buffer, 'w') as archive:
 for name, data in expected.items():
  archive.writestr(name, data)
data = buffer.getvalue()
with tempfile.TemporaryDirectory() as directory:
 paths = []
 for offset in range(0, len(data), 79):
  path = pathlib.Path(directory) / str(len(paths) + 1)
  path.write_bytes(data[offset:offset + 79])
  paths.append(path)
 with builder.SplitArchive(paths) as source:
  source.seek(75)
  assert source.read(100) == data[75:175]
  source.seek(-10, 2)
  assert source.read() == data[-10:]
  source.seek(0)
  with zipfile.ZipFile(source) as archive:
   assert archive.testzip() is None
   assert {name: archive.read(name) for name in archive.namelist()} == expected
 assert all(stream.closed for stream in source.streams)
print('runtime-volumes-ok')
`;
  const result = await promisify(execFile)(python, ['-B', '-c', code, builder], { windowsHide: true, timeout: 10000 });
  assert.match(result.stdout, /runtime-volumes-ok/);
});
