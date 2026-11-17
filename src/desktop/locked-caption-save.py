"""Exclusive Windows caption save. A durable recovery copy survives process death."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys
import uuid

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
request = json.loads(sys.stdin.readline())
path = Path(request['path'])
api = ctypes.WinDLL('kernel32', use_last_error=True)
api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
api.CreateFileW.restype = wintypes.HANDLE
handle = api.CreateFileW(str(path), 0xC0000000, 0, None, 3, 0x80, None)
if handle == ctypes.c_void_p(-1).value:
    print(json.dumps({'error':'OUTPUT_CONFLICT','message':'The caption file is busy or unavailable. Close other editors and retry.'}), flush=True)
    sys.exit(2)
import msvcrt
fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
backup = path.with_name(path.name + '.caps-recovery-' + uuid.uuid4().hex)
succeeded = False
with os.fdopen(fd, 'r+b') as locked:
    original = locked.read()
    if original != request['expected'].encode('utf-8'):
        print(json.dumps({'error':'OUTPUT_CONFLICT','message':'The SRT changed outside Caps. Corrections remain unsaved.'}), flush=True)
        sys.exit(2)
    print(json.dumps({'locked':True}), flush=True)
    if sys.stdin.readline().strip() != 'commit':
        sys.exit(3)
    content = request['content'].encode('utf-8')
    with backup.open('xb') as recovery:
        recovery.write(original)
        recovery.flush()
        os.fsync(recovery.fileno())
    try:
        locked.seek(0)
        locked.write(content)
        locked.truncate()
        locked.flush()
        os.fsync(locked.fileno())
        succeeded = True
    except BaseException:
        locked.seek(0)
        locked.write(original)
        locked.truncate()
        locked.flush()
        os.fsync(locked.fileno())
        raise
if succeeded:
    backup.unlink()
print(json.dumps({'saved':True}), flush=True)
