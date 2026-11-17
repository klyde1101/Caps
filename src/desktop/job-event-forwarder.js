const LOG_FLUSH_MS = 75;
const PROGRESS_FLUSH_MS = 100;
const MAX_LOG_BATCH = 32768;

export function createJobEventForwarder(send, timers = {}) {
  const schedule = timers.setTimeout ?? setTimeout;
  const cancel = timers.clearTimeout ?? clearTimeout;
  let logText = '';
  let logTimer;
  let progressTimer;
  let pendingProgress;
  let lastStage;

  const flushLog = () => {
    if (logTimer) cancel(logTimer);
    logTimer = undefined;
    if (!logText) return;
    const message = logText;
    logText = '';
    send('log', { message, stream: 'mixed' });
  };
  const flushProgress = () => {
    if (progressTimer) cancel(progressTimer);
    progressTimer = undefined;
    if (!pendingProgress) return;
    const progress = pendingProgress;
    pendingProgress = undefined;
    send('progress', progress);
  };

  return {
    log(entry) {
      logText += entry.message;
      if (logText.length >= MAX_LOG_BATCH) flushLog();
      else if (!logTimer) logTimer = schedule(flushLog, LOG_FLUSH_MS);
    },
    progress(event) {
      const key = `${event.stage}:${event.fileIndex}:${event.phase}`;
      const stageChanged = key !== lastStage;
      lastStage = key;
      if (stageChanged || event.percent === 100 || event.percent === undefined) {
        flushProgress();
        send('progress', event);
        return;
      }
      pendingProgress = event;
      if (!progressTimer) progressTimer = schedule(flushProgress, PROGRESS_FLUSH_MS);
    },
    flush() {
      flushProgress();
      flushLog();
    }
  };
}
