import { captionLayout } from '../captions/layout.js';
import { msToTimestamp } from '../model.js';

// Full face names retain the chosen semibold face without substituting bold.
const FACES = Object.freeze({
  'proxima-nova-semibold': 'Proxima Nova Semibold',
  'montserrat-semibold': 'Montserrat SemiBold',
  'inter-semibold': 'Inter 28pt SemiBold',
  'roboto-semibold': 'Roboto SemiBold',
  'open-sans-semibold': 'Open Sans SemiBold',
  'other-sans': 'sansSerif'
});
const xml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const time = ms => msToTimestamp(ms).replace(',', '.');
export const styledCaptionPath = srtPath => srtPath.replace(/\.srt$/i, '.ttml');

export function exportTtml(cues, options = {}) {
  const layout = captionLayout(options.orientation, options.fontSize, options.fontFamily);
  const height = { '9:16': 1920, '4:5': 1350, '16:9': 1080 }[layout.orientation];
  const lines = cues.map(cue => `      <p begin="${time(cue.start)}" end="${time(cue.end)}">${xml(cue.text).replace(/\r?\n/g, '<br/>')}</p>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="" tts:extent="${layout.frameWidth}px ${height}px">
  <head>
    <styling><style xml:id="caption" tts:fontFamily="${xml(FACES[layout.fontFamily])}" tts:fontSize="${layout.fontSize}px" tts:color="white" tts:textAlign="center"/></styling>
    <layout><region xml:id="safe" tts:origin="15% 15%" tts:extent="70% 70%" tts:displayAlign="center"/></layout>
  </head>
  <body style="caption" region="safe"><div>
${lines.join('\n')}
  </div></body>
</tt>
`;
}
