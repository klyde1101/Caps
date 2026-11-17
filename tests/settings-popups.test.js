import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsPopups } from '../src/desktop/renderer/settings-popups.js';

test('nested popups trap focus, dismiss only the top dialog, and return focus to their trigger', () => {
  const previousWindow = globalThis.window; const previousDocument = globalThis.document;
  const handlers = [];
  globalThis.window = { addEventListener: (name, handler, capture) => handlers.push({ name, handler, capture }) };
  globalThis.document = { activeElement: null };
  const control = () => ({ hidden: false, isConnected: true, getClientRects: () => [1],
    focus() { globalThis.document.activeElement = this; }, addEventListener(name, handler) { this[name] = handler; } });
  const panel = () => {
    const close = control(); const field = control(); const done = control();
    const buttons = [close, done];
    return { hidden: true, close, field, done,
      querySelector: () => close,
      querySelectorAll: (selector) => selector === '[data-popup-close]' ? buttons : [close, field, done],
      contains: (target) => [close, field, done].includes(target) };
  };
  const timing = panel(); const diagnostics = panel(); const trigger = control(); const second = control();
  const scrim = control(); scrim.hidden = true;
  const settings = { hidden: false, inert: false, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelector: () => trigger };
  let diagnosticsOpened = 0;
  try {
    const popups = createSettingsPopups({ settings, scrim, panels: { timing, diagnostics }, onDiagnostics: () => diagnosticsOpened++ });
    const key = (key, shiftKey = false) => {
      const event = { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      handlers.find((handler) => handler.name === 'keydown').handler(event); return event;
    };
    assert.equal(handlers[0].capture, true);
    popups.open('timing', trigger);
    assert.equal(settings.inert, true); assert.equal(timing.hidden, false);
    assert.equal(globalThis.document.activeElement, timing.close);
    timing.field.value = '180';
    assert.equal(key('Tab', true).prevented, true);
    assert.equal(globalThis.document.activeElement, timing.done);
    key('Tab'); assert.equal(globalThis.document.activeElement, timing.close);
    const escape = key('Escape'); assert.equal(escape.stopped, true);
    assert.equal(settings.hidden, false); assert.equal(settings.inert, false);
    assert.equal(timing.hidden, true); assert.equal(globalThis.document.activeElement, trigger);
    popups.open('timing', trigger); assert.equal(timing.field.value, '180');
    timing.done.click(); assert.equal(globalThis.document.activeElement, trigger);
    popups.open('diagnostics', second); assert.equal(diagnosticsOpened, 1);
    scrim.click(); assert.equal(diagnostics.hidden, true); assert.equal(globalThis.document.activeElement, second);
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
