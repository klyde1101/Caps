import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultModel } from './transcription-runner.js';
import { findWhisperxRuntime, resolveModelSelection, runWhisperxProcess, validateModelSelection } from './whisperx-runner.js';
import { CaptionJobError, ERROR_CODES, cancelledError } from './errors.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = readFileSync(new URL('./transcription-worker.py', import.meta.url), 'utf8');

export async function createWorker(options = {}) {
  const root = process.env.PORTABLE_EXECUTABLE_DIR ?? ROOT;
  const runtime = await (options.findRuntime ?? findWhisperxRuntime)({ explicitPath: options.whisperxPath, device: options.device });
  if (basename(runtime.executable).toLowerCase() !== 'python.exe') {
    throw new CaptionJobError(ERROR_CODES.WHISPERX_NOT_FOUND, 'Queue transcription requires the bundled Python runtime.');
  }
  if (options.signal?.aborted) throw cancelledError(options.signal.reason);
  const directory = await mkdtemp(join(tmpdir(), 'caps-queue-'));
  let child, processFailure, commandId = 0, pending = '', closed = false;
  const commands = new Map();
  const fail = (error) => {
    if (/CUDA_UNAVAILABLE/.test(error.stderr ?? error.message)) {
      error = new CaptionJobError(ERROR_CODES.CUDA_UNAVAILABLE, 'The selected CUDA device is unavailable. Choose CPU or Automatic in Settings.', { cause: error });
    }
    if (/MODEL_NOT_FOUND/.test(error.stderr ?? error.message)) {
      error = new CaptionJobError(ERROR_CODES.MODEL_NOT_FOUND, 'The selected WhisperX model is missing. Check the models folder beside Caps.', { cause: error });
    }
    processFailure = error;
    for (const command of commands.values()) command.reject(error);
    commands.clear();
  };
  const completion = (options.runProcess ?? runWhisperxProcess)(runtime.executable, [
    '--alignment_dir', join(root, 'models', 'alignment'), '--output_dir', directory,
    '--device', options.device ?? 'auto', '--device_index', String(options.deviceIndex ?? 0),
    '--compute_type', options.computeType ?? 'default', '--cpu_threads', String(options.cpuThreads ?? 0)
  ], {
    ...options, env: { ...process.env, ...options.env, ...(options.cpuThreads ? { OMP_NUM_THREADS: String(options.cpuThreads), MKL_NUM_THREADS: String(options.cpuThreads), OPENBLAS_NUM_THREADS: String(options.cpuThreads), OMP_WAIT_POLICY: 'PASSIVE', CUDA_VISIBLE_DEVICES: '' } : {}) }, bootstrapSource: BOOTSTRAP, engineLabel: 'Transcription worker',
    onSpawn: (value) => { child = value; child.stdin.on('error', fail); },
    onOutput: (text, stream) => {
      if (stream !== 'stdout') { options.onOutput?.(text, stream); return; }
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.startsWith('[CapsResult] ')) { options.onOutput?.(line + '\n', stream); continue; }
        try {
          const result = JSON.parse(line.slice(13));
          commands.get(result.commandId)?.resolve(result);
          commands.delete(result.commandId);
        } catch (error) { fail(error); }
      }
    }
  });
  // Observe exit immediately, including a failure while the controller is between commands.
  const settled = completion.then(() => {
    if (!closed) fail(new CaptionJobError(ERROR_CODES.TRANSCRIPTION_FAILED, 'The transcription worker stopped before completing the queue.'));
  }, fail);
  function send(action, values = {}) {
    if (processFailure) return Promise.reject(processFailure);
    if (!child?.stdin || closed) return Promise.reject(new CaptionJobError(ERROR_CODES.TRANSCRIPTION_FAILED, 'The transcription worker is unavailable.'));
    return new Promise((resolveCommand, reject) => {
      const id = ++commandId;
      commands.set(id, { resolve: resolveCommand, reject });
      child.stdin.write(JSON.stringify({ action, commandId: id, ...values }) + '\n');
    });
  }
  return {
    async transcribe(request, fileIndex) {
      const selection = resolveModelSelection(request.model || defaultModel());
      await validateModelSelection(selection);
      return send('transcribe', { path: request.inputPath, model: selection, fileIndex });
    },
    async align() { return (await send('align', { metrics: options.calibrate === true })).aligned; },
    async release() { await send('release'); },
    async reset() { await send('reset'); },
    async close() {
      if (closed) return;
      closed = true;
      if (child?.stdin && !child.stdin.destroyed) child.stdin.end(JSON.stringify({ action: 'close' }) + '\n');
      await settled;
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export async function createQueueTranscriber(options = {}) {
  const workers = new Map();
  const history = [];
  let cpuFallback = false;
  const recoverable = error => /CUDA_UNAVAILABLE|out of memory|out_of_memory|cublas|cudnn|cuda.*(?:error|failed|unavailable|driver)/i.test((error.stderr ?? '') + error.message);
  const factory = options.createWorker ?? createWorker;
  return {
    async transcribe(request, fileIndex) {
      const runtimeOptions = { ...options, ...Object.fromEntries(
        ['whisperxPath', 'device', 'deviceIndex', 'computeType'].map((key) => [key, request[key] ?? options[key]])
      ) };
      const automatic = (request.processingPolicy ?? request.device ?? options.device ?? 'auto') === 'auto';
      if (cpuFallback) runtimeOptions.device = 'cpu';
      else if (automatic && runtimeOptions.device === 'cuda') runtimeOptions.device = 'auto';
      const key = JSON.stringify([runtimeOptions.whisperxPath, runtimeOptions.device, runtimeOptions.deviceIndex, runtimeOptions.computeType]);
      for (const [otherKey, worker] of workers) if (key !== otherKey) await worker.release();
      try {
        if (!workers.has(key)) workers.set(key, await factory(runtimeOptions));
        const result = await workers.get(key).transcribe(request, fileIndex);
        history.push({ request, fileIndex });
        return result;
      } catch (error) {
        if (options.signal?.aborted || !automatic || cpuFallback || request.cpuFallbackAllowed === false || !recoverable(error)) throw error;
        cpuFallback = true;
        await Promise.all([...workers.values()].map(worker => worker.close()));
        workers.clear();
        options.onOutput?.('CUDA unavailable or VRAM exhausted; retrying on CPU.\n', 'stderr');
        const worker = await factory({ ...runtimeOptions, device: 'cpu', computeType: 'default' });
        const cpuKey = JSON.stringify([runtimeOptions.whisperxPath, 'cpu', runtimeOptions.deviceIndex, runtimeOptions.computeType]);
        workers.set(cpuKey, worker);
        for (const item of [...history, { request, fileIndex }]) await worker.transcribe(item.request, item.fileIndex);
        history.push({ request, fileIndex });
      }
    },
    async align() {
      if (options.signal?.aborted) throw cancelledError(options.signal.reason);
      for (const worker of workers.values()) await worker.release();
      const aligned = [];
      try {
        for (const worker of workers.values()) aligned.push(...await worker.align());
      } catch (error) {
        if (options.signal?.aborted || cpuFallback || !recoverable(error) || !history.length || history.some(({request}) => (request.processingPolicy ?? request.device ?? options.device ?? 'auto') !== 'auto' || request.cpuFallbackAllowed === false)) throw error;
        cpuFallback = true;
        await Promise.all([...workers.values()].map(worker => worker.close()));
        workers.clear();
        const worker = await factory({ ...options, device: 'cpu', computeType: 'default' });
        workers.set('cpu-recovery', worker);
        for (const item of history) await worker.transcribe(item.request, item.fileIndex);
        return worker.align();
      }
      return aligned;
    },
    async reset() {
      for (const worker of workers.values()) await worker.reset();
      history.length = 0;
      cpuFallback = false;
    },
    async close() { await Promise.all([...workers.values()].map((worker) => worker.close())); }
  };
}
