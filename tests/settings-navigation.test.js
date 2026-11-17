import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsNavigation } from '../src/desktop/renderer/settings-navigation.js';
import { deviceRecommendation } from '../src/desktop/renderer/device-recommendation.js';
import { DEFAULT_SETTINGS } from '../src/desktop/settings-store.js';

test('Settings navigation switches panes, preserves timing drafts and supports vertical tab keys', () => {
  let focused, diagnostics = 0;
  const names = ['general', 'model', 'timing', 'diagnostics'];
  const tabs = names.map(name => ({ dataset: { settingsPage: name }, attributes: {}, events: {},
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, fn) { this.events[k] = fn; }, focus() { focused = this; } }));
  const panes = names.map(name => ({ dataset: { settingsPane: name }, hidden: false, scrollTop: 80,
    value: name === 'timing' ? 180 : null, querySelector: () => null }));
  const root = { querySelectorAll: selector => selector.includes('page]') ? tabs : panes };
  const nav = createSettingsNavigation(root, { onDiagnostics: () => diagnostics++ });
  assert.equal(nav.active, 'general'); assert.deepEqual(panes.map(p => p.hidden), [false, true, true, true]);
  tabs[2].events.click(); assert.equal(nav.active, 'timing');
  tabs[2].events.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(nav.active, 'diagnostics'); assert.equal(focused, tabs[3]); assert.equal(diagnostics, 1);
  tabs[3].events.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(nav.active, 'general'); assert.equal(tabs[0].tabIndex, 0); assert.equal(tabs[1].tabIndex, -1);
  nav.open('timing'); assert.equal(panes[2].value, 180); nav.close(); assert.equal(nav.active, 'general');
});

const hardware = () => ({ cuda: { devices: [{ index: 0, name: 'NVIDIA GeForce RTX 3050', totalMemoryBytes: 8 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3 }] },
  runtimes: { cpu: { available: true }, cuda: { available: true } } });
test('Automatic is the default; a suitable RTX gives an actionable recommendation without changing a CPU preference', () => {
  assert.equal(DEFAULT_SETTINGS.device, 'auto');
  const settings = { model: 'large-v3-turbo', device: 'cpu', deviceIndex: 0 };
  const recommendation = deviceRecommendation(hardware(), settings);
  assert.equal(recommendation.title, 'Your RTX 3050 can run Large v3 Turbo.');
  assert.match(recommendation.detail, /CPU is currently selected/); assert.equal(recommendation.offerAutomatic, true);
  assert.equal(settings.device, 'cpu');
  assert.equal(deviceRecommendation(hardware(), { ...settings, device: 'auto' }).offerAutomatic, false);
  const small = deviceRecommendation(hardware(), { ...settings, model: 'small', device: 'auto' });
  assert.match(small.title, /Large v3 Turbo/); assert.match(small.detail, /run Small/);
  assert.match(deviceRecommendation(hardware(), { model: 'none' }).detail, /Choose a speech model/);
});
test('recommendations explain low free VRAM, missing CUDA and CPU-only systems honestly', () => {
  const hw = hardware(); hw.cuda.devices[0].freeMemoryBytes = 1024 ** 3;
  assert.match(deviceRecommendation(hw, { model: 'large-v3-turbo' }).detail, /GPU memory is currently limited/);
  hw.runtimes.cuda.available = false;
  assert.match(deviceRecommendation(hw, { model: 'small' }).detail, /CUDA runtime/);
  hw.cuda.devices = [];
  assert.match(deviceRecommendation(hw, { model: 'small' }).detail, /No compatible NVIDIA GPU/);
});
