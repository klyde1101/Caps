import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socialMediaGroups } from '../src/captions/grouping.js';
import { validateStartRequest } from '../src/desktop/ipc-contract.js';
import { createSettingsStore } from '../src/desktop/settings-store.js';
import { buildWhisperxArgs, transcribeMedia } from '../src/whisperx-runner.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';

function timeline(text) {
  return text.split(' ').map((word, index) => ({ text: word, start: index * 300, end: index * 300 + 220 }));
}

test('Social Media captions keep all words and existing sentence punctuation', () => {
  const words = timeline('This product feels amazing. It works well for everyone.');
  const cues = socialMediaGroups(words);
  assert.deepEqual(cues.map((cue) => cue.text), ['This product feels amazing.', 'It works well for everyone.']);
  assert.ok(cues.every((cue) => cue.text.split(' ').length >= 3 && cue.text.split(' ').length <= 5));
  assert.ok(cues.every((cue) => /[.!?]$/.test(cue.text)));
});

test('Social Media grouping avoids dangling connectors and handles very short recordings', () => {
  const cues = socialMediaGroups(timeline('We made this for you and your friends today.'));
  assert.ok(cues.every((cue) => !/\b(and|for|the|a)[.!?]?$/i.test(cue.text)));
  assert.deepEqual(socialMediaGroups(timeline('Hello there')).map((cue) => cue.text), ['Hello there']);
});

test('caption breaks preserve commas without adding sentence endings', () => {
  const text = 'When you are ready, we can get started';
  const cues = socialMediaGroups(timeline(text));
  assert.deepEqual(cues.map((cue) => cue.text), ['When you are ready,', 'we can get started']);
  assert.equal(cues.map((cue) => cue.text).join(' '), text);
});

test('grouping preserves source punctuation and timing at every boundary', () => {
  for (const ending of ['', ',', ';', ':', '.', '!', '?', ',"', '."', ',”', '…”']) {
    const words = timeline(`These are four words${ending} Here are four more`);
    const cues = socialMediaGroups(words);
    assert.equal(cues.map((cue) => cue.text).join(' '), words.map((word) => word.text).join(' '));
    assert.equal(cues[0].start, words[0].start);
    assert.equal(cues.at(-1).end, words.at(-1).end);
  }
  assert.deepEqual(socialMediaGroups([]), []);
});

test('short sentences do not reveal the next phrase before it is spoken', () => {
  const words = [
    { text: 'right?', start: 2873, end: 3027 },
    { text: 'Okay,', start: 4008, end: 4300 },
    { text: 'I', start: 4350, end: 4450 },
    { text: 'should', start: 4500, end: 4700 },
    { text: 'be', start: 4750, end: 4934 }
  ];
  const cues = socialMediaGroups(words, { maxCharacters: 24 });
  assert.equal(cues[0].text, 'right?');
  assert.equal(cues[0].end, 3027);
  assert.equal(cues[1].text, 'Okay,');
  assert.equal(cues[1].start, 4008);
  assert.equal(cues[2].text, 'I should be');
  assert.equal(cues[2].start, 4350);
});

test('commas always end cues, including short clauses and closing quotes', () => {
  for (const text of ['Yes, it works.', 'Wait,” then go.', 'One, two, three.', 'Pay 1,000 dollars, today.']) {
    const cues = socialMediaGroups(timeline(text));
    assert.equal(cues.map(cue => cue.text).join(' '), text);
    for (const cue of cues) assert.equal(cue.text.split(' ').slice(0, -1).some(word => /,["’”]*$/.test(word)), false);
  }
});

test('speech pauses split captions even without punctuation and within character limits', () => {
  const words = timeline('Hello there Welcome back');
  for (const word of words.slice(2)) { word.start += 700; word.end += 700; }
  const cues = socialMediaGroups(words, { maxCharacters: 42 });
  assert.deepEqual(cues.map(cue => cue.text), ['Hello there', 'Welcome back']);
  assert.equal(cues[1].start, words[2].start);
  assert.equal(cues[0].end, words[1].end);
  assert.deepEqual(socialMediaGroups(timeline('Ready? Yes. Go!')) .map(cue => cue.text), ['Ready?', 'Yes.', 'Go!']);
});

test('only Social Media is accepted and saved settings migrate old modes', async () => {
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', mode: 'dynamic' }), { code: 'INVALID_REQUEST' });
  assert.equal(validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', mode: 'social-media' }).mode, 'social-media');
  const directory = await mkdtemp(join(tmpdir(), 'caps-social-'));
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ mode: 'dynamic', device: 'cuda', model: 'small', dynamic: { maxWords: 4 } }));
    const settings = await createSettingsStore(directory).read();
    assert.equal(settings.mode, 'social-media');
    assert.equal(settings.model, 'small');
    assert.equal(settings.device, 'cuda');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('transcription rejects the retired Canary model before loading it', async () => {
  assert.throws(() => buildWhisperxArgs('clip.mp4', 'out', { model: 'canary-qwen-2.5b', device: 'cuda' }), { code: 'INVALID_INPUT' });
  assert.throws(() => buildWhisperxArgs('clip.mp4', 'out', { model: 'canary-qwen-2.5b', device: 'cpu' }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', model: 'canary-qwen-2.5b' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(transcribeMedia('clip.mp4', {
    model: 'canary-qwen-2.5b', device: 'cuda', whisperxPath: process.execPath,
    inspectWhisperxRuntime: async () => ({ cudaSupport: 'supported' }),
    runProcess: async () => { throw new Error('must not start'); }
  }), { code: 'INVALID_INPUT' });
});

test('one model process serves ten compatible media files', async () => {
  const requests = Array.from({ length: 10 }, (_, index) => ({
    inputPath: `C:\\Media\\clip-${index}.mp4`, outputPath: `C:\\Media\\clip-${index}.srt`,
    mode: 'social-media', model: 'large-v3-turbo', device: 'cuda'
  }));
  let calls = 0;
  const results = await generateCaptionBatchJob({ requests }, {
    transcribeMediaBatch: async (paths) => { calls += 1; return paths.map(() => ({ srt: 'aligned' })); },
    generateCaptionJob: async (request) => ({ outputPath: request.outputPath })
  });
  assert.equal(calls, 1);
  assert.equal(results.length, 10);
});
