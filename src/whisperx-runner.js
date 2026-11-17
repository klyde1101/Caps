import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { constants, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptionJobError, ERROR_CODES, cancelledError } from './errors.js';
import { createTranscriptionProgressParser } from './transcription-progress.js';
import { DEFAULT_MODEL, AVAILABLE_MODELS, isSupportedModel } from './model-catalog.js';
export { DEFAULT_MODEL, AVAILABLE_MODELS } from './model-catalog.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Read through Electron's filesystem so this also works from inside app.asar.
const PYTHON_BOOTSTRAP = readFileSync(new URL('./whisperx-bootstrap.py', import.meta.url), 'utf8');
export const MODELS_DIRECTORY = join(PROJECT_ROOT, 'models');
export const LOCAL_MODEL_PATH = join(MODELS_DIRECTORY, DEFAULT_MODEL);
const INDEXED_DEVICES = new Set(['cuda', 'xpu']);
const REQUIRED_MODEL_FILES = Object.freeze(['config.json', 'model.bin', 'tokenizer.json']);
const VOCABULARY_FILES = Object.freeze(['vocabulary.json', 'vocabulary.txt']);
const CUDA_UNAVAILABLE_PATTERNS = Object.freeze([
  /torch not compiled with cuda enabled/i,
  /cuda (?:is|was) not available/i,
  /no cuda gpus? (?:are|is) available/i,
  /no cuda-capable device/i,
  /found no nvidia driver/i,
  /cuda driver version is insufficient/i,
  /not compiled with cuda support/i,
  /could not load (?:the )?(?:cudnn|cublas)/i,
  /(?:cudnn|cublas)[^\r\n]*(?:not found|could not be loaded)/i
]);

function namedModelCandidates(model, { env = process.env } = {}) {
  const portableDirectory = env.PORTABLE_EXECUTABLE_DIR;
  return [...new Set([
    model === DEFAULT_MODEL ? env.CAPS_MODEL : undefined,
    portableDirectory && join(portableDirectory, 'models', model),
    !portableDirectory && join(dirname(process.execPath), 'models', model),
    !portableDirectory && join(MODELS_DIRECTORY, model)
  ].filter(Boolean))];
}

export function modelCandidates(options = {}) {
  return namedModelCandidates(DEFAULT_MODEL, options);
}

export function inspectModel(model) {
  const looksLikePath = isAbsolute(model) || model.includes('/') || model.includes('\\');
  if (!looksLikePath) return { model, type: 'name', valid: true, missingFiles: [] };
  const missingFiles = REQUIRED_MODEL_FILES.filter((file) => !existsSync(join(model, file)));
  if (!VOCABULARY_FILES.some((file) => existsSync(join(model, file)))) missingFiles.push('vocabulary.json or vocabulary.txt');
  return { model, type: 'path', valid: missingFiles.length === 0, missingFiles };
}

export function defaultModel(options = {}) {
  return modelCandidates(options).find((candidate) => inspectModel(candidate).valid) ?? DEFAULT_MODEL;
}

export function resolveModelSelection(model, options = {}) {
  if (!AVAILABLE_MODELS.some(({ id }) => id === model)) return model;
  return namedModelCandidates(model, options).find((candidate) => inspectModel(candidate).valid) ?? model;
}

export function inspectLocalModel(model, dependencies = {}) {
  const resolveSelection = dependencies.resolveModelSelection ?? resolveModelSelection;
  const inspect = dependencies.inspectModel ?? inspectModel;
  const chooseDefault = dependencies.defaultModel ?? defaultModel;
  const selected = resolveSelection(model || chooseDefault());
  const status = inspect(selected);
  if (status.type === 'path' && status.valid) return { ...status, installed: true };
  return {
    ...status,
    valid: false,
    installed: false,
    missingFiles: status.missingFiles.length ? status.missingFiles : ['local model folder']
  };
}

export async function directorySize(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let size = 0;
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) size += await directorySize(entryPath);
    else if (entry.isFile()) size += (await stat(entryPath)).size;
  }
  return size;
}

export async function inspectInstalledModels(resolveModel = resolveModelSelection) {
  return Promise.all(AVAILABLE_MODELS.map(async ({ id, label }) => {
    const path = resolveModel(id);
    const isLocalPath = path !== id;
    return {
      id,
      label,
      path,
      installed: isLocalPath,
      sizeBytes: isLocalPath ? await directorySize(path) : 0
    };
  }));
}

