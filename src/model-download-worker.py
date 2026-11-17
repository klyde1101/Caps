"""Hidden, public Hub downloads. Arguments are supplied by Caps, never a shell."""
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


def main():
    parent, repo, revision, destination, files = sys.argv[1:]
    threading.Thread(target=watch_parent, args=(int(parent),), daemon=True).start()
    sys.stdout = RedactedStream(sys.stdout)
    sys.stderr = RedactedStream(sys.stderr)
    from huggingface_hub import snapshot_download
    # An anonymous, pinned public snapshot. No saved or inherited access token is used.
    snapshot_download(repo_id=repo, revision=revision, local_dir=destination,
                      allow_patterns=json.loads(files), token=False, max_workers=2)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
