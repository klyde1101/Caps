import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JobController } from '../src/desktop/job-controller.js';
import { createQueueTranscriber } from '../src/queue-transcriber.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';

const request = (name, model = 'small') => ({ inputPath: `C:\\Media\\${name}.wav`, outputPath: `C:\\Media\\${name}.srt`, model });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('live queue drains additions and reorders before one alignment pass and never exports partial transcripts', async () => {
  const events = [], snapshots = [], transcribed = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const jobs = new JobController(async value => {
    events.push('export:' + value.inputPath);
    assert.equal(value.alignedSrt, 'aligned:' + value.inputPath);
    return { outputPath: value.outputPath };
  }, { createTranscriber: async () => ({
    transcribe: async (value, fileIndex) => {
      events.push('transcribe:' + value.inputPath);
      transcribed.push({ value, fileIndex });
      if (transcribed.length === 1) await first;
    },
    align: async () => {
      assert.equal(snapshots.at(-1).accepting, false);
      assert.throws(() => jobs.enqueue(snapshots.at(-1).id, [request('late')]), { code: 'QUEUE_CLOSED' });
      assert.equal(events.some(value => value.startsWith('export:')), false);
      events.push('align');
      return transcribed.map(({ value, fileIndex }) => ({ fileIndex, srt: 'aligned:' + value.inputPath }));
    },
    close: async () => events.push('close')
  }) });
  const running = jobs.startQueue([request('a'), request('b')], { onQueue: value => snapshots.push(value) });
  await tick();
  let state = jobs.enqueue(snapshots.at(-1).id, [request('c', 'large-v3-turbo')]);
  jobs.moveQueued(state.id, state.items[2].id, state.items[1].id);
  release();
  const results = await running;
  assert.deepEqual(transcribed.map(({ value }) => value.model), ['small', 'large-v3-turbo', 'small']);
  assert.deepEqual(transcribed.map(({ fileIndex }) => fileIndex), [0, 2, 1]);
  assert.equal(events.indexOf('align'), 3);
  assert.equal(events.at(-1), 'close');
  assert.deepEqual(results.map(value => value.inputName), ['a.wav', 'c.wav', 'b.wav']);
  assert.ok(snapshots.some(value => value.items.some(item => item.state === 'awaiting-alignment')));
  assert.ok(snapshots.at(-1).items.every(item => item.state === 'complete'));
});

test('cancellation during deferred alignment closes the worker and publishes no output', async () => {
  let alignStarted, closed = false, snapshot;
  const ready = new Promise(resolve => { alignStarted = resolve; });
  const jobs = new JobController(() => assert.fail('No output after cancellation'), {
    createTranscriber: async ({ signal }) => ({
      transcribe: async () => {},
      align: () => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
        alignStarted();
      }),
      close: async () => { closed = true; }
    })
  });
  const running = jobs.startQueue([request('a'), request('b')], { onQueue: value => { snapshot = value; } });
  const rejected = assert.rejects(running, { code: 'CANCELLED' });
  await ready;
  await jobs.cancelAndWait();
  await rejected;
  assert.equal(closed, true);
  assert.equal(snapshot.accepting, false);
  assert.ok(snapshot.items.every(item => item.state === 'cancelled'));
});

