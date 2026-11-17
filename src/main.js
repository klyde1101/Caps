import { extname } from 'node:path';
import { generateCaptionBatchJob } from './application/generate-caption-batch-job.js';
import { ERROR_CODES } from './errors.js';
import { defaultModel } from './whisperx-runner.js';
import { isSupportedModel } from './model-catalog.js';

const MODES = new Set(['social-media']);

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args.shift();
  const requestedMode = args[0] && !args[0].startsWith('--') ? args.shift() : 'social-media';
  const mode = requestedMode.toLowerCase();
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (!inputPath || !MODES.has(mode)) {
    console.error('Usage: node src/main.js <media-or-srt> [social-media] [--model small|large-v3-turbo] [--orientation 9:16|4:5|16:9] [--font-size 60|65|70] [--font-family proxima-nova-semibold|montserrat-semibold|inter-semibold|roboto-semibold|open-sans-semibold|other-sans] [--language en] [--device auto|cpu|cuda] [--device-index 0] [--whisperx path]');
    process.exitCode = 2;
    return;
  }
  if (args.includes('--model') && !isSupportedModel(option('--model'))) {
    console.error('Choose --model small or --model large-v3-turbo.');
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const isSrt = extname(inputPath).toLowerCase() === '.srt';
    if (isSrt) {
      console.log('[1/3] Reading aligned subtitles...');
    } else {
      console.log('[1/4] Locating WhisperX...');
      console.log('[2/4] Transcribing and aligning media (this can take several minutes)...');
    }
    const result = await generateCaptionBatchJob({
      inputPath,
      mode,
      grouping: { orientation: option('--orientation'), fontSize: args.includes('--font-size') ? Number(option('--font-size')) : undefined, fontFamily: args.includes('--font-family') ? option('--font-family') ?? '' : undefined },
      whisperxPath: option('--whisperx'),
      language: option('--language') ?? 'en',
      model: option('--model') ?? defaultModel(),
      device: option('--device'),
      deviceIndex: option('--device-index') === undefined ? undefined : Number(option('--device-index')),
      computeType: option('--compute-type'),
      signal: controller.signal,
      onTranscriptionOutput: (text) => process.stdout.write(text),
      onInputReady: () => console.log(isSrt
        ? '[2/3] Extracting, grouping, and validating captions...'
        : '[3/4] Extracting, grouping, and validating captions...')
    });
    console.log(`${isSrt ? '[3/3]' : '[4/4]'} Done: ${result.outputPath}`);
    console.log(`${result.sourceCueCount} source cues -> ${result.alignedWordCount} aligned words -> ${result.generatedCaptionCount} captions`);
  } catch (error) {
    console.error(`caps could not generate captions: ${error.message}`);
    process.exitCode = error.code === ERROR_CODES.CANCELLED ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

await main();
