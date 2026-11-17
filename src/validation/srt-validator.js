import { parseSrt } from '../parsers/whisperx-srt.js';
import { stripTags } from '../model.js';

export function validateSrt(input) {
  const cues = typeof input === 'string' ? parseSrt(input) : input;
  const errors = [];
  cues.forEach((cue, index) => {
    if (cue.index != null && cue.index !== index + 1) errors.push(`Cue ${index + 1} has non-sequential index ${cue.index}`);
    if (cue.end <= cue.start) errors.push(`Cue ${index + 1} has zero or negative duration`);
    if (!stripTags(cue.text)) errors.push(`Cue ${index + 1} is empty`);
    if (/<\/?u\b/i.test(cue.text)) errors.push(`Cue ${index + 1} contains underline markup`);
    if (index > 0 && cue.start < cues[index - 1].end) errors.push(`Cue ${index + 1} overlaps cue ${index}`);
  });
  return { valid: errors.length === 0, errors, cueCount: cues.length };
}