test('queue transport reuses a process, handles split replies and duplicate stems, and removes temporary files', async () => {
  let processCount = 0, directory;
  const commands = [], logs = [];
  const worker = await createQueueTranscriber({
    findRuntime: async () => ({ executable: 'C:\\Runtime\\python.exe' }),
    onOutput: value => logs.push(value),
    runProcess: (_exe, args, options) => new Promise(resolve => {
      processCount += 1;
      directory = args[args.indexOf('--output_dir') + 1];
      const stdin = new Writable({ write(chunk, _encoding, next) {
        const command = JSON.parse(chunk.toString());
        commands.push(command);
        if (command.action === 'close') { resolve(); next(); return; }
        const result = '[CapsResult] ' + JSON.stringify({ commandId: command.commandId,
          aligned: command.action === 'align' ? [{ fileIndex: 0, srt: 'first' }, { fileIndex: 2, srt: 'second' }] : undefined }) + '\n';
        options.onOutput(result.slice(0, 8), 'stdout');
        options.onOutput(result.slice(8), 'stdout');
        next();
      } });
      options.onSpawn({ stdin });
    })
  });
  try {
    await worker.transcribe({ inputPath: 'one/clip.wav', model: 'large-v3-turbo' }, 0);
    await worker.transcribe({ inputPath: 'two/clip.wav', model: 'large-v3-turbo' }, 2);
    assert.deepEqual(await worker.align(), [{ fileIndex: 0, srt: 'first' }, { fileIndex: 2, srt: 'second' }]);
    assert.equal(processCount, 1);
    assert.deepEqual(commands.map(value => value.action), ['transcribe', 'transcribe', 'release', 'align']);
    assert.equal(logs.length, 0);
  } finally { await worker.close(); }
  assert.equal(existsSync(directory), false);
});

test('production batch defers alignment across more than ten files, mixed models, duplicate names and SRT imports', async () => {
  const requests = Array.from({ length: 12 }, (_, index) => ({ inputPath: `folder${index}/same.wav`, model: index % 2 ? 'large-v3-turbo' : 'small' }));
  requests.splice(5, 0, { inputPath: 'import.srt' });
  const events = [], transcribed = [];
  const results = await generateCaptionBatchJob({ requests }, {
    createQueueTranscriber: async () => ({
      transcribe: async (value, fileIndex) => { events.push('transcribe'); transcribed.push({ fileIndex, srt: value.inputPath }); },
      align: async () => { events.push('align'); return transcribed; },
      close: async () => events.push('close')
    }),
    generateCaptionJob: async (value, dependencies) => {
      if (!value.inputPath.endsWith('.srt')) assert.equal(dependencies.alignedSrt, value.inputPath);
      events.push('export');
      return { outputPath: value.inputPath };
    }
  });
  assert.equal(events.indexOf('align'), 12);
  assert.equal(events.indexOf('export'), 13);
  assert.equal(results.length, 13);
});

const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));
for (const device of ['cpu', 'cuda']) {
  const executable = fileURLToPath(new URL(`../whisperx/${device}/python/python.exe`, import.meta.url));
  test(`queue commands preserve Unicode paths and models with Windows-1252 stdin (${device})`, { skip: !existsSync(executable) }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caps-unicode-'));
    try {
      const inputPath = join(directory, '[10-18-26] Busted ？ 日本語 🎬.wav');
      await writeFile(inputPath, 'fixture');
      const source = await readFile(new URL('../src/transcription-worker.py', import.meta.url), 'utf8');
      const script = `
import sys, os
scope = {'__name__': 'test'}
exec(${JSON.stringify(source)}, scope)
assert sys.stdin.encoding.lower() == 'cp1252', sys.stdin.encoding
expected = sys.argv[1]
class Worker:
    def __init__(self, args): self.path = None
    def transcribe(self, command):
        assert command['path'] == expected, repr(command['path'])
        assert os.path.isfile(command['path'])
        assert command['model'] == expected
        self.path = command['path']
        scope['reply'](command)
    def align(self, command):
        assert os.path.isfile(self.path)
        scope['reply'](command, aligned=[])
    def release(self): pass
scope['QueueWorker'] = Worker
sys.argv = [sys.argv[0], '--alignment_dir', '.', '--output_dir', '.']
scope['main']()
`;
      const running = promisify(execFile)(executable, ['-c', script, inputPath], {
        env: { ...process.env, PYTHONIOENCODING: 'cp1252' }, windowsHide: true
      });
      running.child.stdin.end([
        { action: 'transcribe', commandId: 1, fileIndex: 0, path: inputPath, model: inputPath },
        { action: 'align', commandId: 2 },
        { action: 'close' }
      ].map(command => JSON.stringify(command)).join('\n') + '\n');
      const { stdout } = await running;
      const replies = stdout.trim().split('\n').map(line => JSON.parse(line.slice(13)));
      assert.deepEqual(replies, [{ commandId: 1 }, { commandId: 2, aligned: [] }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

