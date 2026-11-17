import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extractHighlightedWords, parseSrt } from '../src/parsers/whisperx-srt.js';
import { convertWhisperxSrt } from '../src/pipeline.js';
import { validateSrt } from '../src/validation/srt-validator.js';
import { buildWhisperxArgs, defaultModel, findWhisperx, findWhisperxRuntime, inspectWhisperxRuntime, LOCAL_MODEL_PATH, modelCandidates, resolveModelSelection, whisperxCandidates } from '../src/whisperx-runner.js';

const sample = await readFile(new URL('./fixtures/sample-highlighted.srt', import.meta.url), 'utf8');

test('extracts only underlined aligned words from karaoke-state SRT', () => {
  const cues = parseSrt(sample);
  const words = extractHighlightedWords(cues);
  assert.equal(cues.length, 10);
  assert.equal(words.length, 9);
  assert.deepEqual(words.map((word) => word.text), ['I', 'think', 'that', 'this', 'is', 'the', 'perfect', 'everyday', 'product.']);
});

test('Social Media mode removes phrase duplicates and underline markup', () => {
  const result = convertWhisperxSrt(sample, 'social-media');
  assert.equal(result.wordCount, 9);
  assert.equal(result.validation.valid, true);
  assert.doesNotMatch(result.srt, /<u>/i);
});

test('Social Media mode makes short captions preserving source punctuation through export', () => {
  const result = convertWhisperxSrt(sample, 'social-media');
  assert.ok(result.cues.every((cue) => cue.text.length <= 24 && cue.text.split(' ').length <= 5));
  assert.equal(result.cues.map((cue) => cue.text).join(' '), 'I think that this is the perfect everyday product.');
  assert.deepEqual(parseSrt(result.srt).map((cue) => cue.text), result.cues.map((cue) => cue.text));
  assert.equal(result.validation.valid, true);
});

test('validator detects overlaps and formatting leftovers', () => {
  const result = validateSrt('1\n00:00:00,000 --> 00:00:01,000\n<u>Hello</u>\n\n2\n00:00:00,900 --> 00:00:01,200\nworld\n');
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 2);
});

const realFixture = new URL('./fixtures/AUDIO_1.srt', import.meta.url);
test('real WhisperX regression: 506 cues produce 264 aligned words', { skip: !existsSync(realFixture) }, async () => {
  const input = await readFile(realFixture, 'utf8');
  const result = convertWhisperxSrt(input, 'social-media');
  assert.equal(result.sourceCueCount, 506);
  assert.equal(result.wordCount, 264);
  assert.ok(result.cues.length < 264);
});

const realWordFixture = new URL('./fixtures/1AUDIO_word_by_word.srt', import.meta.url);
test('real clean timeline produces valid captions from 264 aligned words', { skip: !existsSync(realWordFixture) }, async () => {
  const input = await readFile(realWordFixture, 'utf8');
  const result = convertWhisperxSrt(input, 'social-media');
  assert.equal(result.sourceType, 'clean-word-timeline');
  assert.equal(result.sourceCueCount, 264);
  assert.equal(result.wordCount, 264);
  assert.equal(result.validation.valid, true);
  assert.ok(result.cues.length < 264);
});

test('WhisperX detection prioritizes explicit and configured paths', async () => {
  const env = { CAPS_WHISPERX: 'configured.exe', PORTABLE_EXECUTABLE_DIR: 'portable', APPDATA: 'appdata' };
  const candidates = whisperxCandidates({ explicitPath: 'manual.exe', env });
  assert.equal(candidates[0], 'manual.exe');
  assert.ok(candidates.includes('configured.exe'));
  assert.ok(candidates.includes(joinForPlatform('portable', 'whisperx', 'cuda', 'python', 'python.exe')));
  const found = await findWhisperx({ explicitPath: 'missing.exe', env, canExecute: async (path) => {
    if (path !== 'configured.exe') throw new Error('missing');
  } });
  assert.equal(found, 'configured.exe');
});

