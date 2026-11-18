"""Build Windows installer runtime data and a per-user installer."""
import argparse
from bisect import bisect_right
import hashlib
import io
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import stat
import subprocess
import tempfile
import zipfile
from fnmatch import fnmatch

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "dist/release"
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
PREFIX = f"Caps-{VERSION}"
EXCLUDES = ["__pycache__", "*.pyc", "*.onnx", "*.pt", "*.ckpt", "*.safetensors",
            "pytorch_model.bin*", "model.bin", "*.jit", "wav2vec*.pth"]
LEGACY_CODECS = {"whisperx/cpu/ffmpeg.exe", "whisperx/cuda/ffmpeg.exe"}


def remove_obsolete_parts(release, archive_name, active_names):
    release = release.resolve()
    removed = []
    for part in release.glob(archive_name + '.[0-9][0-9][0-9]'):
        if part.name in active_names:
            continue
        if part.is_symlink() or part.resolve().parent != release or not part.is_file():
            raise ValueError('Unsafe obsolete runtime part.')
        if getattr(part.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024):
            raise ValueError('Linked obsolete runtime part.')
        part.unlink()
        removed.append(part.name)
    return removed


class SplitArchive(io.RawIOBase):
    """Read a ZIP split into ordinary numbered byte volumes without joining it."""

    def __init__(self, paths):
        super().__init__()
        self.streams = []
        self.offsets = [0]
        self.position = 0
        try:
            for path in paths:
                self.streams.append(path.open("rb"))
                self.offsets.append(self.offsets[-1] + path.stat().st_size)
        except Exception:
            self.close()
            raise

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        bases = {0: 0, 1: self.position, 2: self.offsets[-1]}
        if whence not in bases or bases[whence] + offset < 0:
            raise ValueError("Invalid split archive seek")
        self.position = bases[whence] + offset
        return self.position

    def read(self, size=-1):
        remaining = max(0, self.offsets[-1] - self.position)
        if size >= 0:
            remaining = min(remaining, size)
        blocks = []
        while remaining:
            index = bisect_right(self.offsets, self.position) - 1
            stream = self.streams[index]
            stream.seek(self.position - self.offsets[index])
            block = stream.read(min(remaining, self.offsets[index + 1] - self.position))
            if not block:
                raise EOFError("Truncated runtime archive volume")
            blocks.append(block)
            self.position += len(block)
            remaining -= len(block)
        return b"".join(blocks)

    def close(self):
        for stream in self.streams:
            stream.close()
        super().close()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def payload_digest(parts):
    checksum = hashlib.sha256()
    for part in parts:
        with part.open('rb') as stream:
            while block := stream.read(4 * 1024**2):
                checksum.update(block)
    return checksum.hexdigest()


def runtime_archive_name(prefix, checksum):
    return f'{prefix}-Support-Runtime-{checksum[:16]}-x64.zip'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)


