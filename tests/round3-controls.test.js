import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModelDeleteDialog } from '../src/desktop/renderer/model-delete-dialog.js';
import { processingStep, queueRowPhase } from '../src/desktop/renderer/processing-state.js';

test('delete dialog settles once on confirm, cancel, Escape or backdrop and can reopen', async () => {
  class Target { events = {}; addEventListener(name, fn) { this.events[name] = fn; } focus() {} }
  const dialog = new Target(), nodes = Object.fromEntries(['[data-confirm]', '[data-dismiss]', '[data-model-name]', '[data-model-size]'].map(s => [s, new Target()]));
  Object.assign(dialog, { ownerDocument: { activeElement: { isConnected: true, focus() {} } }, querySelector: s => nodes[s],
    showModal() { this.open = true; }, close() { this.open = false; }, getBoundingClientRect: () => ({ left: 10, right: 90, top: 10, bottom: 90 }) });
  const show = createModelDeleteDialog(dialog);
  for (const action of ['confirm', 'dismiss', 'escape', 'backdrop', 'native-close']) {
    const result = show('Small', '0.49');
    assert.equal(dialog.open, true); assert.equal(nodes['[data-model-name]'].textContent, 'Delete Small?');
    assert.equal(await show('Other', '1.62'), false);
    if (action === 'confirm' || action === 'dismiss') nodes[`[data-${action}]`].events.click();
    else if (action === 'escape') dialog.events.cancel({ preventDefault() {} });
    else if (action === 'native-close') { dialog.close(); dialog.events.close(); }
    else dialog.events.click({ target: dialog, clientX: 0, clientY: 0 });
    nodes['[data-confirm]'].events.click(); // Stale/double confirmation cannot settle a second operation.
    assert.equal(await result, action === 'confirm'); assert.equal(dialog.open, false);
  }
  const reopened = show('Small', '0.49');
  dialog.events.close(); // A queued close event from the previous dialog is stale.
  assert.equal(dialog.open, true);
  nodes['[data-confirm]'].events.click();
  assert.equal(await reopened, true);
});

test('pipeline stages map to Prepare, Transcribe, Align and Export without inventing progress', () => {
  for (const stage of ['queued', 'preparing', 'inspecting-input', 'locating-whisperx']) assert.equal(processingStep(stage), 'prepare');
  assert.equal(processingStep('transcribing'), 'transcribe'); assert.equal(processingStep('aligning'), 'align');
  assert.equal(processingStep('writing-output'), 'export'); assert.equal(processingStep('validating'), 'export');
});

test('deferred alignment telemetry overrides stale waiting queue membership', () => {
  assert.equal(queueRowPhase({ stage: 'awaiting-alignment', percent: 70 }, 'awaiting-alignment'), 'awaiting-alignment');
  for (const stage of ['aligning', 'finishing', 'grouping-captions', 'validating', 'writing-output'])
    assert.equal(queueRowPhase({ stage, percent: 70 }, 'awaiting-alignment'), 'active');
  assert.equal(queueRowPhase({ stage: 'queued', percent: 0 }, 'queued'), 'queued');
  assert.equal(queueRowPhase({ stage: 'complete', percent: 100 }, 'awaiting-alignment'), 'complete');
});

test('ICO contains all eight optical Windows sizes as distinct encoded frames', async () => {
  const bytes = await readFile(new URL('../build/caps-icon.ico', import.meta.url));
  assert.equal(bytes.readUInt16LE(4), 8);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => bytes[6 + 16 * i] || 256), [16, 20, 24, 32, 40, 48, 64, 256]);
});
