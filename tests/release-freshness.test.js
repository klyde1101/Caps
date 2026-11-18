import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));
const prelude = String.raw`
import importlib.util,pathlib,tempfile,zipfile,json,sys
spec=importlib.util.spec_from_file_location('verifier',pathlib.Path(sys.argv[1])/'scripts/verify-release.py')
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
`;

test('valid checksums and the same version cannot disguise stale application archives', { skip: !existsSync(python) }, async () => {
  const code = prelude + String.raw`
with tempfile.TemporaryDirectory() as work:
 root=pathlib.Path(work);launcher=root/'Caps.exe';launcher.write_bytes(b'current launcher')
 app=root/'app.asar';app.write_bytes(b'current app with latest UI')
 expected={'Caps.exe':launcher,'dist/app-current/resources/app.asar':app}
 archive=root/'payload.zip'
 for mode in ('stale-content','old-runtime','fresh'):
  with zipfile.ZipFile(archive,'w') as z:
   z.writestr('Caps.exe',launcher.read_bytes())
   z.writestr('dist/app-old/resources/app.asar' if mode=='old-runtime' else 'dist/app-current/resources/app.asar',b'old app' if mode=='stale-content' else app.read_bytes())
   z.writestr('whisperx/runtime.dll',b'unchanged speech runtime')
  checksum=v.digest(archive)
  with zipfile.ZipFile(archive) as z:
   assert z.testzip() is None and v.digest(archive)==checksum
   try:v.verify_archive(z,expected)
   except ValueError:assert mode!='fresh'
   else:assert mode=='fresh'
 print('archive-freshness-ok')
`;
  const result = await promisify(execFile)(python, ['-B', '-c', code, project], { windowsHide: true });
  assert.match(result.stdout, /archive-freshness-ok/);
});

test('build provenance rejects changed native scripts, sources, and added files', { skip: !existsSync(python) }, async () => {
  const code = prelude + String.raw`
with tempfile.TemporaryDirectory() as work:
 root=pathlib.Path(work)
 for name in ('src','scripts','build','docs','dist/release','dist/app-current'):(root/name).mkdir(parents=True,exist_ok=True)
 (root/'package.json').write_text('{"version":"1.0.0-beta.2"}')
 for name in ('package-lock.json','LICENSE','src/app.js','scripts/setup.cs','build/icon.png','docs/release-1.0.0-beta.2.md'):(root/name).write_text('original')
 asset=root/'dist/release/Setup.exe';asset.write_bytes(b'valid older installer')
 part=root/'dist/release/Caps-1.0.0-beta.2-Support-Runtime-0123456789abcdef-x64.zip.001';part.write_bytes(b'part')
 proof=json.loads(v.write_provenance(root,root/'dist/app-current',[asset,part]).read_text())
 assert proof['installerRuntimeFiles']==[part.name]
 v.verify_provenance(root,proof,root/'dist/app-current')
 assert v.digest(asset)==proof['assets']['Setup.exe']
 for name in ('src/app.js','scripts/setup.cs','src/new-file.js'):
  p=root/name;original=p.read_bytes() if p.exists() else None;p.write_text('changed')
  try:v.verify_provenance(root,proof,root/'dist/app-current')
  except ValueError:pass
  else:raise AssertionError('stale build accepted: '+name)
  if original is None:p.unlink()
  else:p.write_bytes(original)
 print('provenance-freshness-ok')
`;
  const result = await promisify(execFile)(python, ['-B', '-c', code, project], { windowsHide: true });
  assert.match(result.stdout, /provenance-freshness-ok/);
});
