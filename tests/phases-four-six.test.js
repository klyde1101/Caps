import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateOutputPath, validateSettings, validateStartRequest } from '../src/desktop/ipc-contract.js';
import { prepareOutput } from '../src/desktop/output-safeguards.js';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/desktop/settings-store.js';
import { defaultModel, inspectModel, resolveModelSelection } from '../src/whisperx-runner.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const alignedSrt = '1\n00:00:00,000 --> 00:00:00,300\nHello\n\n2\n00:00:00,300 --> 00:00:00,700\nworld.\n';

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'caps-gui-workflow-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('caption settings validate timing and reject retired grouping controls', () => {
  assert.doesNotThrow(() => validateSettings(DEFAULT_SETTINGS));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, dynamic: { maxWords: 4 } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, timing: { minDurationMs: 0, bridgeGapMs: 80 } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\video.mp4', grouping: { dynamic: { maxCharacters: 500 } } }), { code: 'INVALID_REQUEST' });
});

test('invalid persisted settings recover to independent defaults', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ mode: 'impossible' }), 'utf8');
    const recovered = await createSettingsStore(directory).read();
    assert.deepEqual(recovered, DEFAULT_SETTINGS);
    recovered.timing.minDurationMs = 500;
    assert.equal(DEFAULT_SETTINGS.timing.minDurationMs, 100);
  });
});

test('model diagnostics distinguish complete and incomplete external folders', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'config.json'), '{}', 'utf8');
    const incomplete = inspectModel(directory);
    assert.equal(incomplete.valid, false);
    assert.ok(incomplete.missingFiles.includes('model.bin'));
    for (const file of ['model.bin', 'tokenizer.json', 'vocabulary.txt']) await writeFile(join(directory, file), '', 'utf8');
    assert.equal(inspectModel(directory).valid, true);
    assert.equal(resolveModelSelection('large-v3-turbo', { env: { CAPS_MODEL: directory } }), directory);
  });
});

test('output safeguards support Unicode paths and detect conflicts', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, '音声 sample.srt');
    const outputPath = join(directory, '字幕_DYNAMIC.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');
    assert.equal(await prepareOutput({ inputPath, outputPath }), outputPath);
    await writeFile(outputPath, 'existing', 'utf8');
    await assert.rejects(prepareOutput({ inputPath, outputPath }), { code: 'OUTPUT_CONFLICT' });
    assert.equal(await prepareOutput({ inputPath, outputPath, overwrite: true }), outputPath);
  });
});

test('output safeguards reject identical files, unwritable folders, and excessive paths', async () => {
  const inputPath = 'C:\\Media\\same.srt';
  await assert.rejects(prepareOutput({ inputPath, outputPath: inputPath }, {
    access: async () => {}, stat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
  }), { code: 'INVALID_REQUEST' });
  await assert.rejects(prepareOutput({ inputPath, outputPath: 'C:\\Media\\out.srt' }, {
    access: async (_path, mode) => { if (mode === constants.W_OK) throw new Error('read only'); },
    stat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
  }), { code: 'OUTPUT_UNWRITABLE' });
  assert.throws(() => validateOutputPath(`C:\\${'a'.repeat(32000)}.srt`), { code: 'PATH_TOO_LONG' });
});

test('caption job returns safe structured cues for the preview', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'preview.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');
    const result = await generateCaptionBatchJob({ inputPath, mode: 'social-media' });
    assert.deepEqual(result.cues.map(({ text }) => text), ['Hello world.']);
    assert.ok(result.cues.every(({ start, end }) => Number.isFinite(start) && end > start));
  });
});

test('caption publication cannot race into silently replacing an output', async () => {
  await withTempDirectory(async (directory) => {
    const inputPath = join(directory, 'input.srt');
    const outputPath = join(directory, 'protected.srt');
    await writeFile(inputPath, alignedSrt, 'utf8');
    await writeFile(outputPath, 'keep me', 'utf8');
    await assert.rejects(generateCaptionBatchJob({ inputPath, outputPath, overwrite: false }), { code: 'OUTPUT_CONFLICT' });
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(outputPath, 'utf8'), 'keep me');
  });
});

test('renderer contains the complete workflow, accessible controls, and chunked preview', async () => {
  const html = await import('node:fs/promises').then(({ readFile }) => readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'index.html'), 'utf8'));
  const script = await import('node:fs/promises').then(({ readFile }) => readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'app.js'), 'utf8'));
  const styles = await import('node:fs/promises').then(({ readFile }) => readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'styles.css'), 'utf8'));
  for (const id of ['drop-zone', 'processing-view', 'completed-view', 'failed-view', 'settings-panel', 'preview-body']) assert.match(html, new RegExp(`id="${id}"`));
  for (const className of ['workflow-grid', 'input-stage', 'completion-heading', 'review-status']) assert.match(html, new RegExp(`class="[^"]*${className}`));
  assert.match(html, /aria-live="polite"/);
  assert.match(styles, /body\s*\{[^}]*height:\s*100dvh/);
  assert.match(styles, /main\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0/);
  assert.match(styles, /#ready-view\s*\{[^}]*grid-template-areas:/s);
  assert.match(styles, /@media \(max-height: 560px\)/);
  assert.match(script, /dataTransfer\.files/);
  assert.match(script, /window\.caps\.getPreview/);
  assert.match(script, /PREVIEW_PAGE_SIZE = 200/);
  assert.doesNotMatch(html, /id="preview-(?:prev|next)"/);
  assert.match(script, /createCueList/);
  assert.match(script, /window\.caps\.checkBatch/);
  assert.match(script, /conflicts\.length/);
  assert.doesNotMatch(script, /innerHTML/);
});
