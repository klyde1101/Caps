"""Build a Windows portable archive and per-user installer from the verified folder build."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
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


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seven", required=True)
    parser.add_argument("--makensis", help=argparse.SUPPRESS)
    parser.add_argument("--prepared-zip", action="store_true",
                        help="Use the completed portable ZIP")
    args = parser.parse_args()
    seven = Path(args.seven).resolve()
    RELEASE.mkdir(parents=True, exist_ok=True)
    archive = RELEASE / f"{PREFIX}-Portable-x64.zip"
    runtime = run("node", "--input-type=module", "-e",
                  "import {launcherRuntime} from './scripts/clean-project.mjs'; console.log(await launcherRuntime('Caps.exe',process.cwd()))",
                  capture_output=True, text=True).stdout.strip()
    run("node", "scripts/verify-windows-package.mjs", runtime, "node_modules/electron/dist", "-", str(ROOT))
    if not args.prepared_zip:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as payload:
            payload.write(ROOT / "Caps.exe", "Caps.exe")
            for base in (Path(runtime), ROOT / "whisperx"):
                for directory, folders, filenames in os.walk(base):
                    folders[:] = [d for d in folders if d != "__pycache__"]
                    for name in filenames:
                        if not any(fnmatch(name, pattern) for pattern in EXCLUDES):
                            path = Path(directory) / name
                            payload.write(path, path.relative_to(ROOT))
    with zipfile.ZipFile(archive) as payload:
        names = [PureWindowsPath(name) for name in payload.namelist()]
        for required in ("Caps.exe", Path(runtime).relative_to(ROOT).as_posix()+"/resources/app.asar",
                         "whisperx/cpu/python/python.exe", "whisperx/cuda/python/python.exe", "whisperx/ffmpeg/ffmpeg.exe"):
            payload.getinfo(required)
        if payload.testzip() is not None:
            raise ValueError("Portable ZIP integrity check failed.")
    if not names or any(p.parts[0] not in ("Caps.exe", "dist", "whisperx") or
                        any(p.match(pattern) for pattern in EXCLUDES) or p.is_absolute() or ".." in p.parts
                        for p in names):
        raise ValueError("Unexpected release archive contents")
    # Leave headroom for the installer wrapper and GitHub's per-asset size limit.
    limit = 1900 * 1024**2
    embedded = archive.stat().st_size < limit
    files = [archive]
    split = archive.stat().st_size >= 2 * 1024**3
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
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        manifest = work / "payload.json"
        manifest.write_text(json.dumps({"baseUrl": f"https://github.com/klyde1101/Caps/releases/download/v{VERSION}",
                            "files": [{"name": p.name, "sha256": digest(p)} for p in files]}))
        removal = work / "installed-files.txt"
        removal.write_text("\n".join(str(p) for p in sorted(names, key=lambda p: len(p.parts), reverse=True)), encoding="utf-8")
        installer = RELEASE / f"{PREFIX}-Setup-x64.exe"
        metadata = work / "version.cs"
        metadata.write_text(f'[assembly:System.Reflection.AssemblyInformationalVersion("{VERSION}")]')
        csc = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
        run(csc, "/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/reference:System.Windows.Forms.dll",
            "/reference:Microsoft.CSharp.dll", f"/win32icon:{ROOT / 'build/caps-icon.ico'}", f"/out:{installer}",
            f"/resource:{seven},7za.exe", f"/resource:{manifest},payload.json",
            f"/resource:{removal},installed-files.txt", f"/resource:{ROOT / 'scripts/install-release-payload.ps1'},install-release-payload.ps1",
            f"/resource:{ROOT / 'scripts/uninstall-release.ps1'},uninstall.ps1", metadata, ROOT / "scripts/release-installer.cs")
        with installer.open("ab") as output:
            if embedded:
                with archive.open("rb") as source:
                    shutil.copyfileobj(source, output, 4 * 1024**2)
            output.write((archive.stat().st_size if embedded else 0).to_bytes(8, "little"))
    files += [installer, RELEASE / f"{PREFIX}-Speech-Resources.zip"]
    (RELEASE / "SHA256SUMS.txt").write_text("".join(f"{digest(p)}  {p.name}\n" for p in files))
    if split:
        archive.unlink()
    print("Completed:", ", ".join(p.name for p in files))


if __name__ == "__main__":
    main()