function whisperxDirectories({ env = process.env, projectRoot = PROJECT_ROOT, execPath = process.execPath } = {}) {
  if (env.PORTABLE_EXECUTABLE_DIR) return [join(env.PORTABLE_EXECUTABLE_DIR, 'whisperx')];
  if (/\.asar(?:\.unpacked)?$/i.test(projectRoot)) {
    return [resolve(dirname(execPath), 'whisperx'), resolve(projectRoot.replace(/\.asar$/i, '.asar.unpacked'), 'whisperx')];
  }
  return [resolve(projectRoot, 'whisperx')];
}

export function ffmpegDirectory(options = {}) {
  const candidates = whisperxDirectories(options).map((directory) => resolve(directory, 'ffmpeg'));
  return candidates.find((directory) => existsSync(join(directory, 'ffmpeg.exe'))) ?? candidates[0];
}

export async function verifyFfmpeg(options = {}) {
  const executable = join(ffmpegDirectory(options), 'ffmpeg.exe');
  try {
    await (options.access ?? access)(executable, constants.X_OK);
  } catch (error) {
    throw new CaptionJobError(ERROR_CODES.WHISPERX_NOT_FOUND, `FFmpeg was not found at ${executable}. Prepare the shared whisperx\\ffmpeg folder.`, { cause: error });
  }
  return executable;
}

export function whisperxCandidates({ explicitPath, device, env = process.env, ...paths } = {}) {
  const runtimeDirectories = whisperxDirectories({ env, ...paths });
  const candidatesFor = (kind) => runtimeDirectories.flatMap((directory) => [
    join(directory, kind, 'python', 'python.exe'),
    join(directory, kind, 'whisperx-standalone.exe')
  ]);
  const cudaCandidates = [env.CAPS_WHISPERX_CUDA, ...candidatesFor('cuda')];
  const cpuCandidates = [env.CAPS_WHISPERX_CPU, ...candidatesFor('cpu')];
  const specialized = device === 'cuda'
    ? [...cudaCandidates, ...cpuCandidates]
    : device === 'cpu'
      ? [...cpuCandidates, ...cudaCandidates]
      : [...cudaCandidates, ...cpuCandidates];
  return [...new Set([
    explicitPath,
    ...specialized,
    env.CAPS_WHISPERX,
    ...runtimeDirectories.map((directory) => join(directory, 'whisperx-standalone.exe'))
  ].filter(Boolean))];
}

export async function inspectWhisperxRuntime(executable, dependencies = {}) {
  const loadFile = dependencies.readFile ?? readFile;
  const versionPaths = basename(executable).toLowerCase() === 'python.exe'
    ? [join(dirname(executable), 'Lib', 'site-packages', 'torch', 'version.py')]
    : [join(dirname(executable), '_internal', 'torch', 'version.py')];
  for (const versionPath of versionPaths) try {
    const contents = await loadFile(versionPath, 'utf8');
    const version = /__version__\s*=\s*['"]([^'"]+)['"]/.exec(contents)?.[1];
    const cudaValue = /^cuda(?:\s*:\s*[^=]+)?\s*=\s*(?:['"]([^'"]+)['"]|None)/m.exec(contents);
    const cudaSupport = cudaValue ? (cudaValue[1] ? 'supported' : 'unsupported') : 'unknown';
    return { pytorchVersion: version, cudaSupport, cudaVersion: cudaValue?.[1] };
  } catch (error) {
    if (error.code !== 'ENOENT') return { cudaSupport: 'unknown', inspectionError: error.message };
  }
  return { cudaSupport: 'unknown' };
}

