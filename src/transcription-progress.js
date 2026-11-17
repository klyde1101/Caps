// Structured lines may arrive split across process-output chunks.
export function createTranscriptionProgressParser(onProgress) {
  let pending = '';
  return (text) => {
    pending += text;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (!line.startsWith('[CapsProgress] ')) continue;
      try {
        const event = JSON.parse(line.slice(15));
        if (!Number.isInteger(event.fileIndex) || event.fileIndex < 0 || !Number.isFinite(event.percent)
          || event.percent < 0 || event.percent > 100 || typeof event.phase !== 'string') continue;
        onProgress({ ...event, indeterminate: false });
      } catch { /* Ignore malformed runtime diagnostics. */ }
    }
    pending = pending.slice(-16384);
  };
}
