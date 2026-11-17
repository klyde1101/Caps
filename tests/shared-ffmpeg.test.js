import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ffmpegDirectory, runWhisperxProcess, verifyFfmpeg, whisperxCandidates } from '../src/whisperx-runner.js';

test('CPU and CUDA Python processes use shared FFmpeg and preserve the inherited Windows path', async () => {
  const portable = resolve('test portable app');
  for (const device of ['cpu', 'cuda']) {
    const executable = join(portable, 'whisperx', device, 'python', 'python.exe');
    let invocation;
    await runWhisperxProcess(executable, ['clip.mp4'], {
      env: { PORTABLE_EXECUTABLE_DIR: portable, Path: 'C:\\Windows', PYTHONPATH: 'unwanted', PYTHONHOME: 'unwanted' },
      platform: 'win32',
      spawnProcess(command, args, options) {
        invocation = { command, args, options };
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      }
    });
    assert.equal(invocation.command, executable);
    assert.deepEqual(invocation.args.slice(0, 2), ['-u', '-c']);
    assert.match(invocation.args[2], /os\.add_dll_directory/);
    assert.match(invocation.args[2], /runpy\.run_module\('whisperx'/);
    assert.deepEqual(invocation.args.slice(3), ['clip.mp4']);
    assert.equal(invocation.options.env.CAPS_FFMPEG_DIRECTORY, join(portable, 'whisperx', 'ffmpeg'));
    assert.equal(invocation.options.env.PATH, `${join(portable, 'whisperx', 'ffmpeg')};${join(portable, 'whisperx', device, 'python')};C:\\Windows`);
    assert.equal(invocation.options.env.Path, undefined);
    assert.equal(invocation.options.env.PYTHONHOME, undefined);
    assert.equal(invocation.options.env.PYTHONPATH, undefined);
  }
});

test('FFmpeg discovery supports development, portable, packaged and asar-unpacked layouts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-ffmpeg-paths-'));
  try {
    assert.equal(ffmpegDirectory({ env: {}, projectRoot: root }), join(root, 'whisperx', 'ffmpeg'));
    const options = { env: {}, projectRoot: join(root, 'resources', 'app.asar'), execPath: join(root, 'Caps.exe') };
    assert.equal(ffmpegDirectory(options), join(root, 'whisperx', 'ffmpeg'));
    assert.equal(whisperxCandidates({ ...options, device: 'cpu' })[0], join(root, 'whisperx', 'cpu', 'python', 'python.exe'));
    const unpacked = join(root, 'resources', 'app.asar.unpacked', 'whisperx', 'ffmpeg');
    await mkdir(unpacked, { recursive: true });
    await writeFile(join(unpacked, 'ffmpeg.exe'), 'fixture');
    assert.equal(ffmpegDirectory(options), unpacked);
    assert.equal(ffmpegDirectory({ ...options, env: { PORTABLE_EXECUTABLE_DIR: root } }), join(root, 'whisperx', 'ffmpeg'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FFmpeg diagnostics check the shared executable and report its missing path', async () => {
  const projectRoot = resolve('test app');
  const expected = join(projectRoot, 'whisperx', 'ffmpeg', 'ffmpeg.exe');
  assert.equal(await verifyFfmpeg({ env: {}, projectRoot, access: async (path) => assert.equal(path, expected) }), expected);
  await assert.rejects(verifyFfmpeg({ env: {}, projectRoot, access: async () => { throw new Error('missing'); } }), (error) => {
    assert.equal(error.code, 'WHISPERX_NOT_FOUND');
    assert.ok(error.message.includes(expected));
    return true;
  });
});
