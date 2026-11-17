import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewStore } from '../src/desktop/preview-store.js';
import { exportSrt } from '../src/exporters/srt.js';

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'caps-editor-test-'));
  try {
    const outputPath = join(root, 'captions.srt');
    const original = exportSrt([{ start: 100, end: 900, text: 'Wrong word.' }, { start: 1200, end: 2200, text: 'Next caption.' }]);
    await writeFile(outputPath, original);
    const store = createPreviewStore();
    const result = store.register({ outputPath }, join(root, 'source #1.mp4'));
    await action({ root, outputPath, original, store, ...result });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('caption corrections preserve timing, update search/cache, and clean temporary files', async () => {
  await fixture(async ({ root, outputPath, original, store, previewToken, mediaUrl }) => {
    assert.match(mediaUrl, /source%20%231\.mp4$/);
    await store.page({ previewToken });
    const saved = await store.save({ previewToken, original, changes: [{ index: 1, text: 'Correct word.' }] });
    assert.equal(saved.saved, 1);
    assert.equal(await readFile(outputPath, 'utf8'), original.replace('Wrong', 'Correct'));
    const page = await store.page({ previewToken, query: 'correct' });
    assert.deepEqual(page.cues, [{ index: 1, start: 100, end: 900, text: 'Correct word.' }]);
    await store.save({ previewToken, original: saved.original, changes: [{ index: 2, text: 'Another correction.' }] });
    assert.deepEqual(await readdir(root), ['captions.srt']);
  });
});

test('invalid edits and unknown preview tokens cannot write files', async () => {
  await fixture(async ({ store, previewToken, original, outputPath }) => {
    for (const changes of [[{ index: 0, text: 'No' }], [{ index: 1, text: ' ' }], [{ index: 1, text: 'a\n\nb' }],
      [{ index: 1, text: '<script>bad</script>' }], [{ index: 1, text: 'a --> b' }],
      [{ index: 1, text: 'a' }, { index: 1, text: 'b' }]]) {
      await assert.rejects(store.save({ previewToken, original, changes }), { code: 'INVALID_REQUEST' });
    }
    await assert.rejects(store.save({ previewToken: outputPath, original, changes: [{ index: 1, text: 'No' }] }), { code: 'INVALID_REQUEST' });
    assert.equal(await readFile(outputPath, 'utf8'), original);
  });
});

test('external SRT edits are protected from stale editor saves', async () => {
  await fixture(async ({ store, previewToken, original, outputPath }) => {
    const external = original.replace('Wrong', 'External');
    await writeFile(outputPath, external);
    await assert.rejects(store.save({ previewToken, original, changes: [{ index: 1, text: 'Stale edit' }] }), { code: 'OUTPUT_CONFLICT' });
    assert.equal(await readFile(outputPath, 'utf8'), external);
  });
});
