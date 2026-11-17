import { extractHighlightedWords, parseSrt } from './parsers/whisperx-srt.js';
import { socialMediaGroups } from './captions/grouping.js';
import { captionLayout } from './captions/layout.js';
import { optimizeCueTiming } from './captions/timing.js';
import { exportSrt } from './exporters/srt.js';
import { validateSrt } from './validation/srt-validator.js';

function cleanWordTimeline(sourceCues) {
  const clean = sourceCues.every((cue) => !/<[^>]+>/.test(cue.text) && cue.text.trim() && !/\s/.test(cue.text.trim()));
  if (!clean) return [];
  return sourceCues.map((cue) => ({ text: cue.text.trim(), start: cue.start, end: cue.end, sourceCue: cue.index }));
}

export function extractAlignedTimeline(input) {
  const sourceCues = parseSrt(input);
  const highlightedWords = extractHighlightedWords(sourceCues);
  const words = highlightedWords.length ? highlightedWords : cleanWordTimeline(sourceCues);
  if (!words.length) throw new Error('Input must be WhisperX highlighted SRT or a clean one-word-per-cue SRT');
  return {
    sourceType: highlightedWords.length ? 'whisperx-highlighted' : 'clean-word-timeline',
    sourceCueCount: sourceCues.length,
    words
  };
}

export function createCaptionCues(words, mode = 'social-media', options = {}) {
  if (mode !== 'social-media') throw new Error(`Unknown caption mode: ${mode}`);
  const layout = captionLayout(options.orientation, options.fontSize, options.fontFamily);
  return optimizeCueTiming(socialMediaGroups(words, layout), options.timing);
}

export function serializeAndValidateCues(cues) {
  const srt = exportSrt(cues);
  const validation = validateSrt(cues);
  if (!validation.valid) throw new Error(`Generated invalid SRT:\n${validation.errors.join('\n')}`);
  return { srt, validation };
}

export function convertWhisperxSrt(input, mode = 'social-media', options = {}) {
  const timeline = extractAlignedTimeline(input);
  const cues = createCaptionCues(timeline.words, mode, options);
  const output = serializeAndValidateCues(cues);
  return { sourceType: timeline.sourceType, sourceCueCount: timeline.sourceCueCount, wordCount: timeline.words.length, cues, ...output };
}
