import { msToTimestamp } from '../model.js';

export function exportSrt(cues) {
  return `${cues.map((cue, index) => `${index + 1}\n${msToTimestamp(cue.start)} --> ${msToTimestamp(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}