def build_installer(seven, files, names, archive=None, embedded=False, base_url=None):
    archive_size = sum(p.stat().st_size for p in files)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        manifest = work / "payload.json"
        manifest.write_text(json.dumps({"baseUrl": base_url or f"https://github.com/klyde1101/Caps/releases/download/v{VERSION}",
                            "embeddedSize": archive_size if embedded else 0,
                            "files": [{"name": p.name, "sha256": digest(p), "size": p.stat().st_size} for p in files]}))
        removal = work / "installed-files.txt"
        owned = set(names)
        for name in names:
            owned.update(parent for parent in name.parents if str(parent) != ".")
        removal.write_text("\n".join(str(p) for p in sorted(owned, key=lambda p: len(p.parts), reverse=True)), encoding="utf-8")
        installer = RELEASE / f"{PREFIX}-Setup-x64.exe"
        staged_installer = work / installer.name
        metadata = work / "version.cs"
        publisher = json.loads((ROOT / "build/publisher.json").read_text(encoding="utf-8-sig"))
        metadata.write_text("\n".join([
            f'[assembly:System.Reflection.AssemblyInformationalVersion({json.dumps(VERSION)})]',
            f'[assembly:System.Reflection.AssemblyFileVersion({json.dumps(VERSION.split("-")[0] + ".0")})]',
            f'[assembly:System.Reflection.AssemblyCompany({json.dumps(publisher["name"])})]',
            '[assembly:System.Reflection.AssemblyProduct("Caps")]',
            '[assembly:System.Reflection.AssemblyTitle("Caps Setup")]',
            '[assembly:System.Reflection.AssemblyDescription("Windows installer for Caps")]',
            'internal static class InstallerIdentity {',
            f' public const string Publisher = {json.dumps(publisher["name"])};',
            f' public const string Url = {json.dumps(publisher["url"])};',
            f' public const string Version = {json.dumps(VERSION)};',
            '}',
        ]), encoding="utf-8")
        csc = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
        uninstaller = work / "Uninstall-Caps.exe"
        uninstall_metadata = work / "uninstall-version.cs"
        uninstall_metadata.write_text(metadata.read_text(encoding="utf-8").replace(
            'AssemblyTitle("Caps Setup")', 'AssemblyTitle("Uninstall Caps")').replace(
            'AssemblyDescription("Windows installer for Caps")', 'AssemblyDescription("Windows uninstaller for Caps")'), encoding="utf-8")
        run(csc, "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
            "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
            f"/win32icon:{ROOT / 'build/caps-icon.ico'}", f"/out:{uninstaller}",
            f"/resource:{ROOT / 'build/caps-icon.png'},caps-icon.png",
            f"/resource:{ROOT / 'build/github-mark.png'},github-mark.png",
            f"/resource:{ROOT / 'build/github-mark-LICENSE.txt'},github-mark-LICENSE.txt",
            uninstall_metadata, ROOT / "scripts/release-skin.cs", ROOT / "scripts/release-uninstaller.cs")
        run(csc, "/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/reference:System.Windows.Forms.dll",
            "/reference:Microsoft.CSharp.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
            f"/win32icon:{ROOT / 'build/caps-icon.ico'}", f"/out:{staged_installer}",
            f"/resource:{ROOT / 'build/caps-icon.png'},caps-icon.png",
            f"/resource:{ROOT / 'build/github-mark.png'},github-mark.png",
            f"/resource:{ROOT / 'build/github-mark-LICENSE.txt'},github-mark-LICENSE.txt",
            f"/resource:{seven},7za.exe", f"/resource:{manifest},payload.json",
            f"/resource:{removal},installed-files.txt", f"/resource:{ROOT / 'scripts/install-release-payload.ps1'},install-release-payload.ps1",
            f"/resource:{uninstaller},uninstall.exe", metadata, ROOT / "scripts/release-skin.cs", ROOT / "scripts/release-installer.cs")
        with staged_installer.open("ab") as output:
            if embedded:
                with archive.open("rb") as source:
                    shutil.copyfileobj(source, output, 4 * 1024**2)
            output.write(b"CAPS_PAYLOAD_V1!")
            output.write((archive_size if embedded else 0).to_bytes(8, "little"))
        os.replace(staged_installer, installer)
    return installer


