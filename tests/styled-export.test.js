import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportTtml } from '../src/exporters/ttml.js';
import { generateCaptionJob } from '../src/application/generate-caption-job.js';
import { createPreviewStore } from '../src/desktop/preview-store.js';
import { exportSrt } from '../src/exporters/srt.js';
import { prepareOutput } from '../src/desktop/output-safeguards.js';

test('TTML preserves font face, size, orientation, millisecond timing and escaped multiline text', () => {
  const xml = exportTtml([{ start: 1234, end: 6789, text: 'A & <B>\n"C"' }], { fontFamily: 'montserrat-semibold', fontSize: 70, orientation: '16:9' });
  assert.match(xml, /tts:fontFamily="Montserrat SemiBold"/);
  assert.match(xml, /tts:fontSize="70px"/);
  assert.match(xml, /tts:extent="1920px 1080px"/);
  assert.match(xml, /begin="00:00:01.234" end="00:00:06.789"/);
  assert.match(xml, /A &amp; &lt;B&gt;<br\/>&quot;C&quot;/);
});

test('font selection produces a styled sidecar and corrections synchronize both exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-styled-'));
  try {
    const inputPath = join(root, 'words.srt');
    await writeFile(inputPath, exportSrt([{ start: 100, end: 900, text: 'Hello' }]));
    const result = await generateCaptionJob({ inputPath, overwrite: false, grouping: { fontFamily: 'roboto-semibold', fontSize: 60 } });
    assert.match(await readFile(result.styledOutputPath, 'utf8'), /Roboto SemiBold/);
    const original = await readFile(result.outputPath, 'utf8');
    const store = createPreviewStore();
    const { previewToken } = store.register(result, inputPath);
    const saved = await store.save({ previewToken, original, changes: [{ index: 1, text: 'Edited & saved' }] });
    assert.equal(saved.warning, undefined);
    assert.match(await readFile(result.outputPath, 'utf8'), /Edited & saved/);
    const styled = await readFile(result.styledOutputPath, 'utf8');
    assert.match(styled, /Edited &amp; saved/); assert.match(styled, /Roboto SemiBold/); assert.match(styled, /60px/);
    assert.ok((await readdir(root)).every(file => !file.endsWith('.tmp')));
    await assert.rejects(prepareOutput({ inputPath, outputPath: result.outputPath }), { code: 'OUTPUT_CONFLICT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pre-existing styled sidecar is protected even if no SRT exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-style-conflict-'));
  try {
    const inputPath = join(root, 'words.srt'), outputPath = join(root, 'output.srt');
    await writeFile(inputPath, exportSrt([{ start: 100, end: 900, text: 'Hello' }]));
    await writeFile(join(root, 'output.ttml'), 'External captions');
    await assert.rejects(prepareOutput({ inputPath, outputPath }), { code: 'OUTPUT_CONFLICT' });
    await assert.rejects(generateCaptionJob({ inputPath, outputPath, overwrite: false, grouping: { fontFamily: 'roboto-semibold' } }), { code: 'OUTPUT_CONFLICT' });
    assert.equal(await readFile(join(root, 'output.ttml'), 'utf8'), 'External captions');
    assert.deepEqual((await readdir(root)).sort(), ['output.ttml', 'words.srt']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