export async function findWhisperxRuntime(options = {}) {
  const canExecute = options.canExecute ?? (async (path) => access(path, constants.X_OK));
  const inspectRuntime = options.inspectRuntime ?? inspectWhisperxRuntime;
  const available = [];
  for (const candidate of whisperxCandidates(options)) {
    try {
      await canExecute(candidate);
      const runtime = { executable: candidate, ...(await inspectRuntime(candidate)) };
      available.push(runtime);
      if (candidate === options.explicitPath) {
        if (options.device === 'cuda' && runtime.cudaSupport !== 'supported') {
          throw new CaptionJobError(ERROR_CODES.CUDA_UNAVAILABLE, 'The selected WhisperX runtime does not have verified CUDA-enabled PyTorch.');
        }
        return runtime;
      }
      if (options.device === 'cuda' && runtime.cudaSupport === 'supported') return runtime;
      if (options.device === 'cpu' && runtime.cudaSupport === 'unsupported') return runtime;
      if (options.device !== 'cpu' && options.device !== 'cuda' && runtime.cudaSupport === 'supported') return runtime;
    } catch (error) {
      if (error instanceof CaptionJobError) throw error;
      // Continue through the ordered fallbacks.
    }
  }
  if (options.explicitPath && available[0]?.executable === options.explicitPath) {
    if (options.device === 'cuda' && available[0].cudaSupport !== 'supported') {
      throw new CaptionJobError(ERROR_CODES.CUDA_UNAVAILABLE, 'The selected WhisperX runtime does not have verified CUDA-enabled PyTorch. Choose CPU or use the Caps CUDA runtime.');
    }
    return available[0];
  }
  if (options.device === 'cuda') {
    const compatible = available.find((runtime) => runtime.cudaSupport === 'supported');
    if (compatible) return compatible;
    if (available.length) throw new CaptionJobError(ERROR_CODES.CUDA_UNAVAILABLE, 'No verified CUDA-enabled Caps WhisperX runtime was found. Add one under whisperx\\cuda or choose CPU.');
  } else if (options.device === 'cpu') {
    const preferred = available.find((runtime) => runtime.cudaSupport === 'unsupported') ?? available[0];
    if (preferred) return preferred;
  } else {
    const preferred = available.find((runtime) => runtime.cudaSupport === 'supported')
      ?? available.find((runtime) => runtime.cudaSupport === 'unsupported')
      ?? available[0];
    if (preferred) return preferred;
  }
  throw new CaptionJobError(ERROR_CODES.WHISPERX_NOT_FOUND, 'Caps WhisperX was not found. Keep the cpu and cuda runtime folders beside Caps, or provide --whisperx <path>.');
}

export async function findWhisperx(options = {}) {
  return (await findWhisperxRuntime(options)).executable;
}

export function buildWhisperxArgs(inputPath, outputDir, options = {}) {
  const { language = 'en', model = resolveModelSelection('large-v3-turbo'), device, deviceIndex, computeType = 'default' } = options;
  if (!AVAILABLE_MODELS.some(({ id }) => (model === id || model === resolveModelSelection(id)))) {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Choose Large v3 Turbo or Small.');
  }
  const inputPaths = Array.isArray(inputPath) ? inputPath : [inputPath];
  if (!inputPaths.length) throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'At least one media input is required.');
  const args = [...inputPaths, '--language', language, '--model', model, '--output_dir', outputDir, '--output_format', 'srt', '--highlight_words', 'True', '--print_progress', 'True', '--batch_size', '4'];
  if (inspectModel(model).type === 'path') {
    const modelsDirectory = process.env.PORTABLE_EXECUTABLE_DIR
      ? join(process.env.PORTABLE_EXECUTABLE_DIR, 'models') : MODELS_DIRECTORY;
    args.push('--model_dir', join(modelsDirectory, 'alignment'), '--model_cache_only', 'True');
  }
  // Omitting --device lets WhisperX safely choose CUDA when PyTorch detects it,
  // otherwise CPU. Passing "auto" through would be invalid for its PyTorch alignment stage.
  if (device && device !== 'auto') args.push('--device', device);
  if (INDEXED_DEVICES.has(device) && deviceIndex !== undefined) args.push('--device_index', String(deviceIndex));
  const selectedComputeType = computeType === 'default'
    ? device === 'cpu' ? 'int8' : device === 'cuda' ? 'float16' : 'default'
    : computeType;
  args.push('--compute_type', selectedComputeType);
  return args;
}

export async function validateModelSelection(model) {
  const looksLikePath = isAbsolute(model) || model.includes('/') || model.includes('\\');
  if (!looksLikePath) {
    if (!isSupportedModel(model)) throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Choose Large v3 Turbo or Small.');
    return;
  }
  const status = inspectModel(model);
  if (!status.valid) throw new CaptionJobError(ERROR_CODES.MODEL_NOT_FOUND, `The selected Whisper model is missing required files: ${status.missingFiles.join(', ')}`);
}

