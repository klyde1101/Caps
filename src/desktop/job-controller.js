import { DesktopRequestError } from './ipc-contract.js';
import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';

export class JobController {
  #active;
  #completion;
  #generate;
  #queue;
  #createTranscriber;
  #now;

  constructor(generate, { createTranscriber, now = () => performance.now() } = {}) {
    this.#now = now;
    this.#generate = generate;
    this.#createTranscriber = createTranscriber;
  }

  get active() {
    return Boolean(this.#active);
  }

  async start(request, callbacks = {}) {
    return this.#execute((signal) => this.#generate({
      ...request, signal, onProgress: callbacks.onProgress, onLog: callbacks.onLog
    }));
  }

  async #execute(run) {
    if (this.#active) throw new DesktopRequestError('JOB_ACTIVE', 'A caption job is already running.');
    const controller = new AbortController();
    this.#active = controller;
    try {
      this.#completion = run(controller.signal);
      return await this.#completion;
    } finally {
      if (this.#active === controller) {
        this.#active = undefined;
        this.#completion = undefined;
      }
    }
  }

  async startQueue(requests, callbacks = {}) {
    const started = this.#now();
    const completed = await this.#execute(async (signal) => {
      const queue = { id: randomUUID(), items: [], revision: 0, accepting: true, onQueue: callbacks.onQueue };
      this.#queue = queue;
      const results = [];
      try {
        this.#append(queue, requests);
        this.#publish(queue);
        if (this.#createTranscriber) return await this.#drainDeferred(queue, signal, callbacks);
        while (true) {
          if (signal.aborted) throw Object.assign(new Error('Caption generation was cancelled.'), { code: 'CANCELLED' });
          const item = queue.items.find((entry) => entry.state === 'queued');
          if (!item) break;
          this.#setState(item, 'active');
          this.#publish(queue);
          const result = await this.#generate({
            ...item.request, signal, onLog: callbacks.onLog,
            onProgress: (event) => callbacks.onProgress?.({ ...event, queueItemId: item.id,
              fileIndex: item.index, fileEndIndex: item.index, fileCount: queue.items.length })
          });
          if (signal.aborted) throw Object.assign(new Error('Caption generation was cancelled.'), { code: 'CANCELLED' });
          this.#setState(item, 'complete');
          results.push({ ...result, processingDurationMs: item.processingDurationMs, queueItemId: item.id, inputName: basename(item.request.inputPath), mode: item.request.mode });
          this.#publish(queue);
        }
        return results;
      } catch (error) {
        for (const item of queue.items) {
          if (['active', 'awaiting-alignment', 'awaiting-export'].includes(item.state)) item.state = signal.aborted ? 'cancelled' : 'failed';
          else if (item.state === 'queued') item.state = 'cancelled';
        }
        throw error;
      } finally {
        queue.accepting = false;
        this.#publish(queue);
        if (this.#queue === queue) this.#queue = undefined;
      }
    });
    const totalElapsedMs = Math.max(0, this.#now() - started);
    return completed.map((result) => ({ ...result, totalElapsedMs }));
  }

  #setState(item, state) {
    const now = this.#now();
    if (item.activeSince !== undefined) item.processingDurationMs += Math.max(0, now - item.activeSince);
    item.activeSince = state === 'active' ? now : undefined;
    item.state = state;
  }

  async #drainDeferred(queue, signal, callbacks) {
    let transcriber;
    const results = [];
    const checkCancelled = () => {
      if (signal.aborted) throw Object.assign(new Error('Caption generation was cancelled.'), { code: 'CANCELLED' });
    };
    const progress = (item, event) => callbacks.onProgress?.({ ...event, queueItemId: item.id,
      fileIndex: item.index, fileEndIndex: item.index, fileCount: queue.items.length });
    try {
      while (true) {
        checkCancelled();
        const item = queue.items.find((entry) => entry.state === 'queued');
        if (!item) break;
        this.#setState(item, 'active');
        this.#publish(queue);
        if (extname(item.request.inputPath).toLowerCase() !== '.srt') {
          transcriber ??= await this.#createTranscriber({ ...item.request, signal,
            pendingRequests: () => queue.items.filter(entry => entry.state === 'queued' && extname(entry.request.inputPath).toLowerCase() !== '.srt').map(entry => entry.request),
            onOutput: (message, stream) => callbacks.onLog?.({ message, stream }),
            onProgress: (event) => {
              if (event.smart) { callbacks.onProgress?.(event); return; }
              const current = queue.items.find((entry) => entry.index === event.fileIndex);
              if (current) {
                if (['aligning', 'recovering', 'finishing', 'awaiting-alignment'].includes(event.phase)) {
                  const state = event.phase === 'finishing' ? 'awaiting-export'
                    : event.phase === 'awaiting-alignment' ? 'awaiting-alignment' : 'active';
                  if (current.state !== state) {
                    this.#setState(current, state);
                    this.#publish(queue);
                  }
                }
                progress(current, { ...event, stage: 'transcribing-and-aligning' });
              }
            }
          });
          await transcriber.transcribe(item.request, item.index);
          if (item.state !== 'awaiting-export') this.#setState(item, 'awaiting-alignment');
          progress(item, { stage: 'transcribing-and-aligning', phase: 'awaiting-alignment', percent: 70 });
        } else {
          this.#setState(item, 'awaiting-export');
        }
        this.#publish(queue);
      }
      // Freeze additions atomically at the recognition/alignment boundary.
      // Files appended before this boundary have already been drained above.
      queue.accepting = false;
      this.#publish(queue);
      checkCancelled();
      const aligned = new Map((transcriber ? await transcriber.align() : []).map((item) => [item.fileIndex, item.srt]));
      for (const item of queue.items) {
        checkCancelled();
        if (extname(item.request.inputPath).toLowerCase() !== '.srt' && typeof aligned.get(item.index) !== 'string') {
          throw Object.assign(new Error('The queue did not return aligned words for every media file.'), { code: 'TRANSCRIPTION_FAILED' });
        }
        this.#setState(item, 'active');
        this.#publish(queue);
        const result = await this.#generate({ ...item.request, alignedSrt: aligned.get(item.index), signal,
          onLog: callbacks.onLog, onProgress: (event) => progress(item, event) });
        checkCancelled();
        this.#setState(item, 'complete');
        results.push({ ...result, processingDurationMs: item.processingDurationMs, queueItemId: item.id, inputName: basename(item.request.inputPath), mode: item.request.mode });
        this.#publish(queue);
      }
      return results;
    } finally {
      await transcriber?.close();
    }
  }

  #append(queue, requests) {
    if (!Array.isArray(requests) || !requests.length || requests.length + queue.items.length > 100) {
      throw new DesktopRequestError('INVALID_REQUEST', 'A queue can contain up to 100 files.');
    }
    const outputs = new Set(queue.items.map((item) => item.request.outputPath.toLowerCase()));
    for (const request of requests) {
      const key = request.outputPath.toLowerCase();
      if (outputs.has(key)) throw new DesktopRequestError('OUTPUT_CONFLICT', 'This output file is already in the queue.');
      outputs.add(key);
    }
    const firstIndex = queue.items.length;
    queue.items.push(...requests.map((request, index) => ({ id: randomUUID(), index: firstIndex + index,
      request: structuredClone(request), state: 'queued', processingDurationMs: 0 })));
  }

  #editableQueue(id) {
    if (!this.#queue?.accepting || this.#queue.id !== id || this.#active?.signal.aborted) {
      throw new DesktopRequestError('QUEUE_CLOSED', 'This queue has finished or was cancelled.');
    }
    return this.#queue;
  }

  enqueue(id, requests) {
    const queue = this.#editableQueue(id);
    this.#append(queue, requests);
    return this.#publish(queue);
  }

  moveQueued(id, itemId, beforeId) {
    const queue = this.#editableQueue(id);
    const item = queue.items.find((entry) => entry.id === itemId);
    const target = beforeId === null ? null : queue.items.find((entry) => entry.id === beforeId);
    if (!item || item.state !== 'queued') throw new DesktopRequestError('QUEUE_CHANGED', 'This file has already started. Only waiting files can move.');
    if (beforeId !== null && !target) throw new DesktopRequestError('INVALID_REQUEST', 'Unknown queue position.');
    if (item === target) return this.#snapshot(queue);
    queue.items.splice(queue.items.indexOf(item), 1);
    const position = target?.state === 'queued' ? queue.items.indexOf(target)
      : target ? queue.items.findIndex((entry) => entry.state === 'queued') : -1;
    queue.items.splice(position < 0 ? queue.items.length : position, 0, item);
    return this.#publish(queue);
  }

  #snapshot(queue) {
    return { id: queue.id, revision: queue.revision, accepting: queue.accepting,
      items: queue.items.map(({ id, index, request, state }) => ({ id, index, state,
        name: basename(request.inputPath), path: request.inputPath, outputPath: request.outputPath, mode: request.mode })) };
  }

  #publish(queue) {
    queue.revision += 1;
    const snapshot = this.#snapshot(queue);
    queue.onQueue?.(snapshot);
    return snapshot;
  }

  cancel() {
    if (!this.#active) return false;
    this.#active.abort();
    if (this.#queue) { this.#queue.accepting = false; this.#publish(this.#queue); }
    return true;
  }

  async cancelAndWait() {
    if (!this.cancel()) return false;
    try {
      await this.#completion;
    } catch {
      // Cancellation is expected to reject the active job.
    }
    return true;
  }
}
