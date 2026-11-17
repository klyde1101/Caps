import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createMediaPreview({ root, inputForToken, ffmpeg, start = spawn }) {
  const pending = new Map(), children = new Set();
  return {
    close() { for (const child of children) child.kill(); },
    async create(token, progress = () => {}) {
      if (typeof token !== 'string') throw Error('Invalid media preview.');
      const input = inputForToken(token);
      if (!input || extname(input).toLowerCase() === '.srt') throw Error('This source has no playable media.');
      const info = await stat(input);
      const key = createHash('sha256').update(`${input}:${info.size}:${info.mtimeMs}`).digest('hex');
      if (pending.has(key)) return pending.get(key);
      const directory = join(root, 'data', 'preview-cache');
      const target = join(directory, `${key}.mp4`);
      if ((await stat(target).catch(() => null))?.size > 0) return pathToFileURL(target).href;
      const task = (async () => {
        await mkdir(directory, { recursive: true });
        const temporary = target + '.partial.mp4';
        try {
          await new Promise((resolve, reject) => {
            const child = start(ffmpeg, ['-nostdin', '-hide_banner', '-y', '-i', input,
              '-map', '0:v:0?', '-map', '0:a:0?', '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264',
              '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
              '-threads', '2', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temporary],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            children.add(child); let errors = '', buffered = '', duration;
            child.stderr.on('data', data => {
              errors = (errors + data).slice(-4000);
              const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(errors);
              if (match) duration = +match[1] * 3600 + +match[2] * 60 + +match[3];
            });
            child.stdout.on('data', data => {
              buffered += data;
              const lines = buffered.split(/\r?\n/); buffered = lines.pop();
              for (const line of lines) { const match = /^out_time_us=(\d+)$/.exec(line); if (match) { const seconds = +match[1] / 1e6; progress({ previewToken: token, seconds, percent: duration ? Math.min(99, seconds / duration * 100) : null }); } }
            });
            child.once('error', error => { children.delete(child); reject(error); });
            child.once('close', code => { children.delete(child); if (code === 0) resolve(); else reject(Error('Could not create a compatible preview. ' + errors.slice(-800))); });
          });
          await rename(temporary, target);
          progress({ previewToken: token, percent: 100 });
          return pathToFileURL(target).href;
        } finally { await rm(temporary, { force: true }); }
      })();
      pending.set(key, task);
      try { return await task; } finally { pending.delete(key); }
    }
  };
}
