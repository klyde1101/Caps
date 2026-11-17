import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerTime, formatPlayerTime, formatReviewTime, playerShortcutAllowed, mountPlayerControls } from '../src/desktop/renderer/player-controls.js';

test('review time uses one decimal and carries rounded seconds into minutes without changing SRT formatting', () => {
  assert.equal(formatReviewTime(15.771), '0:15.8');
  assert.equal(formatReviewTime(59.96), '1:00.0');
  assert.equal(formatReviewTime(3600), '60:00.0');
  assert.equal(formatReviewTime(NaN), '0:00.0');
  assert.equal(formatPlayerTime(15.771, true), '00:00:15,771');
});

test('manual player time accepts every supported format with exact milliseconds', () => {
  for (const [input, seconds] of [['12', 12], ['01:23', 83], ['01:02:03', 3723], ['01:02:03,456', 3723.456],
    [' 02:03,005 ', 123.005], ['90', 90], ['120:00', 7200]]) assert.equal(parsePlayerTime(input), seconds, input);
  for (const input of ['', '-5', '1:60', '1:60:00', '1:2:60', '1:2:3:4', 'Infinity', 'abc', '12ms', '1,2345', ':30', '1e3'])
    assert.equal(parsePlayerTime(input), null, input);
  assert.equal(formatPlayerTime(3723.456, true), '01:02:03,456');
  assert.equal(formatPlayerTime(83.005, true), '00:01:23,005');
  assert.equal(formatPlayerTime(NaN), '00:00:00');
});

test('player shortcuts never consume caption edits, focused controls or modal-dialog input', () => {
  const root = { closest: () => null };
  const document = { body: { classList: { contains: () => false } }, querySelector: () => null };
  assert.equal(playerShortcutAllowed({ closest: () => null }, root, document), true);
  for (const tag of ['input', 'textarea', 'button', 'select', '[contenteditable]']) {
    let selector;
    assert.equal(playerShortcutAllowed({ closest: value => { selector = value; return {}; } }, root, document), false);
    assert.ok(selector);
  }
  assert.equal(playerShortcutAllowed(null, { closest: () => ({ hidden: true }) }, document), false);
  assert.equal(playerShortcutAllowed(null, root, { ...document, querySelector: () => ({}) }), false);
  const button = {};
  assert.equal(playerShortcutAllowed({ closest: selector => selector.startsWith('button') ? button : null },
    { ...root, contains: value => value === button }, document), true);
});

function playerFixture() {
  class Element {
    constructor() { this.events = {}; this.attributes = {}; this.children = []; this.style = { setProperty(name, value) { this[name] = value; } }; this.value = ''; this.dataset = {}; }
    addEventListener(name, callback) { (this.events[name] ??= []).push(callback); }
    fire(name, event = {}) { for (const callback of this.events[name] ?? []) callback(event); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(child) { this.children.push(child); }
    get firstElementChild() { return this.children[0]; }
    querySelector() { return this.children[0]; }
    closest() { return null; }
    contains() { return false; }
    querySelectorAll() { return this.options ?? []; }
    select() {}
    blur() { this.fire('blur'); }
    focus() {}
    getBoundingClientRect() { return { left: 0, width: 100 }; }
  }
  const document = new Element(); document.body = { classList: { contains: () => false } };
  document.querySelector = () => null; document.createElementNS = () => new Element();
  const root = new Element(); root.ownerDocument = document; root.classList = { add() {}, remove() {} };
  const buttons = Object.fromEntries(['play', 'back', 'forward', 'mute', 'fullscreen'].map(name => {
    const button = new Element(); button.dataset.player = name; return [name, button];
  }));
  const elements = Object.fromEntries(['player-seek', 'player-current', 'player-volume', 'player-speed-button', 'player-speed-menu',
    'player-seek-preview', 'player-feedback', 'player-duration'].map(id => ['#' + id, new Element()]));
  elements['#player-speed-menu'].options = [.5,.75,1,1.25,1.5,2].map(n => { const e = new Element(); e.dataset.speed = String(n); return e; });
  const video = new Element();
  Object.assign(video, { duration: 12, currentTime: 0, volume: 1, playbackRate: 1, muted: false, paused: true,
    play: async () => { video.paused = false; }, pause: () => { video.paused = true; } });
  root.querySelector = selector => selector === 'video' ? video : elements[selector];
  root.querySelectorAll = selector => selector === '[data-player]' ? Object.values(buttons)
    : [...Object.values(buttons), ...['#player-seek', '#player-current', '#player-volume', '#player-speed-button'].map(id => elements[id])];
  root.requestFullscreen = async () => { document.fullscreenElement = root; document.fire('fullscreenchange'); };
  document.exitFullscreen = async () => { document.fullscreenElement = null; document.fire('fullscreenchange'); };
  const controls = mountPlayerControls(root);
  const key = value => ({ key: value, target: root, preventDefault() {}, stopPropagation() {} });
  return { video, elements, buttons, document, controls, key };
}

test('player time entry clamps, Escape cancels, invalid input reverts and transport controls work', async () => {
  const h = playerFixture(); const time = h.elements['#player-current'];
  const typeTime = value => { time.fire('focus'); time.value = value; time.fire('keydown', h.key('Enter')); };
  typeTime('00:00:03,125'); assert.equal(h.video.currentTime, 3.125);
  typeTime('999'); assert.equal(h.video.currentTime, 12);
  time.fire('focus'); time.value = '1'; time.fire('keydown', h.key('Escape'));
  assert.equal(h.video.currentTime, 12); assert.equal(time.value, '0:12.0');
  typeTime('bad time'); assert.equal(h.video.currentTime, 12);
  assert.equal(time.attributes['aria-invalid'], 'true'); assert.equal(time.value, '0:12.0');
  h.buttons.back.fire('click'); assert.equal(h.video.currentTime, 7);
  h.buttons.forward.fire('click'); assert.equal(h.video.currentTime, 12);
  h.controls.seek(2); h.buttons.play.fire('click'); await Promise.resolve(); assert.equal(h.video.paused, false);
  h.buttons.play.fire('click'); assert.equal(h.video.paused, true);
  h.buttons.mute.fire('click'); assert.equal(h.video.muted, true);
  h.elements['#player-volume'].value = '0.5'; h.elements['#player-volume'].fire('input');
  assert.equal(h.video.volume, .5); assert.equal(h.video.muted, false);
  h.elements['#player-speed-menu'].options.find(e => e.dataset.speed === '1.5').fire('click');
  assert.equal(h.video.playbackRate, 1.5);
  h.buttons.fullscreen.fire('click'); await Promise.resolve(); assert.ok(h.document.fullscreenElement);
  h.document.fire('keydown', h.key('Escape')); await Promise.resolve(); assert.equal(h.document.fullscreenElement, null);
  h.elements['#player-seek'].fire('pointermove', { clientX: 50 });
  assert.equal(h.elements['#player-seek-preview'].textContent, '0:06.0');
  h.document.fire('keydown', { ...h.key('ArrowLeft'), target: { closest: () => ({}) } });
  assert.equal(h.video.currentTime, 2);
  h.document.fire('keydown', h.key('ArrowRight')); assert.equal(h.video.currentTime, 7);
  h.video.duration = NaN; h.video.fire('emptied'); assert.equal(time.disabled, true);
});
