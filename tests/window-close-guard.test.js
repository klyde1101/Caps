import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { protectWindowClose } from '../src/desktop/window-close-guard.js';

function harness({ confirm = true, reject = false } = {}) {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const window = new EventEmitter();
  Object.assign(window, { dirty: true, saving: false, keepEditing: true, closed: false, prompts: 0,
    isDestroyed: () => window.closed,
    destroy: () => assert.fail('Normal exit must not destroy the window'),
    close() {
      let prevented = false;
      window.emit('close', { preventDefault() { prevented = true; } });
      if (prevented) return;
      if (window.dirty || window.saving) { window.prompts++; if (window.keepEditing) return; }
      window.closed = true;
    } });
  let cancellations = 0, error;
  const jobs = { active: true, async cancelAndWait() {
    cancellations++;
    await waiting;
    if (reject) throw new Error('Could not stop');
    jobs.active = false;
  } };
  protectWindowClose(window, { jobs, confirmCancel: () => confirm, onError: value => { error = value; } });
  return { window, jobs, finish, get cancellations() { return cancellations; }, get error() { return error; } };
}

test('cancelling a job preserves the unsaved-edit guard and supports keeping the window open', async () => {
  const h = harness();
  h.window.close(); h.window.close();
  assert.equal(h.cancellations, 1);
  h.finish(); await setImmediate();
  assert.equal(h.window.prompts, 1);
  assert.equal(h.window.closed, false);
  h.window.keepEditing = false; h.window.close();
  assert.equal(h.window.closed, true);
});

test('a save in progress also reaches the normal close guard after cancellation', async () => {
  const h = harness(); h.window.dirty = false; h.window.saving = true;
  h.window.close(); h.finish(); await setImmediate();
  assert.equal(h.window.prompts, 1); assert.equal(h.window.closed, false);
  h.window.saving = false; h.window.close(); assert.equal(h.window.closed, true);
});

test('keeping processing never cancels work or closes the window', () => {
  const h = harness({ confirm: false }); h.window.close();
  assert.equal(h.cancellations, 0); assert.equal(h.jobs.active, true); assert.equal(h.window.closed, false);
});

test('failed cancellation leaves the window open and reports the error', async () => {
  const h = harness({ reject: true }); h.window.close(); h.finish(); await setImmediate();
  assert.match(h.error.message, /Could not stop/); assert.equal(h.window.closed, false); assert.equal(h.window.prompts, 0);
});
