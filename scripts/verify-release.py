"""Reject release assets that are intact but no longer match the working sources."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import zipfile


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def source_hashes(root):
    paths = [root / name for name in ('package.json', 'package-lock.json', 'LICENSE')]
    for directory in ('src', 'scripts', 'build'):
        for base, folders, files in os.walk(root / directory):
            folders[:] = [name for name in folders if name != '__pycache__'
                and not (Path(base) == root / 'build' and name in ('uv-cache', 'uv-python', 'downloads'))]
            paths.extend(Path(base) / name for name in files if Path(name).suffix not in ('.pyc', '.tmp'))
    version = json.loads((root / 'package.json').read_text())['version']
    paths.append(root / f'docs/release-{version}.md')
    return {p.relative_to(root).as_posix(): digest(p) for p in sorted(paths)}


def write_provenance(root, runtime, assets):
    version = json.loads((root / 'package.json').read_text())['version']
    path = root / f'dist/release/Caps-{version}-Build.json'
    path.write_text(json.dumps({'schema': 1, 'version': version,
        'runtimeDirectory': Path(runtime).relative_to(root).as_posix(),
        'installerRuntimeFiles': [p.name for p in assets if p.name.startswith(f'Caps-{version}-Support-Runtime-')],
        'sources': source_hashes(root), 'assets': {p.name: digest(p) for p in assets}}, indent=2) + '\n')
    return path


def verify_provenance(root, proof, runtime):
    version = json.loads((root / 'package.json').read_text())['version']
    if (proof.get('schema') != 1 or proof.get('version') != version
            or proof.get('runtimeDirectory') != runtime.relative_to(root).as_posix()
            or proof.get('sources') != source_hashes(root)):
        raise ValueError('Release sources changed. Rebuild the release before publishing.')


def verify_archive(archive, expected):
    names = archive.namelist()
    if len(names) != len(set(n.lower() for n in names)):
        raise ValueError('Duplicate archive member.')
    app_names = {name for name in names if name == 'Caps.exe' or name.startswith('dist/')}
    if app_names != set(expected):
        raise ValueError('Release archive contains an older or incomplete application build.')
    for name, path in expected.items():
        with archive.open(name) as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != digest(path):
            raise ValueError(f'Release application file is stale: {name}')


def verify_release(root):
    # This also checks every packaged source file, not just the version number.
    code = """import {launcherRuntime} from './scripts/clean-project.mjs';
import {verifyWindowsPackage} from './scripts/verify-windows-package.mjs';
const root=process.cwd(), runtime=await launcherRuntime('Caps.exe',root);
await verifyWindowsPackage({unpackedRoot:runtime,electronRoot:root+'/node_modules/electron/dist',projectRoot:root});
console.log(runtime);"""
    runtime = Path(subprocess.run(['node', '--input-type=module', '-e', code], cwd=root,
        check=True, capture_output=True, text=True).stdout.strip()).resolve()
    version = json.loads((root / 'package.json').read_text())['version']
    release = root / 'dist/release'
    prefix = f'Caps-{version}'
    proof_path = release / f'{prefix}-Build.json'
    if not proof_path.is_file():
        raise ValueError('Missing release build provenance. Rebuild before publishing.')
    proof = json.loads(proof_path.read_text())
    verify_provenance(root, proof, runtime)
    listed = {}
    for line in (release / 'SHA256SUMS.txt').read_text().splitlines():
        checksum, name = line.split('  ', 1)
        if Path(name).name != name or name in listed:
            raise ValueError('Invalid checksum asset name.')
        listed[name] = checksum
    if proof_path.name not in listed or digest(proof_path) != listed.pop(proof_path.name):
        raise ValueError('Release provenance checksum differs.')
    if listed != proof['assets']:
        raise ValueError('Release assets do not match the build provenance.')
    for name, checksum in listed.items():
        if digest(release / name) != checksum:
            raise ValueError(f'Release asset changed: {name}')
    expected = {'Caps.exe': root / 'Caps.exe'}
    expected.update({p.relative_to(root).as_posix(): p for p in runtime.rglob('*') if p.is_file()})
    metadata = json.loads((release / f'{prefix}-Update.json').read_text())
    if metadata.get('runtimeDirectory') != runtime.relative_to(root).as_posix():
        raise ValueError('The update targets an older packaged build.')
    with zipfile.ZipFile(release / f'{prefix}-Update-x64.zip') as archive:
        if set(archive.namelist()) != set(expected):
            raise ValueError('Unexpected app-update archive contents.')
        verify_archive(archive, expected)
    # Inspect the full installer payload too; a fresh app-only ZIP is insufficient.
    spec = importlib.util.spec_from_file_location('release_builder', root / 'scripts/build-release.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    declared = proof.get('installerRuntimeFiles', [])
    if not declared or any(name not in listed or Path(name).name != name for name in declared):
        raise ValueError('Missing or invalid installer runtime asset list.')
    parts = [release / name for name in declared if re.search(r'\.[0-9]{3}$', name)]
    if parts:
        if len(parts) != len(declared) or any(p.name != parts[0].name[:-3] + f'{i:03}' for i, p in enumerate(parts, 1)):
            raise ValueError('Missing installer runtime part.')
        with builder.SplitArchive(parts) as stream, zipfile.ZipFile(stream) as archive:
            verify_archive(archive, expected)
    else:
        if len(declared) != 1:
            raise ValueError('Unexpected full runtime archive list.')
        with zipfile.ZipFile(release / declared[0]) as archive:
            verify_archive(archive, expected)
    print('Release sources, installer payload, update archive and checksums match.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        verify_release(args.project_root.resolve())
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Release verification failed: {error}\n')
