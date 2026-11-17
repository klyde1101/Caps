import { characterCount, captionFits } from './layout.js';

function cueFromWords(words) {
  return { start: words[0].start, end: words.at(-1).end, text: words.map((word) => word.text).join(' ') };
}

// Keep every source word while choosing the most natural short thought boundary.
const UNFINISHED_ENDINGS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'to', 'of', 'for', 'in', 'on', 'at', 'with', 'that', 'this', 'is', 'are', 'was', 'were', 'can', 'could', 'would', 'should', 'will', 'have', 'has', 'had', 'not']);
const UNFINISHED_STARTS = new Set(['and', 'but', 'or', 'because', 'so', 'that', 'which', 'who']);
const SENTENCE_END = /[.!?]["'’”\)\]]*$/;
const CLAUSE_END = /[,;:]["'’”\)\]]*$/;

export function socialMediaGroups(words, { maxCharacters = 42, ...layout } = {}) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error('Caption character limit must be a positive integer.');
  if (!words.length) return [];
  const lengths = words.map((word) => characterCount(word.text));
  const count = words.length;
  const best = Array(count + 1).fill(Number.POSITIVE_INFINITY);
  const next = Array(count).fill(count);
  best[count] = 0;
  for (let start = count - 1; start >= 0; start -= 1) {
    // A word cannot be shortened without changing the transcript. Isolate it,
    // keep its aligned timing, and continue enforcing the budget for other cues.
    if (!captionFits(words[start].text, { ...layout, maxCharacters })) {
      best[start] = best[start + 1] + 40;
      next[start] = start + 1;
      continue;
    }
    let characters = 0;
    for (let size = 1; size <= 5 && start + size <= count; size += 1) {
      if (size > 1) {
        const previous = words[start + size - 2];
        const current = words[start + size - 1];
        // A short caption is preferable to showing the next sentence during a
        // pause. Character/word budgets must never merge across these boundaries.
        if (SENTENCE_END.test(previous.text) || CLAUSE_END.test(previous.text) || current.start - previous.end >= 450) break;
      }
      characters += lengths[start + size - 1] + (size > 1 ? 1 : 0);
      if (characters > maxCharacters) break;
      const end = start + size;
      if (!captionFits(words.slice(start, end).map(word => word.text).join(' '), { ...layout, maxCharacters })) break;
      if (!Number.isFinite(best[end])) continue;
      const last = words[end - 1];
      const key = last.text.toLowerCase().replace(/[^a-z']/g, '');
      const following = words[end]?.text.toLowerCase().replace(/[^a-z']/g, '');
      const gap = end < count ? words[end].start - last.end : 0;
      const duration = last.end - words[start].start;
      let cost = best[end] + Math.abs(size - 4) * 2;
      // Prefer 3–5 words, but a hard character limit takes priority.
      if (size < 3) cost += (3 - size) * 40;
      if (UNFINISHED_ENDINGS.has(key)) cost += 18;
      if (UNFINISHED_STARTS.has(following)) cost += 7;
      if (SENTENCE_END.test(last.text)) cost -= 12;
      else if (CLAUSE_END.test(last.text)) cost -= 5;
      if (gap >= 450) cost -= 3;
      if (duration > 3000) cost += (duration - 3000) / 250;
      if (cost < best[start]) { best[start] = cost; next[start] = end; }
    }
  }
  const cues = [];
  for (let start = 0; start < count; start = next[start]) cues.push(cueFromWords(words.slice(start, next[start])));
  return cues;
}
