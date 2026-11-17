import { basename, extname } from 'node:path';
import { generateCaptionJob, prepareCaptionJob, JOB_STAGES } from './generate-caption-job.js';
import { defaultModel, transcribeMediaBatch } from '../transcription-runner.js';
import { ERROR_CODES, cancelledError, jobError } from '../errors.js';
import { captionLayout } from '../captions/layout.js';
import { createQueueTranscriber } from '../queue-transcriber.js';

const MAX_REUSED_MODEL_FILES = 10;

function transcriptionKey(request) {
  return JSON.stringify([
    request.language,
    request.model,
    request.whisperxPath,
    request.device,
    request.deviceIndex,
    request.computeType
  ]);
}

function mediaChunk(requests, start) {
  const first = requests[start];
  if (extname(first.inputPath).toLowerCase() === '.srt') return [];
  const key = transcriptionKey(first);
  const stems = new Set();
  const chunk = [];
  for (let index = start; index < requests.length && chunk.length < MAX_REUSED_MODEL_FILES; index += 1) {
    const request = requests[index];
    if (extname(request.inputPath).toLowerCase() === '.srt' || transcriptionKey(request) !== key) break;
    const stem = basename(request.inputPath, extname(request.inputPath)).toLowerCase();
    if (stems.has(stem)) break;
    stems.add(stem);
    chunk.push(request);
  }
  return chunk;
}

export async function generateCaptionBatchJob(batch, dependencies = {}) {
  // A single request uses the same batch execution while retaining its public result/events.
  const singleRequest = !Object.hasOwn(batch ?? {}, 'requests');
  const preparedRequest = singleRequest ? await prepareCaptionJob(batch) : undefined;
  const requests = singleRequest ? [preparedRequest] : batch?.requests;
  if (!Array.isArray(requests) || !requests.length) throw new TypeError('A non-empty requests array is required.');
  // Validate all layout choices before any expensive media transcription starts.
  try { for (const request of requests) captionLayout(request.grouping?.orientation, request.grouping?.fontSize, request.grouping?.fontFamily); }
  catch (error) { throw jobError(error, ERROR_CODES.INVALID_INPUT); }
  const transcribeBatch = dependencies.transcribeMediaBatch ?? transcribeMediaBatch;
  const generate = dependencies.generateCaptionJob ?? generateCaptionJob;
  const finalizeResult = dependencies.finalizeResult ?? ((result) => result);
  const results = [];
  const onProgress = batch.onProgress ?? (() => {});
  const onLog = batch.onLog ?? (() => {});
  const checkCancelled = () => {
    if (batch.signal?.aborted) throw cancelledError(batch.signal.reason);
  };
  const progressFor = (fileIndex, fileEndIndex = fileIndex) => (progress) => onProgress(singleRequest ? progress : {
    ...progress, fileIndex, fileEndIndex, fileCount: requests.length
  });

  // Production media batches share the same deferred alignment path as the live queue.
  if (!dependencies.transcribeMediaBatch && requests.some((request) => extname(request.inputPath).toLowerCase() !== '.srt')) {
    let worker;
    let transcriptionIndex = -1;
    try {
      checkCancelled();
      worker = await (dependencies.createQueueTranscriber ?? createQueueTranscriber)({ ...requests[0], signal: batch.signal,
        pendingRequests: () => requests.slice(transcriptionIndex + 1).filter(request => extname(request.inputPath).toLowerCase() !== '.srt'),
        onOutput: (message, stream = 'stdout') => { batch.onTranscriptionOutput?.(message); onLog({ message, stream }); },
        onProgress: ({ fileIndex, ...event }) => progressFor(fileIndex)({ ...event, stage: JOB_STAGES.TRANSCRIBING })
      });
      for (let index = 0; index < requests.length; index += 1) {
        checkCancelled();
        if (extname(requests[index].inputPath).toLowerCase() === '.srt') continue;
        progressFor(index)({ stage: JOB_STAGES.LOCATING_WHISPERX });
        transcriptionIndex = index;
        await worker.transcribe(requests[index], index);
      }
      checkCancelled();
      const aligned = new Map((await worker.align()).map((item) => [item.fileIndex, item.srt]));
      for (let index = 0; index < requests.length; index += 1) {
        checkCancelled();
        if (extname(requests[index].inputPath).toLowerCase() !== '.srt' && !aligned.has(index)) throw new Error('Missing aligned result');
        const request = { ...requests[index], signal: batch.signal, onProgress: progressFor(index), onLog };
        const result = await generate(request, { ...dependencies, preparedRequest: singleRequest ? request : undefined, alignedSrt: aligned.get(index) });
        results.push(await finalizeResult(result));
      }
      return singleRequest ? results[0] : results;
    } catch (error) {
      if (batch.signal?.aborted || error?.name === 'AbortError') throw cancelledError(error);
      throw jobError(error, ERROR_CODES.TRANSCRIPTION_FAILED);
    } finally { await worker?.close(); }
  }

  for (let index = 0; index < requests.length;) {
    checkCancelled();
    const chunk = mediaChunk(requests, index);
    if (chunk.length) {
      const first = chunk[0];
      const progress = progressFor(index, index + chunk.length - 1);
      progress({ stage: JOB_STAGES.LOCATING_WHISPERX });
      checkCancelled();
      progress({ stage: JOB_STAGES.TRANSCRIBING, indeterminate: true });
      let transcriptions;
      try {
        transcriptions = await transcribeBatch(chunk.map((request) => request.inputPath), {
          whisperxPath: first.whisperxPath,
          language: first.language ?? 'en',
          model: first.model ?? defaultModel(),
          device: first.device,
          deviceIndex: first.deviceIndex,
          computeType: first.computeType,
          signal: batch.signal,
          onProgress: (event) => {
            if (Number.isInteger(event.fileIndex) && event.fileIndex >= 0 && event.fileIndex < chunk.length) {
              const { fileIndex: localIndex, ...details } = event;
              progressFor(index + localIndex)({ ...details, stage: JOB_STAGES.TRANSCRIBING });
            } else {
              progress({ ...event, stage: JOB_STAGES.TRANSCRIBING });
            }
          },
          pendingRequests: () => requests.slice(transcriptionIndex + 1).filter(request => extname(request.inputPath).toLowerCase() !== '.srt'),
        onOutput: (message, stream = 'stdout') => {
            batch.onTranscriptionOutput?.(message);
            onLog({ message, stream });
          }
        });
      } catch (error) {
        if (batch.signal?.aborted || error?.name === 'AbortError') throw cancelledError(error);
        throw jobError(error, ERROR_CODES.TRANSCRIPTION_FAILED);
      }
      for (let offset = 0; offset < chunk.length; offset += 1) {
        checkCancelled();
        const fileIndex = index + offset;
        const request = {
          ...chunk[offset],
          signal: batch.signal,
          onProgress: progressFor(fileIndex),
          onLog
        };
        const result = await generate(request, {
          ...dependencies,
          preparedRequest: singleRequest ? request : undefined,
          alignedSrt: transcriptions[offset].srt
        });
        results.push(await finalizeResult(result));
      }
      index += chunk.length;
      continue;
    }

    const request = {
      ...requests[index],
      signal: batch.signal,
      onProgress: progressFor(index),
      onLog
    };
    const result = await generate(request, { ...dependencies, preparedRequest: singleRequest ? request : undefined });
    results.push(await finalizeResult(result));
    index += 1;
  }
  return singleRequest ? results[0] : results;
}
