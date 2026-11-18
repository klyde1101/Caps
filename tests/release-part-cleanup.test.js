import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const project = fileURLToPath(new URL('..', import.meta.url));
const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));
test('a smaller release removes stale extra volumes only for its own archive', { skip: !existsSync(python) }, async () => {
  const code = String.raw`
import importlib.util,pathlib,tempfile,sys,hashlib
spec=importlib.util.spec_from_file_location('builder',pathlib.Path(sys.argv[1])/'scripts/build-release.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as work:
 root=pathlib.Path(work);name='Caps-1.0.0-beta.1-Support-Runtime-x64.zip'
 for n in (name+'.001',name+'.002',name+'.003','Other.zip.003'):(root/n).write_text('fixture')
 removed=m.remove_obsolete_parts(root,name,{name+'.001',name+'.002'})
 assert removed==[name+'.003']
 assert (root/(name+'.001')).exists() and (root/(name+'.002')).exists() and (root/'Other.zip.003').exists()
 assert m.remove_obsolete_parts(root,name,{name+'.001',name+'.002'})==[]
 checksum=m.payload_digest([root/(name+'.001'),root/(name+'.002')])
 assert checksum==hashlib.sha256(b'fixturefixture').hexdigest()
 assert m.runtime_archive_name('Caps-1.0.0-beta.1',checksum)=='Caps-1.0.0-beta.1-Support-Runtime-'+checksum[:16]+'-x64.zip'
 print('part-cleanup-ok')
`;
  const result = await promisify(execFile)(python, ['-B', '-c', code, project], { windowsHide: true });
  assert.match(result.stdout, /part-cleanup-ok/);
});
