// Runs against the published app over its local debugging connection. No mocked APIs.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkPackage(page, { root, build, resumeBatch = false, outputDirectory }) {
  assert.ok(page.url().includes('/' + build + '/resources/app.asar/'));
  const output = outputDirectory ?? join(root, 'data/ui-qa/round3/final');
  await mkdir(output, { recursive: true });
  const checks = [], events = [], captured = new Set();
  if (resumeBatch) checks.push(...JSON.parse(await readFile(join(output, 'packaged-report.json'), 'utf8')).checks);
  let timer, capturing = false;
  const record = (name, detail = {}) => checks.push({ name, passed: true, ...detail });
  const confirmFixtureReplacement = dialog => {
    if (/caption exports? already exist/.test(dialog.message()) && /release-(?:single|audio|hevc|import)/.test(dialog.message())) return dialog.accept();
    return dialog.dismiss();
  };
  page.on('dialog', confirmFixtureReplacement);
  const screenshot = name => page.screenshot({ path: join(output, name + '.png'), timeout: 5000 });
  const session = await page.context().newCDPSession(page);
  async function importFiles(paths) {
    await page.evaluate(() => {
      if (!document.querySelector('#qa-source')) {
        const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
        input.hidden = true; input.id = 'qa-source'; document.body.append(input);
      }
    });
    const doc = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#qa-source' });
    await session.send('DOM.setFileInputFiles', { nodeId, files: paths });
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      for (const file of document.querySelector('#qa-source').files) transfer.items.add(file);
      document.querySelector('#drop-zone').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => !document.querySelector('#start-job').disabled, { timeout: 10000 });
  }
  async function waitCompleted() {
    await page.waitForFunction(() => !document.querySelector('#completed-view').hidden || !document.querySelector('#failed-view').hidden, null, { timeout: 180000 });
    assert.equal(await page.locator('#failed-view').isVisible(), false, await page.locator('#error-message').textContent());
    await page.waitForFunction(() => document.querySelector('.caption-text'));
  }
  async function selectBatch(index) {
    await page.locator('#batch-results button').nth(index).click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#editor-status').textContent === 'All corrections saved');
  }
  try {
    if (!resumeBatch) {
    const sample = join(output, 'release-single.mp4');
    await copyFile(join(root, 'data/ui-qa/round3/sample.mp4'), sample);
    await importFiles([sample]); await screenshot('packaged-home-ready');
    await page.exposeFunction('round3Progress', event => events.push(event));
    await page.evaluate(() => caps.onProgress(event => window.round3Progress(event)));
    timer = setInterval(async () => {
      if (capturing) return; capturing = true;
      try {
        const step = await page.evaluate(() => document.querySelector('#processing-view').hidden ? null : document.querySelector('#job-steps [aria-current]')?.dataset.step);
        if (step && !captured.has(step)) { await screenshot('packaged-processing-' + step); captured.add(step); }
      } catch {} finally { capturing = false; }
    }, 100);
    await page.locator('#start-job').click(); await waitCompleted();
    clearInterval(timer);
    await screenshot('packaged-results-single');
    const density = await page.locator('#preview-body tr').first().evaluate(row => row.getBoundingClientRect().height);
    assert.ok(density <= 38.5); record('real WhisperX transcription, alignment and SRT export', { density, captured: [...captured] });
    assert.match(await page.locator('#preview-count').textContent(), /^23 captions$/);
    assert.equal(await page.locator('#overall-time-fact').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    assert.match(await page.locator('#player-duration').textContent(), /^\d\d:\d\d:\d\d,\d{3}$/);
    await page.locator('#player-current').fill('00:00:08,500'); await page.locator('#player-current').press('Enter');
    await page.locator('#caption-player').focus(); await page.keyboard.press('ArrowRight');
    assert.ok(Math.abs(await page.locator('video').evaluate(v => v.currentTime) - 13.5) < .1);
    await page.keyboard.press('Space'); await page.waitForFunction(() => !document.querySelector('video').paused);
    record('typed time, right arrow and Space');
    await page.locator('[data-player="fullscreen"]').click({ timeout: 5000 });
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.locator('#caption-player').focus(); await page.keyboard.press('ArrowLeft');
    await screenshot('packaged-fullscreen');
    await page.waitForFunction(() => document.querySelector('#caption-player').classList.contains('controls-idle'), { timeout: 6000 });
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.fullscreenElement, { timeout: 5000 });
    await page.locator('video').evaluate(v => v.pause()); record('fullscreen shortcuts, auto-hide and Escape');
    const edited = 'Round three saved edit.';
    await page.locator('.caption-text').first().fill(edited); await page.locator('#save-captions').click();
    await page.waitForFunction(() => document.querySelector('#editor-status').textContent === 'All corrections saved');
    assert.ok((await readFile(join(output, 'release-single_SOCIAL-MEDIA.srt'), 'utf8')).includes(edited));
    await page.locator('#reload-captions').click();
    await page.waitForFunction(text => document.querySelector('.caption-text')?.value === text, edited);
    record('caption editing, disk save and SRT reload');
    await page.locator('#process-another').click();
    } else if (await page.locator('#failed-view').isVisible()) await page.locator('#back-ready').click();
    const audio = join(output, 'release-audio.wav'), hevc = join(output, 'release-hevc.mp4'), subtitle = join(output, 'release-import.srt');
    await copyFile(join(root, 'data/ui-qa/round3/audio.wav'), audio);
    await copyFile(join(root, 'data/ui-qa/round3/hevc-audio.mp4'), hevc);
    // Import accepts aligned highlighted or one-word cues, rather than already-grouped output.
    await writeFile(subtitle, '1\n00:00:00,200 --> 00:00:00,800\nHello\n\n2\n00:00:00,900 --> 00:00:01,500\nworld.\n');
    await importFiles([audio, hevc, subtitle]); await page.locator('#start-job').click(); await waitCompleted();
    assert.equal(await page.locator('#batch-results button').count(), 3); await screenshot('packaged-results-batch');
    await selectBatch(0); assert.equal(await page.locator('#audio-placeholder').isVisible(), true);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await page.locator('[data-player="play"]').click(); await page.waitForFunction(() => !document.querySelector('video').paused);
    await screenshot('packaged-results-audio'); await page.locator('video').evaluate(v => v.pause()); record('audio placeholder and playback');
    await selectBatch(1); await page.waitForFunction(() => document.querySelector('video').readyState >= 2, { timeout: 60000 });
    await page.locator('[data-player="play"]').click(); await page.waitForFunction(() => !document.querySelector('video').paused);
    await screenshot('packaged-results-hevc'); record('HEVC playback', { status: await page.locator('#media-status').textContent() });
    // HEVC can decode on this GPU. Induce a source error to exercise the real recovery path.
    await page.locator('video').evaluate(video => { video.src = 'file:///C:/caps-round3-missing-codec-test.webm'; video.load(); });
    await page.waitForFunction(() => document.querySelector('#media-status').textContent.startsWith('Compatible preview ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await page.locator('[data-player="play"]').click(); await page.waitForFunction(() => !document.querySelector('video').paused);
    await screenshot('packaged-preview-recovery'); record('real ffmpeg conversion and playback after an induced media error');
    await selectBatch(2); assert.equal(await page.locator('#caption-player').isVisible(), false);
    assert.ok(await page.locator('.preview').evaluate(el => el.getBoundingClientRect().width) > 1000);
    await screenshot('packaged-results-srt'); record('SRT-only import and full-width editor');
    record('mixed media and SRT batch');
  } finally {
    clearInterval(timer);
    page.off('dialog', confirmFixtureReplacement);
    await writeFile(join(output, 'packaged-report.json'), JSON.stringify({ build, checks, events }, null, 2));
  }
  return checks;
}
