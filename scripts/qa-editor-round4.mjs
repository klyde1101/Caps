import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

export async function installEditorFixture(page, { cueStepMs = 200 } = {}) {
  await page.evaluate(async cueStepMs => {
    const { exportSrt } = await import('/src/exporters/srt.js');
    const cues = Array.from({ length: 43 }, (_, index) => ({ index: index + 1, start: index * cueStepMs, end: index * cueStepMs + cueStepMs - 5,
      text: ['How many patients do we have?', 'Three confirmed for Monday.', 'Let me check the calendar.'][index % 3] }));
    const start = caps.startQueue;
    caps.startQueue = async (...args) => (await start(...args)).map(result => ({ ...result, generatedCaptionCount: cues.length }));
    caps.getPreview = async ({ query = '', offset = 0, limit = 200 }) => {
      const matches = cues.filter(cue => cue.text.toLowerCase().includes(query.toLowerCase()));
      return { cues: matches.slice(offset, offset + limit), total: cues.length, matches: matches.length };
    };
    caps.saveCaptions = async ({ changes }) => { for (const change of changes) cues[change.index - 1].text = change.text; return { original: exportSrt(cues) }; };
  }, cueStepMs);
}

// Real renderer interactions; browser fixtures use in-memory SRT APIs.
export async function checkEditor(page, output, { packaged = false } = {}) {
  await mkdir(output, { recursive: true });
  const checks = [];
  const record = name => checks.push({ name, passed: true });
  const shot = name => page.screenshot({ path: join(output, name + '.png') });
  try {
    await page.waitForFunction(() => document.querySelector('.caption-text'));
    await page.waitForFunction(() => document.querySelector('#editor-status').dataset.state === 'saved');
    const layout = await page.evaluate(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect();
      const css = s => getComputedStyle(document.querySelector(s));
      return { header: rect('.completion-heading').height, row: rect('#preview-body tr').height,
        captionSize: css('.caption-text').fontSize, timeSize: css('.cue-seek').fontSize,
        captionBorder: css('.caption-text').borderTopColor,
        playerWidth: rect('.playback-panel').width / (rect('.editor-workspace').width - 16),
        target: rect('[data-player="play"]').width, icon: rect('[data-player="play"] svg').width,
        seekHit: rect('#player-seek').height, seekTrack: getComputedStyle(document.querySelector('#player-seek'), '::-webkit-slider-runnable-track').height,
        timeBorder: css('#player-current').borderTopWidth,
        footerTop: rect('.editor-actions').top, footerBottom: rect('.editor-actions').bottom, viewport: innerHeight };
    });
    assert.ok(layout.header <= 64); assert.ok(layout.row >= 56); assert.equal(layout.captionSize, '17px');
    assert.equal(layout.timeSize, '14px'); assert.equal(layout.captionBorder, 'rgba(0, 0, 0, 0)');
    assert.ok(Math.abs(layout.playerWidth - .4) < .01); assert.equal(layout.target, 44); assert.equal(layout.icon, 24);
    assert.ok(layout.seekHit >= 24); assert.equal(layout.timeBorder, '0px');
    assert.ok(layout.footerBottom <= layout.viewport); record('compact header, 40% player, 44/24px controls, 17/14px text and borderless 56px rows');
    await shot('editor-saved');
    assert.equal(await page.locator('#save-captions').isDisabled(), true);
    await page.locator('.result-details summary').click();
    assert.equal(await page.locator('.result-facts').isVisible(), true);
    await page.locator('.result-details summary').click(); record('collapsible readable Details');
    await page.locator('#player-shortcuts-button').click();
    assert.equal(await page.locator('#player-shortcuts').evaluate(e => e.matches(':popover-open')), true);
    await shot('shortcuts'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#player-shortcuts').evaluate(e => e.matches(':popover-open')), false);
    record('keyboard help popover and Escape dismissal');
    const input = page.locator('.caption-text').first();
    const original = await input.inputValue();
    const long = 'This longer edited caption grows to show every word and keeps the full text visible while editing without a resize handle.';
    await input.fill(long);
    assert.equal(await page.locator('#editor-status').getAttribute('data-state'), 'unsaved');
    assert.equal(await page.locator('#save-captions').isEnabled(), true);
    const height = await input.evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight, height: e.getBoundingClientRect().height }));
    assert.ok(height.client >= height.scroll); assert.ok(height.height > 56);
    await shot('editor-unsaved');
    await page.locator('#save-captions').click();
    await page.waitForFunction(() => document.querySelector('#editor-status').dataset.state === 'saved');
    assert.equal(await page.locator('#editor-status').textContent(), 'Saved ✓');
    await page.locator('#reload-captions').click();
    await page.waitForFunction(text => document.querySelector('.caption-text')?.value === text, long);
    record('auto-growing edits, unsaved dot, save state and SRT reload');
    await page.locator('.caption-text').first().fill(original); await page.locator('#save-captions').click();
    await page.waitForFunction(() => document.querySelector('#editor-status').dataset.state === 'saved');
    await page.locator('#caption-player').focus();
    const followTime = await page.locator('#preview-body tr[data-cue] .cue-seek').evaluateAll(buttons => {
      const startButtons = buttons.filter((_, index) => index % 2 === 0);
      const text = startButtons[Math.floor(startButtons.length * .75)].textContent;
      return text.replace(',', '.').split(':').reduce((total, value) => total * 60 + Number(value), 0) + .02;
    });
    await page.locator('video').evaluate(async (v, time) => { v.currentTime = time; await v.play(); }, followTime);
    await page.waitForFunction(() => document.querySelector('.cue-playing[aria-current="true"]'));
    await page.waitForFunction(() => document.querySelector('.preview .table-wrap').scrollTop > 0);
    await page.waitForFunction(() => {
      const row = document.querySelector('.cue-playing'), pane = document.querySelector('.preview .table-wrap');
      if (!row) return false;
      const r = row.getBoundingClientRect(), p = pane.getBoundingClientRect();
      return r.top >= p.top + pane.querySelector('thead').getBoundingClientRect().height && r.bottom <= p.bottom;
    });
    const active = await page.locator('.cue-playing').evaluate(e => ({ cue: e.dataset.cue, color: getComputedStyle(e.firstElementChild).backgroundColor, bar: getComputedStyle(e.firstElementChild).boxShadow }));
    assert.notEqual(active.color, 'rgba(0, 0, 0, 0)'); assert.match(active.bar, /inset/);
    await page.locator('video').evaluate(v => v.pause()); await shot('active-caption');
    await page.locator('#preview-body tr[data-cue] .cue-seek').last().click();
    const seeked = await page.locator('video').evaluate(v => v.currentTime); assert.ok(seeked > followTime);
    record('playback highlight, accent bar, auto-scroll and timestamp seeking');
    const scrubber = await page.locator('#player-seek').boundingBox();
    await page.locator('#player-seek').click({ position: { x: scrubber.width / 2, y: 12 } });
    const scrubbed = await page.locator('video').evaluate(v => Math.abs(v.currentTime - v.duration / 2));
    assert.ok(scrubbed < .3); record('24px scrubber hit area seeks on click');
    await page.locator('[data-player="fullscreen"]').click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.locator('#caption-player').focus(); await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.fullscreenElement);
    record('fullscreen and keyboard controls');
    return { packaged, checks, layout };
  } finally { await writeFile(join(output, 'editor-checks.json'), JSON.stringify({ packaged, checks }, null, 2)); }
}
