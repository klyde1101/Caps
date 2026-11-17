import { stripTags, timestampToMs } from '../model.js';

const TIME_LINE = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/;
const UNDERLINED = /<u\b[^>]*>([\s\S]*?)<\/u>/gi;

export function parseSrt(input) {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  return normalized.split(/\n{2,}/).map((block, position) => {
    const lines = block.split('\n');
    let cursor = 0;
    const parsedIndex = /^\d+$/.test(lines[0]?.trim()) ? Number(lines[cursor++].trim()) : position + 1;
    const timeMatch = TIME_LINE.exec(lines[cursor]?.trim() ?? '');
    if (!timeMatch) throw new Error(`Malformed SRT cue ${parsedIndex}: missing or invalid timestamp line`);
    const start = timestampToMs(timeMatch[1]);
    const end = timestampToMs(timeMatch[2]);
    if (end <= start) throw new Error(`Malformed SRT cue ${parsedIndex}: end must be after start`);
    const text = lines.slice(cursor + 1).join('\n').trim();
    if (!text) throw new Error(`Malformed SRT cue ${parsedIndex}: empty text`);
    return { index: parsedIndex, start, end, text };
  });
}

export function extractHighlightedWords(input) {
  const cues = typeof input === 'string' ? parseSrt(input) : input;
  const words = [];

  for (const cue of cues) {
    UNDERLINED.lastIndex = 0;
    let match;
    while ((match = UNDERLINED.exec(cue.text)) !== null) {
      const text = stripTags(match[1]);
      if (text) words.push({ text, start: cue.start, end: cue.end, sourceCue: cue.index });
    }
  }

  for (let i = 1; i < words.length; i += 1) {
    if (words[i].start < words[i - 1].start) {
      throw new Error(`Highlighted word timeline is not chronological near source cue ${words[i].sourceCue}`);
    }
  }
  return words;
}
