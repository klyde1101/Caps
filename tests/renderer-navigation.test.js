import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/desktop/renderer/app.js', import.meta.url), 'utf8');
function rendererFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

function previewHarness() {
  const elements = new Map();
  for (const selector of ['#preview-body', '.preview', '#preview-prev', '#preview-next', '#preview-count', '#caption-empty', '.table-wrap']) {
    elements.set(selector, {
      children: ['previous captions'], attributes: {}, scrollTop: 160, scrollLeft: 50,
      replaceChildren(...children) { this.children = children.flatMap((child) => child.children ?? child); },
      setAttribute(name, value) { this.attributes[name] = value; }
    });
  }
  const pending = [];
  const cleared = [];
  const context = vm.createContext({
    $: (selector) => elements.get(selector),
    document: { createDocumentFragment: () => ({ children: [], append(row) { this.children.push(row); } }) },
    window: { caps: { getPreview: (request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject })) } },
    clearTimeout: (timer) => cleared.push(timer),
    cueList: { set(cues) { elements.get('#preview-body').children = Array.from(cues, c => c.text); elements.get('.table-wrap').scrollTop = 0; elements.get('.table-wrap').scrollLeft = 0; } },
    navigationAnimations: new WeakMap(), captionEditor: { syncPlayback() {} }, animateNavigation() {}, makeCueRow: (cue) => cue.text,
    previewToken: 0, previewOffset: 0, previewSearchTimer: 'pending search', PREVIEW_PAGE_SIZE: 200
  });
  vm.runInContext(rendererFunction('renderPreview'), context);
  const page = (text, offset = 0) => ({ cues: [{ text }], offset, matches: 1, total: 1 });
  return { elements, pending, cleared, context, page };
}

test('rapid result switches keep the table stable and discard out-of-order responses', async () => {
  const h = previewHarness();
  const first = h.context.renderPreview({ previewToken: 'first' }, '', 0);
  assert.deepEqual(h.elements.get('#preview-body').children, ['previous captions']);
  assert.equal(h.elements.get('.preview').attributes['aria-busy'], 'true');
  const second = h.context.renderPreview({ previewToken: 'second' }, '', 0);
  h.pending[1].resolve(h.page('second captions'));
  await second;
  h.pending[0].resolve(h.page('stale first captions'));
  await first;
  assert.deepEqual(h.elements.get('#preview-body').children, ['second captions']);
  assert.equal(h.elements.get('.preview').attributes['aria-busy'], 'false');
  assert.equal(h.elements.get('.table-wrap').scrollTop, 0);
  assert.equal(h.elements.get('.table-wrap').scrollLeft, 0);
  assert.ok(h.cleared.includes('pending search'));
});

test('a stale request cannot clear the newer request loading state', async () => {
  const h = previewHarness();
  const first = h.context.renderPreview({ previewToken: 'first' }, '', 0);
  const second = h.context.renderPreview({ previewToken: 'second' }, '', 200);
  h.pending[0].reject(new Error('stale error'));
  await first;
  assert.equal(h.elements.get('.preview').attributes['aria-busy'], 'true');
  h.pending[1].resolve(h.page('page two', 200));
  await second;
  assert.equal(h.context.previewOffset, 0);
});

test('preview errors remove previous file content and release the loading state', async () => {
  const h = previewHarness();
  const request = h.context.renderPreview({ previewToken: 'missing' }, '', 0);
  h.pending[0].reject(new Error('Preview unavailable'));
  await request;
  assert.deepEqual(h.elements.get('#preview-body').children, []);
  assert.equal(h.elements.get('#preview-count').textContent, 'Preview unavailable');
  assert.equal(h.elements.get('.preview').attributes['aria-busy'], 'false');
});

test('navigation replaces interrupted animation and respects reduced motion', () => {
  let cancelled = 0;
  let started = 0;
  const context = vm.createContext({ navigationAnimations: new WeakMap(), reducedMotion: { matches: false, addEventListener() {} } });
  vm.runInContext(rendererFunction('animateNavigation'), context);
  const element = { animate() { ++started; return { cancel() { ++cancelled; } }; } };
  context.animateNavigation(element, []);
  context.animateNavigation(element, []);
  assert.equal(started, 2);
  assert.equal(cancelled, 1);
  context.reducedMotion.matches = true;
  context.animateNavigation(element, []);
  assert.equal(started, 2);
  assert.equal(cancelled, 2);
});