def main():
    from build_app_update import build_update
    from verify_release import write_provenance
    parser = argparse.ArgumentParser()
    parser.add_argument("--seven", required=True)
    parser.add_argument("--makensis", help=argparse.SUPPRESS)
    prepared = parser.add_mutually_exclusive_group()
    prepared.add_argument("--prepared-zip", action="store_true",
                          help="Use the completed installer runtime ZIP")
    prepared.add_argument("--prepared-parts", action="store_true",
                          help="Rebuild Setup from completed numbered runtime ZIP parts")
    args = parser.parse_args()
    seven = Path(args.seven).resolve()
    RELEASE.mkdir(parents=True, exist_ok=True)
    # GitHub sorts assets by filename; keep support data after the Setup download.
    archive = RELEASE / f"{PREFIX}-Support-Runtime-x64.zip"
    runtime = run("node", "--input-type=module", "-e",
                  "import {launcherRuntime} from './scripts/clean-project.mjs'; console.log(await launcherRuntime('Caps.exe',process.cwd()))",
                  capture_output=True, text=True).stdout.strip()
    run("node", "scripts/verify-windows-package.mjs", runtime, "node_modules/electron/dist", "-", str(ROOT))
    if not args.prepared_zip and not args.prepared_parts:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as payload:
            payload.write(ROOT / "Caps.exe", "Caps.exe")
            for base in (Path(runtime), ROOT / "whisperx"):
                for directory, folders, filenames in os.walk(base):
                    folders[:] = [d for d in folders if d != "__pycache__"]
                    for name in filenames:
                        if not any(fnmatch(name, pattern) for pattern in EXCLUDES):
                            path = Path(directory) / name
                            relative = path.relative_to(ROOT)
                            if relative.as_posix() not in LEGACY_CODECS:
                                payload.write(path, relative)
    parts = []
    if args.prepared_parts:
        proof_path = RELEASE / f'{PREFIX}-Build.json'
        declared = json.loads(proof_path.read_text()).get('installerRuntimeFiles', []) if proof_path.exists() else []
        if declared:
            if any(Path(name).name != name or not name.startswith(PREFIX + '-Support-Runtime-') for name in declared):
                raise ValueError('Invalid prepared runtime asset names')
            parts = [RELEASE / name for name in declared]
        else:
            parts = sorted(RELEASE.glob(archive.name + ".[0-9][0-9][0-9]"))
    if args.prepared_parts and (not parts or any(
            p.name != parts[0].name[:-3] + f"{index:03}" or not parts[0].name.endswith('.001') or p.stat().st_size == 0
            for index, p in enumerate(parts, 1))):
        raise ValueError("Missing or non-contiguous installer runtime ZIP parts")
    with (SplitArchive(parts) if args.prepared_parts else archive.open("rb")) as source, zipfile.ZipFile(source) as payload:
        names = [PureWindowsPath(name) for name in payload.namelist()]
        for required in ("Caps.exe", Path(runtime).relative_to(ROOT).as_posix()+"/resources/app.asar",
                         "whisperx/cpu/python/python.exe", "whisperx/cuda/python/python.exe", "whisperx/ffmpeg/ffmpeg.exe"):
            payload.getinfo(required)
        if payload.testzip() is not None:
            raise ValueError("Installer runtime ZIP integrity check failed.")
    if not names or any(p.parts[0] not in ("Caps.exe", "dist", "whisperx") or
                        p.as_posix() in LEGACY_CODECS or
                        any(p.match(pattern) for pattern in EXCLUDES) or p.is_absolute() or ".." in p.parts
                        for p in names):
        raise ValueError("Unexpected release archive contents")
    # Published installers embed these names. Content-addressed runtime assets
    # let a same-version release update keep old installers' downloads intact.
    named_archive = RELEASE / runtime_archive_name(PREFIX, payload_digest(parts) if parts else digest(archive))
    if parts:
        named_parts = []
        for index, part in enumerate(parts, 1):
            destination = RELEASE / f'{named_archive.name}.{index:03}'
            if part != destination:
                if destination.exists():
                    if digest(destination) != digest(part):
                        raise ValueError('A content-addressed runtime asset already differs')
                    part.unlink()
                else:
                    part.rename(destination)
            named_parts.append(destination)
        parts = named_parts
    elif archive != named_archive:
        if named_archive.exists() and digest(named_archive) != digest(archive):
            raise ValueError('A content-addressed runtime archive already differs')
        os.replace(archive, named_archive)
    archive = named_archive
    # Leave headroom for the installer wrapper and GitHub's per-asset size limit.
    limit = 1900 * 1024**2
    archive_size = sum(p.stat().st_size for p in parts) if args.prepared_parts else archive.stat().st_size
    embedded = not args.prepared_parts and archive_size < limit
    files = parts if args.prepared_parts else [archive]
    split = not args.prepared_parts and archive_size >= 2 * 1024**3
    if split:
        files = []
        with archive.open("rb") as source:
            while source.tell() < archive.stat().st_size:
                part = archive.with_suffix(archive.suffix + f".{len(files)+1:03}")
                with part.open("wb") as output:
                    remaining = limit
                    while remaining and (block := source.read(min(remaining, 4 * 1024**2))):
                        output.write(block)
                        remaining -= len(block)
                files.append(part)
    installer = build_installer(seven, files, names, archive, embedded)
    files += [installer, RELEASE / f"{PREFIX}-Speech-Resources.zip", *build_update(runtime)]
    write_provenance(ROOT, Path(runtime), files)  # Internal verification record; not a public download.
    (RELEASE / "SHA256SUMS.txt").write_text("".join(f"{digest(p)}  {p.name}\n" for p in files))
    remove_obsolete_parts(RELEASE, archive.name, {p.name for p in files})
    if split:
        archive.unlink()
    print("Completed:", ", ".join(p.name for p in files))


if __name__ == "__main__":
    main()
