import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTION_LAYOUTS, CAPTION_FONT_SIZES, CAPTION_FONTS, captionLayout, characterCount, captionFits, estimatedTextWidth } from '../src/captions/layout.js';
import { createCaptionCues } from '../src/pipeline.js';
import { exportSrt } from '../src/exporters/srt.js';
import { parseSrt } from '../src/parsers/whisperx-srt.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';
import { validateSettings, validateStartRequest } from '../src/desktop/ipc-contract.js';
import { createSettingsStore } from '../src/desktop/settings-store.js';

const words = (text) => text.split(' ').map((text, i) => ({ text, start: i * 500, end: i * 500 + 400 }));

test('every orientation enforces its limit without losing words, punctuation, or aligned boundaries', () => {
  const source = words('Extraordinary storytelling creates unforgettable experiences. Make every single moment count, together!');
  const counts = [];
  for (const [orientation, { maxCharacters }] of Object.entries(CAPTION_LAYOUTS)) {
    const cues = createCaptionCues(source, 'social-media', { orientation });
    assert.ok(cues.every((cue) => characterCount(cue.text) <= maxCharacters));
    assert.equal(cues.map((cue) => cue.text).join(' '), source.map((word) => word.text).join(' '));
    assert.equal(cues[0].start, source[0].start);
    assert.equal(cues.at(-1).end, source.at(-1).end);
    assert.ok(cues.every((cue, i) => !i || cue.start >= cues[i - 1].end));
    assert.deepEqual(parseSrt(exportSrt(cues)).map((cue) => cue.text), cues.map((cue) => cue.text));
    counts.push(cues.length);
  }
  assert.ok(counts[0] > counts[2]);
});

test('character budgets include punctuation and spaces and count grapheme clusters', () => {
  assert.equal(characterCount('Cafe\u0301 👩‍💻!'), 7);
  const text = 'i'.repeat(11) + ' ' + 'l'.repeat(11) + '!';
  assert.equal(createCaptionCues(words(text))[0].text, text);
  const cues = createCaptionCues(words(text + '!'));
  assert.equal(cues.length, 2);
  assert.ok(cues.every((cue) => characterCount(cue.text) <= 24));
  assert.deepEqual(createCaptionCues([]), []);
});

test('all fonts, sizes and orientations enforce width and keep word-aligned timing', () => {
  const source = words('WWW marketing worldwide feels extraordinary, and it works well.');
  for (const fontFamily of Object.keys(CAPTION_FONTS)) {
  for (const orientation of Object.keys(CAPTION_LAYOUTS)) {
    for (const fontSize of CAPTION_FONT_SIZES) {
      const layout = captionLayout(orientation, fontSize, fontFamily);
      const cues = createCaptionCues(source, 'social-media', { orientation, fontSize, fontFamily, timing: { bridgeGapMs: 0 } });
      assert.equal(cues.map(cue => cue.text).join(' '), source.map(word => word.text).join(' '));
      let index = 0;
      for (const cue of cues) {
        const count = cue.text.split(' ').length;
        assert.ok(captionFits(cue.text, layout) || count === 1);
        assert.equal(cue.start, source[index].start);
        assert.equal(cue.end, source[index + count - 1].end);
        index += count;
      }
      assert.deepEqual(parseSrt(exportSrt(cues)).map(cue => cue.text), cues.map(cue => cue.text));
    }
  }
  }
});

test('measured Proxima and Montserrat advances change grouping at the same size', () => {
  assert.ok(Math.abs(estimatedTextWidth('W', 65, 'proxima-nova-semibold') - .903 * 65 * 1.05) < .001);
  assert.ok(Math.abs(estimatedTextWidth('W', 65, 'montserrat-semibold') - 1.144 * 65 * 1.05) < .001);
  const source = words('WWW WWW WWW');
  assert.equal(createCaptionCues(source, 'social-media', { fontSize: 70, fontFamily: 'proxima-nova-semibold' }).length, 1);
  assert.ok(createCaptionCues(source, 'social-media', { fontSize: 70, fontFamily: 'montserrat-semibold' }).length > 1);
  assert.equal(estimatedTextWidth('Café'), estimatedTextWidth('Cafe\u0301'));
});

