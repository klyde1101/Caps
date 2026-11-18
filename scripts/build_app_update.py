"""Build a small app-only update for the existing Caps folder installation."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def build_update(runtime=None):
    version = json.loads((ROOT / 'package.json').read_text())['version']
    if runtime is None:
        runtime = subprocess.run(['node', '--input-type=module', '-e',
            "import {launcherRuntime} from './scripts/clean-project.mjs'; console.log(await launcherRuntime('Caps.exe',process.cwd()))"],
            cwd=ROOT, check=True, text=True, capture_output=True).stdout.strip()
    runtime = Path(runtime).resolve()
    subprocess.run(['node', 'scripts/verify-windows-package.mjs', str(runtime), 'node_modules/electron/dist', '-', str(ROOT)], cwd=ROOT, check=True)
    release = ROOT / 'dist/release'
    release.mkdir(parents=True, exist_ok=True)
    archive = release / f'Caps-{version}-Update-x64.zip'
    staged = archive.with_suffix('.tmp')
    with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        output.write(ROOT / 'Caps.exe', 'Caps.exe')
        for file in sorted(runtime.rglob('*')):
            if file.is_file():
                output.write(file, file.relative_to(ROOT).as_posix())
    os.replace(staged, archive)
    with archive.open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = release / f'Caps-{version}-Update.json'
    manifest.write_text(json.dumps({'schema': 1, 'version': version, 'runtimeRevision': 1,
        'runtimeDirectory': runtime.relative_to(ROOT).as_posix(), 'archive': archive.name,
        'size': archive.stat().st_size, 'sha256': checksum}, indent=2) + '\n')
    return [archive, manifest]


if __name__ == '__main__':
    print('Built:', ', '.join(path.name for path in build_update()))
