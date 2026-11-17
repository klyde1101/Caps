// Percentages reserve the final 5% for validation and publishing the subtitle file.
const stages = { 'inspecting-input': 0, 'locating-whisperx': 0, 'grouping-captions': 95, validating: 97, 'writing-output': 99, complete: 100 };

export function createProgressTracker(files, now = Date.now()) {
  const items = files.map((file) => ({ name: file.name, percent: 0, stage: 'queued', startedAt: null, sampleAt: null, samplePercent: 0, rate: null, latestAt: now }));
  let sampleAt = now;
  let samplePercent = 0;
  let rate = null;
  let latestAt = now;
  let latestPercent = 0;

  function update(event, time = Date.now()) {
    const first = Number.isInteger(event.fileIndex) ? event.fileIndex : 0;
    const last = Number.isInteger(event.fileEndIndex) ? event.fileEndIndex : first;
    for (let index = first; index <= last && index < items.length; index += 1) {
      const item = items[index];
      if (!item || item.percent === 100) continue;
      if (item.startedAt === null) item.startedAt = time;
      if (event.fallback) {
        item.rate = null; item.sampleAt = null;
        rate = null; sampleAt = time; samplePercent = totalPercent();
      }
      // A range identifies model preparation only. Never copy one file's % to its neighbours.
      if (last > first && event.stage === 'transcribing-and-aligning') {
        item.stage = 'preparing';
        continue;
      }
      item.stage = event.phase ?? event.stage;
      let percent = stages[event.stage];
      if (event.stage === 'transcribing-and-aligning' && Number.isFinite(event.percent) && last === first && !event.indeterminate) {
        percent = Math.min(95, Math.max(0, event.percent));
      }
      if (Number.isFinite(percent) && percent > item.percent) {
        item.percent = percent;
        item.latestAt = time;
      }
      // Estimate from observed advances, excluding initial model loading.
      if (item.percent > 0 && item.sampleAt === null) {
        item.sampleAt = time; item.samplePercent = item.percent;
      } else if (item.percent > item.samplePercent && time - item.sampleAt >= 1500) {
        item.rate = (item.percent - item.samplePercent) / (time - item.sampleAt);
      }
    }
    const percent = totalPercent();
    if (percent > samplePercent && time - sampleAt >= 3000) rate = (percent - samplePercent) / (time - sampleAt);
    if (percent > latestPercent) { latestAt = time; latestPercent = percent; }
  }

  function totalPercent() { return items.reduce((sum, item) => sum + item.percent, 0) / Math.max(1, items.length); }

  function snapshot(time = Date.now()) {
    const percent = totalPercent();
    const stalled = time - latestAt > 30000;
    const remaining = percent === 100 ? 0 : rate && !stalled ? Math.max(1000, (100 - percent) / rate - (time - latestAt)) : null;
    return {
      percent, remaining, completed: items.filter((item) => item.percent === 100).length,
      items: items.map((item) => ({ ...item,
        remaining: item.percent === 100 ? 0 : item.rate && time - item.latestAt <= 30000
          ? Math.max(1000, (100 - item.percent) / item.rate - (time - item.latestAt)) : null
      }))
    };
  }
  function syncFiles(files, time = Date.now()) {
    if (files.length === items.length) return;
    if (files.length < items.length) throw new Error('Queued files cannot be removed from progress history.');
    for (const file of files.slice(items.length)) {
      items.push({ name: file.name, percent: 0, stage: 'queued', startedAt: null, sampleAt: null,
        samplePercent: 0, rate: null, latestAt: time });
    }
    // More work changes the denominator. Re-estimate without discarding per-file progress.
    rate = null; sampleAt = time; samplePercent = totalPercent(); latestPercent = samplePercent; latestAt = time;
  }
  return { update, snapshot, syncFiles };
}

export function formatRemaining(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'Estimating…';
  if (ms <= 0) return 'Complete';
  if (ms < 60000) return 'Less than a minute left';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `About ${minutes} min left`;
  return `About ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}