test('WhisperX runtime inspection distinguishes CPU-only and CUDA PyTorch builds', async () => {
  const cpu = await inspectWhisperxRuntime('cpu.exe', {
    readFile: async () => "__version__ = '2.8.0+cpu'\ncuda: Optional[str] = None\n"
  });
  const cuda = await inspectWhisperxRuntime('cuda.exe', {
    readFile: async () => "__version__ = '2.8.0+cu128'\ncuda: Optional[str] = '12.8'\n"
  });

  assert.deepEqual(cpu, { pytorchVersion: '2.8.0+cpu', cudaSupport: 'unsupported', cudaVersion: undefined });
  assert.deepEqual(cuda, { pytorchVersion: '2.8.0+cu128', cudaSupport: 'supported', cudaVersion: '12.8' });
});

test('WhisperX runtime selection keeps CPU and CUDA builds independently selectable', async () => {
  const env = { CAPS_WHISPERX_CPU: 'cpu.exe', CAPS_WHISPERX_CUDA: 'cuda.exe' };
  const canExecute = async (path) => {
    if (!['cpu.exe', 'cuda.exe'].includes(path)) throw new Error('missing');
  };
  const inspectRuntime = async (path) => ({ cudaSupport: path === 'cuda.exe' ? 'supported' : 'unsupported' });

  assert.equal((await findWhisperxRuntime({ device: 'cpu', env, canExecute, inspectRuntime })).executable, 'cpu.exe');
  assert.equal((await findWhisperxRuntime({ device: 'cuda', env, canExecute, inspectRuntime })).executable, 'cuda.exe');
});

test('WhisperX invocation requests aligned highlighted SRT', () => {
  const args = buildWhisperxArgs('video with spaces.mp4', 'output folder');
  assert.equal(args[0], 'video with spaces.mp4');
  assert.deepEqual(args.slice(1, 15), ['--language', 'en', '--model', resolveModelSelection('large-v3-turbo'), '--output_dir', 'output folder', '--output_format', 'srt', '--highlight_words', 'True', '--print_progress', 'True', '--batch_size', '4']);
});

test('WhisperX device options support automatic selection and indexed accelerators', () => {
  const automatic = buildWhisperxArgs('video.mp4', 'output', { device: 'auto', deviceIndex: 3 });
  assert.equal(automatic.includes('--device'), false);
  assert.equal(automatic.includes('--device_index'), false);
  const cuda = buildWhisperxArgs('video.mp4', 'output', { device: 'cuda', deviceIndex: 3 });
  assert.ok(cuda.includes('--device') && cuda.includes('--device_index'));
  const xpu = buildWhisperxArgs('video.mp4', 'output', { device: 'xpu', deviceIndex: 1 });
  assert.ok(xpu.includes('--device') && xpu.includes('--device_index'));
  const mps = buildWhisperxArgs('video.mp4', 'output', { device: 'mps', deviceIndex: 2 });
  assert.ok(mps.includes('--device'));
});

test('uses the complete project-local Turbo model automatically', () => {
  assert.ok([LOCAL_MODEL_PATH, 'large-v3-turbo'].includes(defaultModel()));
  assert.ok(resolveModelSelection('large-v3-turbo').endsWith('large-v3-turbo'));
  assert.match(LOCAL_MODEL_PATH, /models[\\/]large-v3-turbo$/);
});

test('uses the portable executable directory for external models', () => {
  const candidates = modelCandidates({ env: { PORTABLE_EXECUTABLE_DIR: 'portable' } });
  assert.equal(candidates[0], joinForPlatform('portable', 'models', 'large-v3-turbo'));
});

test('resolves the single WhisperX model to its local folder', () => {
  assert.ok(['large-v3-turbo', joinForPlatform('models', 'large-v3-turbo')].some((candidate) => resolveModelSelection('large-v3-turbo').endsWith(candidate)));
});

function joinForPlatform(...parts) {
  return parts.join(process.platform === 'win32' ? '\\' : '/');
}
