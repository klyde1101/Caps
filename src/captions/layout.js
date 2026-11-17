// Product presets for a caption box inside the central 70% of the frame.
// These are conservative text budgets, not pixel measurements: SRT has no font or box geometry.
import { FONT_METRICS } from './font-metrics.js';

export const DEFAULT_ORIENTATION = '9:16';
export const DEFAULT_FONT_SIZE = 60;
export const DEFAULT_CAPTION_FONT = 'proxima-nova-semibold';
export const CAPTION_FONTS = Object.freeze({
  ...Object.fromEntries(Object.entries(FONT_METRICS).map(([id, profile]) => [id, profile.label])),
  'other-sans': 'Other sans-serif (estimate)'
});
export const FONT_WIDTH_MARGIN = 1.05;
export const CAPTION_FONT_SIZES = Object.freeze([60, 65, 70]);
export const SAFE_AREA_FRACTION = 0.7;
export const CAPTION_LAYOUTS = Object.freeze({
  '9:16': Object.freeze({ label: 'Vertical', maxCharacters: 24 }),
  '4:5': Object.freeze({ label: 'Portrait', maxCharacters: 32 }),
  '16:9': Object.freeze({ label: 'Landscape', maxCharacters: 42 })
});

export function captionLayout(orientation = DEFAULT_ORIENTATION, fontSize = DEFAULT_FONT_SIZE, fontFamily = DEFAULT_CAPTION_FONT) {
  if (!Object.hasOwn(CAPTION_LAYOUTS, orientation)) throw new Error('Choose a video orientation: 9:16, 4:5, or 16:9.');
  if (!CAPTION_FONT_SIZES.includes(fontSize)) throw new Error('Choose a Premiere caption size: 60, 65, or 70.');
  if (!Object.hasOwn(CAPTION_FONTS, fontFamily)) throw new Error('Choose a supported caption font.');
  const frameWidth = orientation === '16:9' ? 1920 : 1080;
  return {
    orientation, ...CAPTION_LAYOUTS[orientation], fontSize, fontFamily, fontLabel: CAPTION_FONTS[fontFamily], frameWidth,
    maxCharacters: Math.floor(CAPTION_LAYOUTS[orientation].maxCharacters * DEFAULT_FONT_SIZE / fontSize),
    maxWidthPx: frameWidth * SAFE_AREA_FRACTION,
    safeAreaFraction: SAFE_AREA_FRACTION
  };
}

// Real advance widths with a 5% margin. No kerning/shaping or Premiere tracking is
// simulated. Unknown glyphs and other fonts use the conservative fallback below.
export function estimatedTextWidth(text, fontSize = DEFAULT_FONT_SIZE, fontFamily = DEFAULT_CAPTION_FONT) {
  const advances = FONT_METRICS[fontFamily]?.advances;
  let width = 0;
  for (const { segment } of graphemes.segment(text.normalize('NFC'))) {
    if (advances && Object.hasOwn(advances, segment)) width += advances[segment];
    else if (/^\s$/u.test(segment)) width += .28;
    else if (/^[ilI.,!':;|]$/u.test(segment)) width += .3;
    else if (/^[mwMW@%]$/u.test(segment)) width += .94;
    else if (/^[A-Z]$/u.test(segment)) width += .72;
    else if (/^[a-z0-9]$/u.test(segment)) width += .57;
    else width += 2;
  }
  return width * fontSize * FONT_WIDTH_MARGIN;
}

export function captionFits(text, layout) {
  return characterCount(text) <= layout.maxCharacters &&
    (layout.maxWidthPx === undefined || estimatedTextWidth(text, layout.fontSize, layout.fontFamily) <= layout.maxWidthPx);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
export function characterCount(text) {
  return Array.from(graphemes.segment(text)).length;
}
