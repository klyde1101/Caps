import { randomUUID } from 'node:crypto';
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createCaptionCues, extractAlignedTimeline, serializeAndValidateCues } from '../pipeline.js';
import { CaptionJobError, ERROR_CODES, cancelledError, jobError } from '../errors.js';
import { captionLayout } from '../captions/layout.js';
import { exportTtml, styledCaptionPath } from '../exporters/ttml.js';

import { captionOutputPath } from '../captions/output-path.js';
export { captionOutputPath };

const MODES = new Set(['social-media']);

export const JOB_STAGES = Object.freeze({
  INSPECTING_INPUT: 'inspecting-input',
  LOCATING_WHISPERX: 'locating-whisperx',
  TRANSCRIBING: 'transcribing-and-aligning',
  GROUPING: 'grouping-captions',
  VALIDATING: 'validating',
  WRITING: 'writing-output',
  COMPLETE: 'complete'
});

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError(signal.reason);
}

function outputError(error, operation, outputPath) {
  if (error?.code === 'EEXIST') return jobError(error, ERROR_CODES.OUTPUT_CONFLICT, 'The output file already exists.');
  const reason = error?.message ? ` ${error.message}` : '';
  return new CaptionJobError(ERROR_CODES.OUTPUT_UNWRITABLE,
    `The output file could not be written (${operation}: ${outputPath}).${reason}`, { cause: error });
}

function pathsMatch(first, second) {
  const left = resolve(first);
  const right = resolve(second);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function prepareCaptionJob(request) {
  const { inputPath, outputPath, namingStrategy, mode = 'social-media', signal, onProgress = () => {} } = request ?? {};
  if (!inputPath || typeof inputPath !== 'string') throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'inputPath is required');
  if (!MODES.has(mode)) throw new CaptionJobError(ERROR_CODES.UNSUPPORTED_MODE, `Unknown caption mode: ${mode}`);
  try { captionLayout(request.grouping?.orientation, request.grouping?.fontSize, request.grouping?.fontFamily); }
  catch (error) { throw jobError(error, ERROR_CODES.INVALID_INPUT); }
  if (outputPath && namingStrategy) throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Specify outputPath or namingStrategy, not both');

  const emit = (stage) => onProgress({ stage });
  emit(JOB_STAGES.INSPECTING_INPUT);
  throwIfAborted(signal);
  const suggestedOutputPath = captionOutputPath(inputPath, request.grouping?.orientation);
  const finalOutputPath = outputPath ?? (namingStrategy
    ? await namingStrategy({ inputPath, mode, suggestedOutputPath })
    : suggestedOutputPath);
  if (!finalOutputPath || typeof finalOutputPath !== 'string') {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Output naming strategy must return a path');
  }
  if (extname(finalOutputPath).toLowerCase() !== '.srt') {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Caption output must use the .srt extension');
  }
  if (pathsMatch(inputPath, finalOutputPath)) {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'Input and output must be different files');
  }

  return { ...request, mode, outputPath: finalOutputPath };
}

export async function generateCaptionJob(request, dependencies = {}) {
  const {
    inputPath,
    outputPath: finalOutputPath,
    overwrite = true,
    mode = 'social-media',
    grouping = {},
    signal,
    onProgress = () => {},
    onInputReady
  } = dependencies.preparedRequest ?? await prepareCaptionJob(request);

  const io = {
    readFile: dependencies.readFile ?? readFile,
    writeFile: dependencies.writeFile ?? writeFile,
    rename: dependencies.rename ?? rename,
    link: dependencies.link ?? link,
    rm: dependencies.rm ?? rm
  };
  const extract = dependencies.extractAlignedTimeline ?? extractAlignedTimeline;
  const group = dependencies.createCaptionCues ?? createCaptionCues;
  const finalize = dependencies.serializeAndValidateCues ?? serializeAndValidateCues;
  const emit = (stage, details = {}) => onProgress({ stage, ...details });
  const isSrt = extname(inputPath).toLowerCase() === '.srt';
  let input;
  if (isSrt) {
    try {
      input = await io.readFile(inputPath, 'utf8');
    } catch (error) {
      throw jobError(error, ERROR_CODES.INVALID_INPUT, `The input file could not be read: ${error.message}`);
    }
  } else if (typeof dependencies.alignedSrt === 'string') {
    input = dependencies.alignedSrt;
  } else {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, 'An existing aligned SRT transcription is required for media input.');
  }

  throwIfAborted(signal);
  onInputReady?.();
  let timeline;
  try {
    timeline = extract(input);
  } catch (error) {
    throw jobError(error, ERROR_CODES.INVALID_INPUT);
  }

  emit(JOB_STAGES.GROUPING);
  let cues;
  try {
    cues = group(timeline.words, mode, grouping);
  } catch (error) {
    throw jobError(error, ERROR_CODES.INVALID_INPUT);
  }
  throwIfAborted(signal);

  emit(JOB_STAGES.VALIDATING);
  let output;
  try {
    output = finalize(cues);
  } catch (error) {
    throw jobError(error, ERROR_CODES.INVALID_GENERATED_SRT);
  }
  throwIfAborted(signal);

  emit(JOB_STAGES.WRITING);
  const temporaryOutputPath = join(dirname(finalOutputPath), `.${basename(finalOutputPath)}.${process.pid}-${randomUUID()}.tmp`);
  // Desktop requests explicitly select a font; retain legacy SRT-only API calls.
  const styledOutputPath = grouping.fontFamily ? styledCaptionPath(finalOutputPath) : undefined;
  const temporaryStyledPath = styledOutputPath && `${temporaryOutputPath}.ttml`;
  let styledReserved = false, srtPublished = false;
  let operation = 'creating temporary file';
  try {
    await io.writeFile(temporaryOutputPath, output.srt, 'utf8');
    if (styledOutputPath) {
      await io.writeFile(temporaryStyledPath, exportTtml(cues, grouping), 'utf8');
      // Reserve a new sidecar first so a collision cannot overwrite either output.
      if (!overwrite) { await io.link(temporaryStyledPath, styledOutputPath); styledReserved = true; }
    }
    throwIfAborted(signal);
    operation = 'publishing subtitle file';
    if (overwrite) await io.rename(temporaryOutputPath, finalOutputPath);
    else {
      await io.link(temporaryOutputPath, finalOutputPath);
      operation = 'removing temporary file';
      await io.rm(temporaryOutputPath, { force: true });
    }
    srtPublished = true;
    if (styledOutputPath && overwrite) await io.rename(temporaryStyledPath, styledOutputPath);
  } catch (error) {
    await io.rm(temporaryOutputPath, { force: true }).catch(() => {});
    if (styledReserved && !srtPublished) await io.rm(styledOutputPath, { force: true }).catch(() => {});
    if (signal?.aborted || error?.name === 'AbortError') throw cancelledError(error);
    throw outputError(error, operation, finalOutputPath);
  } finally {
    if (temporaryStyledPath) await io.rm(temporaryStyledPath, { force: true }).catch(() => {});
  }

  const result = {
    inputPath,
    outputPath: finalOutputPath,
    ...(styledOutputPath ? { styledOutputPath } : {}),
    inputType: isSrt ? 'srt' : 'media',
    sourceType: timeline.sourceType,
    sourceCueCount: timeline.sourceCueCount,
    alignedWordCount: timeline.words.length,
    generatedCaptionCount: cues.length,
    layout: captionLayout(grouping.orientation, grouping.fontSize, grouping.fontFamily),
    validation: output.validation,
    cues
  };
  emit(JOB_STAGES.COMPLETE);
  return result;
}
