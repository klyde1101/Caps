import test from 'node:test';
import assert from 'node:assert/strict';
import { JobController } from '../src/desktop/job-controller.js';
import { validateQueueChange } from '../src/desktop/ipc-contract.js';
import { createProgressTracker } from '../src/desktop/renderer/job-progress.js';

const request = (name) => ({ inputPath: `C:\\Media\\${name}.mp4`, outputPath: `C:\\Media\\${name}.srt`, model: 'large-v3-turbo', mode: 'social-media' });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('live queue appends and reorders pending files without changing active work or progress identity', async () => {
  const started = [], releases = [], snapshots = [], progress = [];
  const jobs = new JobController((value) => new Promise((resolve, reject) => {
    started.push(value.inputPath);
    value.onProgress({ stage: 'transcribing-and-aligning', percent: 40 });
    releases.push(() => resolve({ outputPath: value.outputPath }));
    value.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
  }));
  const running = jobs.startQueue([request('a'), request('b'), request('c')], {
    onQueue: snapshot => snapshots.push(snapshot), onProgress: event => progress.push(event)
  });
  let state = snapshots.at(-1);
  const [a, b, c] = state.items;
  assert.equal(a.state, 'active');
  state = jobs.enqueue(state.id, [request('d')]);
  const d = state.items.at(-1);
  state = jobs.moveQueued(state.id, d.id, b.id);
  state = jobs.moveQueued(state.id, c.id, d.id);
  assert.deepEqual(state.items.map(item => item.name), ['a.mp4', 'c.mp4', 'd.mp4', 'b.mp4']);
  assert.throws(() => jobs.moveQueued(state.id, a.id, b.id), { code: 'QUEUE_CHANGED' });
  releases[0](); await tick();
  assert.equal(started[1], request('c').inputPath);
  assert.equal(progress.at(-1).fileIndex, 2);
  assert.equal(progress.at(-1).queueItemId, c.id);
  assert.equal(progress.at(-1).fileCount, 4);
  // A stale drop target that has just started inserts immediately after active work.
  jobs.moveQueued(state.id, b.id, c.id);
  releases[1](); await tick();
  assert.equal(started[2], request('b').inputPath);
  releases[2](); await tick();
  assert.equal(started[3], request('d').inputPath);
  releases[3]();
  const results = await running;
  assert.deepEqual(results.map(item => item.inputName), ['a.mp4', 'c.mp4', 'b.mp4', 'd.mp4']);
  assert.equal(new Set(results.map(item => item.queueItemId)).size, 4);
  assert.equal(jobs.active, false);
  assert.equal(snapshots.at(-1).accepting, false);
  assert.ok(snapshots.every((snapshot, index) => index === 0 || snapshot.revision > snapshots[index - 1].revision));
  assert.throws(() => jobs.enqueue(state.id, [request('e')]), { code: 'QUEUE_CLOSED' });
});

test('adding files is atomic, rejects duplicate outputs and closed queues, and cancellation stops pending work', async () => {
  const snapshots = [], started = [];
  const jobs = new JobController(({ inputPath, signal }) => new Promise((resolve, reject) => {
    started.push(inputPath);
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
  }));
  const running = jobs.startQueue([request('a'), request('b')], { onQueue: state => snapshots.push(state) });
  const state = snapshots.at(-1);
  const rejection = assert.rejects(running, { code: 'CANCELLED' });
  assert.throws(() => jobs.enqueue(state.id, [request('c'), request('b')]), { code: 'OUTPUT_CONFLICT' });
  assert.equal(snapshots.at(-1).items.length, 2);
  assert.throws(() => jobs.enqueue(state.id, Array.from({ length: 99 }, (_, index) => request('extra-' + index))), { code: 'INVALID_REQUEST' });
  assert.throws(() => jobs.moveQueued(state.id, state.items[1].id, 'unknown'), { code: 'INVALID_REQUEST' });
  assert.equal(await jobs.cancelAndWait(), true);
  await rejection;
  assert.equal(started.length, 1);
  assert.ok(snapshots.at(-1).items.every(item => item.state === 'cancelled'));
  assert.throws(() => jobs.enqueue(state.id, [request('c')]), { code: 'QUEUE_CLOSED' });
});

test('synchronous failures release the controller and failed live queues cannot accept files', async () => {
  const snapshots = [];
  const jobs = new JobController(() => { throw new Error('failed'); });
  await assert.rejects(jobs.startQueue([request('a'), request('b')], { onQueue: state => snapshots.push(state) }), /failed/);
  assert.equal(jobs.active, false);
  assert.deepEqual(snapshots.at(-1).items.map(item => item.state), ['failed', 'cancelled']);
  await assert.rejects(jobs.start(request('c')), /failed/);
  assert.equal(jobs.active, false);
});

test('queue IPC changes validate identities and reject unexpected fields and malformed files', () => {
  const queueId = '11111111-1111-4111-8111-111111111111';
  const itemId = '22222222-2222-4222-8222-222222222222';
  assert.equal(validateQueueChange({ queueId, requests: [request('a')] }).requests.length, 1);
  assert.deepEqual(validateQueueChange({ queueId, itemId, beforeId: null }, true), { queueId, itemId, beforeId: null });
  for (const value of [{ queueId: 'invalid', requests: [request('a')] }, { queueId, requests: [] },
    { queueId, requests: [request('a')], extra: true }]) assert.throws(() => validateQueueChange(value), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateQueueChange({ queueId, itemId, beforeId: 'invalid' }, true), { code: 'INVALID_REQUEST' });
});

test('adding queued files preserves completed and active progress and recalculates the total', () => {
  const tracker = createProgressTracker([{ name: 'a' }, { name: 'b' }], 0);
  tracker.update({ stage: 'complete', fileIndex: 0 }, 1000);
  tracker.update({ stage: 'transcribing-and-aligning', fileIndex: 1, percent: 40 }, 4000);
  assert.equal(tracker.snapshot(4000).percent, 70);
  tracker.syncFiles([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 4500);
  assert.deepEqual(tracker.snapshot(4500).items.map(item => item.percent), [100, 40, 0]);
  assert.equal(tracker.snapshot(4500).completed, 1);
  assert.equal(tracker.snapshot(4500).remaining, null);
  assert.ok(Math.abs(tracker.snapshot(4500).percent - 140 / 3) < .001);
});

test('files appended as the last export completes are drained instead of being lost', async () => {
  let appended = false;
  const jobs = new JobController(async request => ({ outputPath: request.outputPath }));
  const results = await jobs.startQueue([request('a')], { onQueue: snapshot => {
    if (!appended && snapshot.accepting && snapshot.items[0]?.state === 'complete') {
      appended = true;
      jobs.enqueue(snapshot.id, [request('b')]);
    }
  } });
  assert.deepEqual(results.map(result => result.inputName), ['a.mp4', 'b.mp4']);
  assert.equal(jobs.active, false);
});