export function parseWhisperxProgress(text) {
  const matches = [...String(text).matchAll(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%/g)];
  if (!matches.length) return undefined;
  const percent = Number(matches.at(-1)[1]);
  return percent >= 0 && percent <= 100 ? percent : undefined;
}

export function isCudaUnavailableError(error) {
  const details = [error?.message, error?.stderr, error?.cause?.message].filter(Boolean).join('\n');
  return CUDA_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(details));
}

export function terminateProcessTree(child, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (!child?.pid) return Promise.resolve();
  if (platform !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve();
  }
  return new Promise((resolveTermination) => {
    const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
    killer.once('error', () => {
      child.kill();
      resolveTermination();
    });
    killer.once('close', () => resolveTermination());
  });
}

export function runWhisperxProcess(executable, args, options = {}) {
  const engineLabel = options.engineLabel ?? 'WhisperX';
  const {
    onOutput = () => {},
    onProgress = () => {},
    signal,
    spawnProcess = spawn,
    terminate = terminateProcessTree,
    env = process.env,
    platform = process.platform
  } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError(signal.reason));
      return;
    }
    let child;
    try {
      const bundledPython = basename(executable).toLowerCase() === 'python.exe';
      const commandArgs = bundledPython ? ['-u', '-c', options.bootstrapSource ?? PYTHON_BOOTSTRAP, ...args] : args;
      const runtimeDirectory = dirname(executable);
      const portableDirectory = env.PORTABLE_EXECUTABLE_DIR ?? PROJECT_ROOT;
      const pathKeys = Object.keys(env).filter((key) => platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH');
      const environment = {
        ...env,
        TORCH_HOME: join(portableDirectory, 'models', 'torch'),
        HF_HOME: join(portableDirectory, 'models', 'huggingface'),
        NLTK_DATA: join(portableDirectory, 'models', 'nltk'),
        MPLCONFIGDIR: join(portableDirectory, 'data', 'matplotlib'),
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        // Caps uses only PyTorch. Skip optional TensorFlow/Flax backend discovery.
        USE_TF: '0',
        USE_FLAX: '0',
        HF_HUB_DISABLE_TELEMETRY: '1',
        PYANNOTE_METRICS_ENABLED: '0',
        ORT_DISABLE_TELEMETRY: '1',
        CAPS_FFMPEG_DIRECTORY: ffmpegDirectory({ ...options, env }),
        CAPS_AUTO_BATCH_SIZE: options.autoBatchSize ? '1' : '0',
        CAPS_FILE_PROGRESS: bundledPython ? '1' : '0',
        PYTHONNOUSERSITE: '1'
      };
      for (const key of pathKeys) delete environment[key];
      environment.PATH = [ffmpegDirectory({ ...options, env }), runtimeDirectory, env[pathKeys[0]] ?? ''].join(platform === 'win32' ? ';' : ':');
      delete environment.PYTHONPATH;
      delete environment.PYTHONHOME;
      child = spawnProcess(executable, commandArgs, { windowsHide: true, shell: false, env: environment });
      options.onSpawn?.(child);
    } catch (error) {
      reject(new CaptionJobError(ERROR_CODES.TRANSCRIPTION_FAILED, `Could not start WhisperX: ${error.message}`, { cause: error }));
      return;
    }
    let stderr = '';
    let settled = false;
    let aborting = false;
    const bundledProgress = basename(executable).toLowerCase() === 'python.exe';
    const parseFileProgress = createTranscriptionProgressParser(onProgress);
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      action(value);
    };
    const handleOutput = (data, stream) => {
      const text = data.toString();
      onOutput(text, stream);
      if (bundledProgress) {
        if (stream === 'stdout') parseFileProgress(text);
      } else {
        const percent = parseWhisperxProgress(text);
        if (percent !== undefined) onProgress({ percent, indeterminate: false });
      }
      return text;
    };
    const abort = () => {
      if (settled || aborting) return;
      aborting = true;
      Promise.resolve(terminate(child))
        .then(() => finish(reject, cancelledError(signal?.reason)))
        .catch((error) => finish(reject, cancelledError(error)));
    };
    child.stdout.on('data', (data) => handleOutput(data, 'stdout'));
    child.stderr.on('data', (data) => {
      stderr = `${stderr}${handleOutput(data, 'stderr')}`.slice(-65536);
    });
    child.on('error', (error) => {
      if (!aborting) finish(reject, new CaptionJobError(ERROR_CODES.TRANSCRIPTION_FAILED, `Could not start ${engineLabel}: ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      if (aborting) return;
      if (code === 0) finish(resolve);
      else {
        const failure = new CaptionJobError(ERROR_CODES.TRANSCRIPTION_FAILED, `${engineLabel} exited with code ${code}.${stderr.trim() ? ` ${stderr.trim().split(/\r?\n/).at(-1)}` : ''}`);
        failure.exitCode = code;
        failure.stderr = stderr;
        finish(reject, failure);
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function transcribeMediaBatch(inputPaths, options = {}) {
  if (!Array.isArray(inputPaths) || !inputPaths.length) throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'At least one media input is required.');
  if (options.signal?.aborted) throw cancelledError(options.signal.reason);
  const requestedDevice = options.device;
  const runtime = await findWhisperxRuntime({
    explicitPath: options.whisperxPath,
    device: requestedDevice,
    canExecute: options.canExecuteWhisperx,
    inspectRuntime: options.inspectWhisperxRuntime
  });
  const executable = runtime.executable;
  const selection = options.model || 'large-v3-turbo';
  if (!AVAILABLE_MODELS.some(({ id }) => (selection === id || selection === resolveModelSelection(id)))) {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Choose Large v3 Turbo.');
  }
  const model = resolveModelSelection(selection);
  await validateModelSelection(model);
  const stems = inputPaths.map((inputPath) => basename(inputPath, extname(inputPath)).toLowerCase());
  if (new Set(stems).size !== stems.length) {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Files with the same base name must be transcribed in separate batches.');
  }
  const outputDir = await mkdtemp(join(tmpdir(), 'caps-'));
  try {
    const run = options.runProcess ?? runWhisperxProcess;
    const runOptions = {
      autoBatchSize: true,
      onOutput: options.onOutput,
      onProgress: options.onProgress,
      signal: options.signal
    };
    const automaticDevice = requestedDevice === undefined || requestedDevice === 'auto';
    const initialDevice = automaticDevice && runtime.cudaSupport !== 'supported' ? 'cpu' : requestedDevice;
    let completedOutputDir = outputDir;
    const args = buildWhisperxArgs(inputPaths, completedOutputDir, { ...options, model, device: initialDevice });
    try {
      await run(executable, args, runOptions);
    } catch (error) {
      if (!isCudaUnavailableError(error)) throw error;
      if (!automaticDevice) {
        throw new CaptionJobError(ERROR_CODES.CUDA_UNAVAILABLE, 'The selected WhisperX runtime cannot use CUDA. Choose CPU or install a CUDA-enabled WhisperX runtime.', { cause: error });
      }
      completedOutputDir = join(outputDir, 'cpu-fallback');
      await mkdir(completedOutputDir);
      options.onOutput?.('\nAutomatic GPU startup failed because this WhisperX runtime cannot use CUDA. Retrying on CPU.\n', 'system');
      options.onProgress?.({ indeterminate: true, fallback: 'cpu' });
      const fallbackArgs = buildWhisperxArgs(inputPaths, completedOutputDir, {
        ...options,
        model,
        device: 'cpu',
        deviceIndex: undefined,
        computeType: options.computeType === 'float16' ? 'int8' : options.computeType
      });
      await run(executable, fallbackArgs, runOptions);
    }
    if (options.signal?.aborted) throw cancelledError(options.signal.reason);
    const files = await readdir(completedOutputDir);
    const srtFiles = files.filter((file) => extname(file).toLowerCase() === '.srt');
    const outputs = [];
    for (const expectedStem of stems) {
      const outputName = srtFiles.find((file) => basename(file, extname(file)).toLowerCase() === expectedStem);
      if (!outputName) throw new CaptionJobError(ERROR_CODES.TRANSCRIPTION_FAILED, `WhisperX completed but did not produce an SRT file for ${expectedStem}.`);
      outputs.push({ srt: await readFile(join(completedOutputDir, outputName), 'utf8'), executable, runtime });
    }
    return outputs;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

export async function transcribeMedia(inputPath, options = {}) {
  return (await transcribeMediaBatch([inputPath], options))[0];
}
