// Retain imports, not model weights, between nearby queues. Never reuse a failed
// or cancelled engine, and never let a previous queue's callbacks receive events.
export function createWarmTranscriberPool({ factory = async options =>
  (await import('./queue-transcriber.js')).createQueueTranscriber(options), idleMs = 60000,
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let cached;
  async function dispose(entry) {
    if (!entry) return;
    if (cached === entry) cached = undefined;
    unschedule(entry.timer);
    entry.controller.abort();
    await entry.engine.close();
  }
  return {
    async acquire(options = {}) {
      if (cached?.leased) throw new Error('The transcription engine is already in use.');
      const key = JSON.stringify([options.whisperxPath, options.device, options.deviceIndex, options.computeType, options.cpuThreads]);
      if (cached && cached.key !== key) await dispose(cached);
      if (!cached) {
        const entry = { key, controller: new AbortController(), options, leased: true };
        entry.engine = await factory({ ...options, signal: entry.controller.signal,
          onOutput: (...args) => entry.options?.onOutput?.(...args),
          onProgress: (...args) => entry.options?.onProgress?.(...args),
          pendingRequests: () => entry.options?.pendingRequests?.() ?? [] });
        cached = entry;
      }
      const entry = cached;
      unschedule(entry.timer);
      entry.options = options;
      entry.leased = true;
      let failed = false, closed = false;
      const abort = () => { failed = true; entry.controller.abort(options.signal?.reason); };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const call = method => async (...args) => {
        try { return await entry.engine[method](...args); }
        catch (error) { failed = true; throw error; }
      };
      return {
        transcribe: call('transcribe'), align: call('align'),
        async close() {
          if (closed) return;
          closed = true;
          options.signal?.removeEventListener('abort', abort);
          try {
            if (failed || options.signal?.aborted) { await dispose(entry); return; }
            await entry.engine.reset();
            entry.options = undefined;
            entry.leased = false;
            entry.timer = schedule(() => { void dispose(entry).catch(() => {}); }, idleMs);
            entry.timer?.unref?.();
          } catch (error) { await dispose(entry); throw error; }
        }
      };
    },
    async shutdown() { await dispose(cached); }
  };
}
