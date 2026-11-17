export function optimizeCueTiming(cues, options = {}) {
  const { minDurationMs = 100, bridgeGapMs = 80 } = options;
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    let end = Math.max(cue.end, cue.start + minDurationMs);
    if (next) {
      const gap = next.start - end;
      if (gap >= 0 && gap <= bridgeGapMs) end = next.start;
      end = Math.min(end, next.start);
    }
    if (end <= cue.start) throw new Error(`Cannot create positive duration for cue ${index + 1}`);
    return { ...cue, end };
  });
}