test('unsupported fonts are rejected before transcription', async () => {
  for (const fontFamily of ['__proto__', '', null, 65, 'unknown']) {
    assert.throws(() => validateSettings({ fontFamily }), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', grouping: { fontFamily } }), { code: 'INVALID_REQUEST' });
    let transcribed = false;
    await assert.rejects(generateCaptionBatchJob({ requests: [{ inputPath: 'clip.mp4', grouping: { fontFamily } }] }, {
      transcribeMediaBatch: async () => { transcribed = true; }
    }), { code: 'INVALID_INPUT' });
    assert.equal(transcribed, false);
  }
});

test('font size and actual letters affect capacity even for equal word and character counts', () => {
  assert.ok(estimatedTextWidth('WWW WWW', 65) > estimatedTextWidth('iii iii', 65));
  assert.ok(captionFits('WWW WWW WWW WWW', captionLayout('9:16', 60)));
  assert.equal(captionFits('WWW WWW WWW WWW', captionLayout('9:16', 70)), false);
  assert.ok(createCaptionCues(words('WWW WWW WWW WWW'), 'social-media', { fontSize: 70 }).length >
    createCaptionCues(words('WWW WWW WWW WWW'), 'social-media', { fontSize: 60 }).length);
});

test('invalid font sizes fail before transcription at IPC and batch boundaries', async () => {
  for (const fontSize of [0, 64, '65', null, NaN]) {
    assert.throws(() => validateSettings({ fontSize }), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', grouping: { fontSize } }), { code: 'INVALID_REQUEST' });
    let transcribed = false;
    await assert.rejects(generateCaptionBatchJob({ requests: [{ inputPath: 'clip.mp4', grouping: { fontSize } }] }, {
      transcribeMediaBatch: async () => { transcribed = true; }
    }), { code: 'INVALID_INPUT' });
    assert.equal(transcribed, false);
  }
});

test('an oversized single word is kept intact in its own caption for every orientation', () => {
  for (const [orientation, { maxCharacters }] of Object.entries(CAPTION_LAYOUTS)) {
    const longWord = 'x'.repeat(maxCharacters + 1) + '!';
    const source = words(`Before this ${longWord} after that.`);
    const cues = createCaptionCues(source, 'social-media', { orientation, timing: { bridgeGapMs: 0 } });
    const isolated = cues.find((cue) => cue.text === longWord);
    assert.ok(isolated);
    assert.equal(isolated.start, source[2].start);
    assert.equal(isolated.end, source[2].end);
    assert.equal(cues.map((cue) => cue.text).join(' '), source.map((word) => word.text).join(' '));
    assert.ok(cues.every((cue) => characterCount(cue.text) <= maxCharacters || cue.text === longWord));
    assert.ok(cues.every((cue, index) => index === 0 || cue.start >= cues[index - 1].end));
  }
});

test('consecutive oversized Unicode words at the start and end never swallow adjacent words', () => {
  const longWord = '👩‍💻'.repeat(25);
  const source = words(`${longWord} ${'a'.repeat(50)} normal words ${longWord}`);
  const cues = createCaptionCues(source);
  assert.equal(cues.map((cue) => cue.text).join(' '), source.map((word) => word.text).join(' '));
  assert.equal(cues[0].text, longWord);
  assert.equal(cues[1].text, 'a'.repeat(50));
  assert.equal(cues.at(-1).text, longWord);
  assert.ok(cues.every((cue) => characterCount(cue.text) <= 24 || !/\s/u.test(cue.text)));
});

test('media and SRT batches export successfully when a source word exceeds the layout budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caps-long-word-'));
  try {
    const source = words('Hello antidisestablishmentarianism goodbye.');
    const input = exportSrt(source);
    const srtPath = join(directory, 'source.srt');
    await writeFile(srtPath, input);
    const results = await generateCaptionBatchJob({ requests: [
      { inputPath: srtPath, outputPath: join(directory, 'srt-output.srt') },
      { inputPath: join(directory, 'source.mp4'), outputPath: join(directory, 'media-output.srt') }
    ] }, { transcribeMediaBatch: async () => [{ srt: input }] });
    for (const result of results) {
      assert.equal(result.validation.valid, true);
      const captions = parseSrt(await readFile(result.outputPath, 'utf8'));
      assert.equal(captions.map((cue) => cue.text).join(' '), source.map((word) => word.text).join(' '));
      assert.ok(captions.some((cue) => cue.text === 'antidisestablishmentarianism'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid orientation is rejected at both IPC and batch boundaries before transcription', async () => {
  for (const orientation of ['1:1', '', null, 16, '__proto__']) {
    assert.throws(() => validateSettings({ orientation }), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', grouping: { orientation } }), { code: 'INVALID_REQUEST' });
  }
  let transcribed = false;
  await assert.rejects(generateCaptionBatchJob({ requests: [
    { inputPath: 'C:\\Media\\first.mp4' },
    { inputPath: 'C:\\Media\\second.mp4', grouping: { orientation: '1:1' } }
  ] }, { transcribeMediaBatch: async () => { transcribed = true; } }), { code: 'INVALID_INPUT' });
  assert.equal(transcribed, false);
});

test('settings migrate missing orientation and persist the selected orientation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caps-layout-settings-'));
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ device: 'cpu' }));
    const store = createSettingsStore(directory);
    assert.equal((await store.read()).orientation, '9:16');
    assert.equal((await store.read()).fontSize, 60);
    assert.equal((await store.read()).fontFamily, 'proxima-nova-semibold');
    await store.save({ ...(await store.read()), orientation: '16:9', fontSize: 70, fontFamily: 'montserrat-semibold' });
    assert.equal((await store.read()).orientation, '16:9');
    assert.equal((await store.read()).device, 'cpu');
    assert.equal((await store.read()).fontSize, 60);
    assert.equal((await store.read()).fontFamily, 'proxima-nova-semibold');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('mixed audio, video, and SRT jobs export their own selected caption layout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caps-layout-jobs-'));
  try {
    const source = exportSrt(words('Extraordinary storytelling creates unforgettable experiences.'));
    const requests = Object.keys(CAPTION_LAYOUTS).map((orientation, i) => ({
      inputPath: join(directory, `input-${i}${['.mp3', '.mp4', '.srt'][i]}`),
      outputPath: join(directory, `output-${i}.srt`), grouping: { orientation, fontSize: CAPTION_FONT_SIZES[i], fontFamily: Object.keys(CAPTION_FONTS)[i] }
    }));
    await writeFile(requests[2].inputPath, source);
    const results = await generateCaptionBatchJob({ requests }, {
      transcribeMediaBatch: async (paths) => paths.map(() => ({ srt: source }))
    });
    for (let i = 0; i < results.length; i += 1) {
      const layout = captionLayout(requests[i].grouping.orientation, requests[i].grouping.fontSize, requests[i].grouping.fontFamily);
      assert.deepEqual(results[i].layout, layout);
      const cues = parseSrt(await readFile(results[i].outputPath, 'utf8'));
      assert.ok(cues.every((cue) => characterCount(cue.text) <= layout.maxCharacters));
      assert.equal(cues.map((cue) => cue.text).join(' '), 'Extraordinary storytelling creates unforgettable experiences.');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
