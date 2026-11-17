import test from 'node:test';
import assert from 'node:assert/strict';
import { createWarmTranscriberPool } from '../src/warm-transcriber.js';

function fixture() {
  const engines = [], timers = [];
  const pool = createWarmTranscriberPool({
    schedule: callback => { const timer = { callback }; timers.push(timer); return timer; },
    unschedule: timer => { if (timer) timer.cancelled = true; },
    factory: async options => {
      const engine = { options, resets: 0, closes: 0,
        async transcribe(value) { options.onProgress(value); if (value.fail) throw Error('failed'); },
        async align() { return []; },
        async reset() { engine.resets++; }, async close() { engine.closes++; } };
      engines.push(engine); return engine;
    }
  });
  return { pool, engines, timers };
}

test('nearby queues reuse imports, reset state, and route events only to the current queue', async () => {
  const { pool, engines, timers } = fixture();
  const first = [], second = [];
  const a = await pool.acquire({ device: 'cpu', onProgress: value => first.push(value) });
  await a.transcribe('a'); await a.close();
  const b = await pool.acquire({ device: 'cpu', onProgress: value => second.push(value) });
  await b.transcribe('b'); await b.close();
  assert.equal(engines.length, 1); assert.equal(engines[0].resets, 2);
  assert.deepEqual(first, ['a']); assert.deepEqual(second, ['b']);
  assert.equal(timers[0].cancelled, true);
  await timers.at(-1).callback();
  assert.equal(engines[0].closes, 1);
  await pool.shutdown();
});

test('cancellation destroys the engine and does not contaminate the next queue', async () => {
  const { pool, engines } = fixture(); const controller = new AbortController();
  const a = await pool.acquire({ signal: controller.signal });
  controller.abort(); await a.close();
  assert.equal(engines[0].options.signal.aborted, true);
  assert.equal(engines[0].closes, 1); assert.equal(engines[0].resets, 0);
  const b = await pool.acquire(); await b.close();
  assert.equal(engines.length, 2); await pool.shutdown();
});

test('errors and device changes discard cached engines; concurrent acquisition is rejected', async () => {
  const { pool, engines } = fixture();
  const a = await pool.acquire({ device: 'cpu' });
  await assert.rejects(pool.acquire(), /already in use/);
  await assert.rejects(a.transcribe({ fail: true }), /failed/); await a.close();
  const b = await pool.acquire({ device: 'cpu' }); await b.close();
  const c = await pool.acquire({ device: 'cuda' }); await c.close();
  assert.equal(engines.length, 3); assert.equal(engines[1].closes, 1);
  await pool.shutdown();
});
