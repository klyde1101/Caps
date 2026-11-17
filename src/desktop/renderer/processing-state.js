export function processingStep(stage) {
  if (['complete', 'writing-output', 'validating', 'grouping-captions', 'awaiting-export'].includes(stage)) return 'export';
  if (['aligning', 'awaiting-alignment', 'recovering', 'finishing'].includes(stage)) return 'align';
  if (['transcribing', 'transcribing-and-aligning'].includes(stage)) return 'transcribe';
  return 'prepare';
}

export function queueRowPhase(item, queueState) {
  if (queueState === 'complete' || item.percent === 100) return 'complete';
  if (queueState === 'failed') return 'failed';
  if (queueState === 'queued') return 'queued';
  // Queue membership can remain awaiting-alignment throughout the deferred pass.
  // Once telemetry starts that pass, its stage is the current source of truth.
  const alignmentStarted = ['aligning', 'recovering', 'finishing', 'grouping-captions', 'validating', 'writing-output'].includes(item.stage);
  if (item.stage === 'awaiting-alignment' || queueState === 'awaiting-alignment' && !alignmentStarted) return 'awaiting-alignment';
  return 'active';
}
