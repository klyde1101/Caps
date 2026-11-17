import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { exportSrt } from '../src/exporters/srt.js';
import { createPlaybackFollower } from '../src/desktop/renderer/playback-follow.js';

const source = (await readFile(new URL('../src/desktop/renderer/caption-editor.js', import.meta.url), 'utf8'))
  .replace(/^import[^\n]+\n/gm, '').replace('export function', 'function');

class Element {
  constructor() { this.events = {}; this.textContent = ''; this.value = ''; this.dataset = {}; this.children = []; this.paused = true; this.style = {}; this.scrollHeight = 26;
    this.classList = { toggle() {} }; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute() {}
  removeAttribute(name) { delete this[name]; }
  replaceChildren(...children) { this.children = children; }
  load() {}
  pause() { this.paused = true; }
  get lastElementChild() { return this.children.at(-1); }
  querySelector() { return this.label ??= new Element(); }
}

async function harness() {
  const selectors = ['#caption-video', '#video-caption', '#save-captions', '#editor-status', '#reload-captions', '#media-status', '.playback-panel', '#caption-player', '#audio-placeholder'];
  const elements = new Map(selectors.map(s => [s, new Element()]));
  const timelines = new Map([
    ['first', [{ index: 1, start: 0, end: 900, text: 'First caption' }, { index: 2, start: 1000, end: 1900, text: 'Next caption' }]],
    ['second', [{ index: 1, start: 0, end: 900, text: 'Different file' }]]
  ]);
  let refreshed = 0;
  let failSave = false;
  let saved;
  const events = {};
  const context = vm.createContext({ exportSrt, createPlaybackFollower, Map, Set, getComputedStyle: () => ({ borderTopWidth: '1', borderBottomWidth: '2' }), setTimeout: () => 0, clearTimeout() {}, reviewDecision: async () => 'cancel',
    document: { addEventListener() {}, querySelector: s => elements.get(s), querySelectorAll: () => [], createElement: () => new Element() },
    window: { addEventListener: (name, fn) => { events[name] = fn; }, confirm: () => false,
      caps: { getPreview: async ({ previewToken }) => ({ cues: timelines.get(previewToken).map(c => ({ ...c })), total: timelines.get(previewToken).length }),
        saveCaptions: async request => {
          if (failSave) throw new Error('Disk is read-only');
          saved = request;
          const cues = timelines.get(request.previewToken);
          for (const change of request.changes) cues[change.index - 1].text = change.text.trim();
          return { original: exportSrt(cues) };
        } } }
  });
  vm.runInContext(source + '\nglobalThis.editor = createCaptionEditor(() => refreshed());', Object.assign(context, { refreshed: () => { refreshed++; } }));
  const result = token => ({ previewToken: token, mediaUrl: 'file:///source.mp4' });
  const row = (token, index = 0) => {
    const cue = timelines.get(token)[index];
    const tr = new Element(); tr.children = Array.from({ length: 4 }, () => new Element());
    tr.children[1].textContent = '00:00:00,000';
    context.editor.decorate(tr, cue, result(token));
    return { input: tr.lastElementChild.children[0], seek: tr.children[1].children[0], endSeek: tr.children[2].children[0] };
  };
  await context.editor.open(result('first'));
  return { editor: context.editor, elements, events, row, result, context, timelines,
    get saved() { return saved; }, get refreshed() { return refreshed; }, set failSave(value) { failSave = value; } };
}

test('editing synchronizes playback text, preserves drafts across files, seeks and saves the correct SRT', async () => {
  const h = await harness();
  const { input, seek, endSeek } = h.row('first');
  assert.equal(h.elements.get('#editor-status').dataset.state, 'saved');
  input.value = 'Corrected caption'; input.events.input();
  assert.equal(h.elements.get('#editor-status').dataset.state, 'unsaved');
  assert.match(h.elements.get('#editor-status').textContent, /1 unsaved change/);
  const video = h.elements.get('#caption-video'); video.currentTime = 0.4; video.events.timeupdate();
  assert.equal(h.elements.get('#video-caption').textContent, 'Corrected caption');
  assert.equal(h.elements.get('#save-captions').disabled, false);
  await h.editor.open(h.result('second'));
  assert.equal(h.row('second').input.value, 'Different file');
  await h.editor.open(h.result('first'));
  assert.equal(h.row('first').input.value, 'Corrected caption');
  seek.events.click(); assert.equal(video.currentTime, 0);
  endSeek.events.click(); assert.equal(video.currentTime, 0.9);
  await h.elements.get('#save-captions').events.click();
  assert.equal(h.saved.previewToken, 'first');
  assert.equal(h.saved.changes[0].text, 'Corrected caption');
  assert.equal(h.elements.get('#save-captions').disabled, true);
  assert.equal(h.elements.get('#editor-status').textContent, 'Saved');
  assert.equal(h.refreshed, 1);
  assert.equal(await h.editor.reset(), true);
});

test('failed saves preserve corrections and unsaved work prevents closing or resetting', async () => {
  const h = await harness();
  const { input } = h.row('first'); input.value = 'Unsaved'; input.events.input();
  h.failSave = true;
  await h.elements.get('#save-captions').events.click();
  assert.match(h.elements.get('#editor-status').textContent, /Disk is read-only/);
  assert.equal(h.elements.get('#editor-status').dataset.state, 'error');
  assert.equal(h.elements.get('#save-captions').querySelector('[data-save-label]').textContent, 'Retry save');
  assert.equal(h.row('first').input.value, 'Unsaved');
  assert.equal(await h.editor.reset(), false);
  let prevented = false;
  h.events.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('Reload SRT refreshes external corrections without changing caption times', async () => {
  const h = await harness();
  h.timelines.get('first')[0].text = 'External correction';
  await h.elements.get('#reload-captions').events.click();
  assert.equal(h.row('first').input.value, 'External correction');
  h.row('first').endSeek.events.click();
  assert.equal(h.elements.get('#caption-video').currentTime, .9);
  assert.equal(h.elements.get('#save-captions').disabled, true);
});
