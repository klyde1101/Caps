"""Hidden, public Hub downloads. Arguments are supplied by Caps, never a shell."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import ctypes
import json
import os
import re
import sys
import threading
import time
import traceback


class RedactedStream:
    def __init__(self, stream):
        self.stream = stream

    def write(self, value):
        value = re.sub(r'(https?://)[^/@\s]+@', r'\1[redacted]@', str(value))
        value = re.sub(r'https?://[^\s\x27\x22<>]+', lambda m: m[0].split('?')[0] + ('?[redacted]' if '?' in m[0] else ''), str(value))
        value = re.sub(r'(?i)(authorization\s*[:=]\s*)(?:bearer\s+)?\S+', r'\1[redacted]', value)
        value = re.sub(r'(?i)(bearer\s+|(?:access_)?token\s*[:=]\s*)\S+', r'\1[redacted]', value)
        value = re.sub(r'hf_[A-Za-z0-9]+', '[redacted]', value)
        return self.stream.write(value)

    def flush(self):
        self.stream.flush()

    def isatty(self):
        return False


def watch_parent(pid):
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE, no elevated access.
        if not handle:
            os._exit(75)
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        os._exit(75)
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            os._exit(75)
        time.sleep(.5)


def ensure_speech_resources(root, manifest, staging):
    missing = {}
    for name, expected in manifest['files'].items():
        target = (root / name).resolve()
        if not target.is_relative_to(root):
            raise ValueError('Invalid resource path')
        if target.is_file():
            with target.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() == expected:
                    continue
        missing[name] = target
    if not missing:
        return
    # Any interrupted download stays in the model staging area, never at a live path.
    with tempfile.TemporaryFile(dir=staging) as payload:
        with urllib.request.urlopen(manifest['url'], timeout=90) as response:
            import shutil
            shutil.copyfileobj(response, payload, length=1024 * 1024)
        with zipfile.ZipFile(payload) as archive:
            for name, target in missing.items():
                target.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                    temporary = Path(output.name)
                try:
                    digest = hashlib.sha256()
                    with archive.open(name) as source, temporary.open('wb') as output:
                        while chunk := source.read(1024 * 1024):
                            digest.update(chunk)
                            output.write(chunk)
                    if digest.hexdigest() != manifest['files'][name]:
                        raise ValueError('Downloaded speech resource failed verification: ' + name)
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)


def main():
    parent, repo, revision, destination, files = sys.argv[1:]
    threading.Thread(target=watch_parent, args=(int(parent),), daemon=True).start()
    sys.stdout = RedactedStream(sys.stdout)
    sys.stderr = RedactedStream(sys.stderr)
    from huggingface_hub import snapshot_download
    # Shared speech files and the pinned model have independent destinations.
    with ThreadPoolExecutor(max_workers=1) as pool:
        resources = None
        if 'CAPS_SPEECH_RESOURCES' in os.environ:
            resources = pool.submit(ensure_speech_resources, Path(os.environ['CAPS_RESOURCES_ROOT']).resolve(),
                                    json.loads(os.environ['CAPS_SPEECH_RESOURCES']), destination)
        snapshot_download(repo_id=repo, revision=revision, local_dir=destination,
                          allow_patterns=json.loads(files), token=False, max_workers=2)
        if resources is not None:
            resources.result()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
