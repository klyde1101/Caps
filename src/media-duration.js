import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ffmpegDirectory } from './whisperx-runner.js';

// Header inspection only; never decode a second copy of the audio on the scheduling path.
export function mediaDuration(path, signal) {
  return new Promise((resolve) => {
    execFile(join(ffmpegDirectory(), 'ffmpeg.exe'), ['-hide_banner', '-i', path],
      { windowsHide: true, timeout: 5000, maxBuffer: 65536, signal }, (_error, _stdout, stderr) => {
        const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr ?? '');
        resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined);
      });
  });
}
