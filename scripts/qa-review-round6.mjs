import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkReview(page, output, { packaged = false, leave = false } = {}) {
  await mkdir(output, { recursive: true });
  page.setDefaultTimeout(8000);
  const checks = [], layouts = [];
  const record = name => checks.push({ name, passed: true });
  const video = page.locator('video'), root = page.locator('#caption-player');
  const shot = name => page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' });
  const playButton = page.locator('[data-player="play"]');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))); });
  const cdp = await page.context().newCDPSession(page);
  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) for (const scale of [1, 1.25, 1.5]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.round(size.width / scale), height: Math.round(size.height / scale), deviceScaleFactor: scale, mobile: false });
    const layout = await page.evaluate(({ size, scale }) => {
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const elements = [...document.querySelectorAll('#completed-view *, .topbar *')].filter(visible);
      const text = elements.filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
      const targets = elements.filter(e => e.matches('button,input,textarea'));
      const bounds = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom, right: b.right }; };
      return { size, scale, viewport: { width: innerWidth, height: innerHeight }, minText: Math.min(...text.map(e => parseFloat(getComputedStyle(e).fontSize))),
        smallTargets: targets.filter(e => e.getBoundingClientRect().height < 39.9 || e.getBoundingClientRect().width < 39.9).map(e => ({ id: e.id, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth, mainScroll: document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight,
        player: bounds('.playback-panel'), video: bounds('.video-stage'), toolbar: bounds('.player-toolbar'), list: bounds('.table-wrap'), status: bounds('.review-status'),
        transport: [...document.querySelectorAll('.player-toolbar > button,.player-toolbar .speed-control > button,.player-toolbar .volume-control > button')].map(e => { const b = e.getBoundingClientRect(); return { name: e.getAttribute('aria-label'), left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; }) };
    }, { size, scale });
    layouts.push(layout);
    assert.ok(layout.minText >= 14); assert.equal(layout.smallTargets.length, 0, JSON.stringify(layout.smallTargets));
    assert.equal(layout.horizontalOverflow, false); assert.equal(layout.mainScroll, false);
    assert.ok(layout.status.bottom <= layout.viewport.height + 1);
    assert.ok(layout.toolbar.bottom <= layout.player.bottom);
    for (const control of layout.transport) {
      assert.ok(control.left >= layout.toolbar.x - .5 && control.right <= layout.toolbar.right + .5, `${control.name} leaves the toolbar at ${size.width} × ${size.height}, ${scale * 100}%`);
      assert.ok(control.width >= 43.9 && control.height >= 43.9);
    }
    await shot(`after-${size.width}x${size.height}-${scale}`);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  record('Six size/scale combinations: minimum 14px text, 40px targets, no body scrolling or overflow (device-scale emulation)');
  await playButton.focus();
  await page.waitForFunction(() => document.querySelector('#review-tooltip').matches(':popover-open'));
  assert.equal(await page.locator('#review-tooltip').textContent(), 'Play (Space)');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#review-tooltip').evaluate(e => e.matches(':popover-open')), false);
  await playButton.click(); await page.waitForFunction(() => !document.querySelector('video').paused);
  assert.equal(await playButton.getAttribute('data-tooltip'), 'Pause (Space)');
  await playButton.click();
  await video.evaluate(v => { v.currentTime = 6.5; });
  await page.locator('[data-player="back"]').click(); assert.ok(Math.abs(await video.evaluate(v => v.currentTime) - 1.5) < .2);
  await page.locator('[data-player="forward"]').click(); assert.ok(Math.abs(await video.evaluate(v => v.currentTime) - 6.5) < .2);
  await page.locator('#player-speed-button').click(); await page.locator('[data-speed="1.5"]').click();
  assert.equal(await video.evaluate(v => v.playbackRate), 1.5);
  assert.equal(await page.locator('[data-speed="1.5"]').getAttribute('aria-checked'), 'true');
  await page.locator('#player-speed-button').click(); await page.locator('[data-speed="1"]').click();
  await page.locator('[data-player="mute"]').hover();
  const volumeBounds = await page.locator('#player-volume').boundingBox();
  await page.locator('#player-volume').click({ position: { x: volumeBounds.width * .4, y: volumeBounds.height / 2 } });
  assert.ok(Math.abs(await video.evaluate(v => v.volume) - .4) < .1);
  await page.locator('[data-player="mute"]').click(); assert.equal(await video.evaluate(v => v.muted), true);
  await page.locator('[data-player="mute"]').click(); assert.equal(await video.evaluate(v => v.muted), false);
  record('Icon-only controls, exact tooltips, play/pause, ±5 seconds, speed checks, volume and mute');
  await root.focus(); await page.keyboard.press('m'); assert.equal(await video.evaluate(v => v.muted), true);
  await page.keyboard.press('m'); await video.evaluate(v => { v.currentTime = 7; });
  await page.keyboard.press('ArrowLeft'); assert.ok(Math.abs(await video.evaluate(v => v.currentTime) - 2) < .2);
  await page.keyboard.press('ArrowRight'); assert.ok(Math.abs(await video.evaluate(v => v.currentTime) - 7) < .2);
  await page.keyboard.press('Space'); await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.keyboard.press('Space'); await page.waitForFunction(() => document.querySelector('video').paused);
  await page.keyboard.press('f'); await page.waitForFunction(() => !!document.fullscreenElement);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.fullscreenElement);
  const seek = await page.locator('#player-seek').boundingBox();
  await page.mouse.move(seek.x + seek.width * .25, seek.y + seek.height / 2); await page.mouse.down();
  await page.mouse.move(seek.x + seek.width * .7, seek.y + seek.height / 2, { steps: 12 }); await page.mouse.up();
  assert.ok(Math.abs(await video.evaluate(v => v.currentTime / v.duration) - .7) < .1);
  record('Space, arrows, M, F and Escape shortcuts; fullscreen; slider drag');
  await root.focus(); await page.waitForTimeout(4200);
  const follow = await page.locator('#preview-body tr[data-cue]').nth(3).evaluate(row => {
    const time = row.querySelector('.cue-seek').textContent.split(':'); return { index: row.dataset.cue, time: Number(time[0]) * 60 + Number(time[1]) + .03 };
  });
  await video.evaluate(async (v, time) => { v.currentTime = time; await v.play(); }, follow.time);
  await page.waitForFunction(index => document.querySelector('.cue-selected')?.dataset.cue === index, follow.index);
  await video.evaluate(v => v.pause());
  await page.locator('.table-wrap').dispatchEvent('wheel', { deltaY: 56 });
  await video.evaluate(async v => { v.currentTime = .4; await v.play(); });
  assert.equal(await page.locator('.cue-selected').getAttribute('data-cue'), follow.index);
  await video.evaluate(v => v.pause());
  record('Playback follows the selected caption; recent manual scrolling suspends selection following');
  const first = page.locator('#preview-body tr[data-cue]').first(), input = first.locator('textarea');
  await first.locator('.cue-seek').first().click();
  assert.equal(await first.getAttribute('aria-selected'), 'true'); assert.equal(await input.getAttribute('readonly'), null);
  const start = await first.locator('.cue-seek').first().textContent(); assert.match(start, /^\d+:\d{2}\.\d{3}$/);
  const listVolume = await video.evaluate(v => v.volume);
  await page.locator('.table-wrap').focus(); await page.keyboard.press('ArrowUp');
  assert.equal(await video.evaluate(v => v.volume), listVolume);
  assert.equal(await first.evaluate(e => e === document.activeElement), true);
  await page.locator('.table-wrap').focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#preview-body tr[data-cue]').nth(1).getAttribute('aria-selected'), 'true');
  await page.locator('.table-wrap').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#preview-body tr[data-cue]').nth(1).locator('textarea').evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Escape'); await page.keyboard.press('ArrowUp');
  record('List-container Up/Down selects captions without changing volume; Enter opens the selected caption field');
  if (await page.locator('#preview-body tr[data-cue]').count() > 12) {
    await page.locator('#preview-body tr[data-cue]').last().click();
    await page.locator('#preview-body tr[data-cue]').last().focus();
    for (let n = 0; n < 10; n++) await page.keyboard.press('ArrowUp');
    const uncovered = await page.evaluate(() => {
      const row = document.querySelector('.cue-selected').getBoundingClientRect();
      const heading = document.querySelector('.table-wrap th:nth-child(2)').getBoundingClientRect();
      return row.top >= heading.bottom - .5;
    });
    assert.equal(uncovered, true, 'Keyboard selection must stay below the sticky column headings');
    await shot('sticky-keyboard-selection');
    record('Upward keyboard navigation keeps selected captions visible below sticky headings');
    await first.click();
  }
  await first.focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#preview-body tr[data-cue]').nth(1).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Enter'); assert.equal(await page.locator('#preview-body tr[data-cue]').nth(1).locator('textarea').evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Escape'); await page.keyboard.press('ArrowUp');
  await input.focus(); const original = await input.inputValue();
  await input.fill((original + ' ').repeat(30));
  assert.ok(await input.evaluate(e => e.clientHeight >= e.scrollHeight));
  await input.fill(original + ' QA edit');
  assert.equal(await page.locator('#editor-status').textContent(), '1 unsaved change');
  await video.evaluate(async v => { v.currentTime = 4.5; await v.play(); });
  assert.equal(await first.getAttribute('aria-selected'), 'true'); await video.evaluate(v => v.pause());
  await page.keyboard.press('Control+s'); await page.waitForFunction(() => document.querySelector('#editor-status').dataset.state === 'saved');
  assert.equal(await page.locator('#save-captions').isDisabled(), true);
  await first.click(); await input.fill(original + ' discard me'); await page.locator('#reload-captions').click();
  await page.locator('[data-choice="cancel"]').click(); assert.equal(await input.inputValue(), original + ' discard me');
  await page.locator('#reload-captions').click(); await page.locator('[data-choice="discard"]').click();
  await page.waitForFunction(() => document.querySelector('#editor-status').dataset.state === 'saved');
  assert.equal(await page.locator('#preview-body textarea').first().inputValue(), original + ' QA edit');
  await page.locator('#preview-body tr[data-cue]').first().click(); await page.locator('#preview-body textarea').first().fill(original);
  await page.locator('#save-captions').click(); await page.waitForFunction(() => document.querySelector('#editor-status').dataset.state === 'saved');
  record('One selected row, row seek, Up/Down, Enter/Escape, typing blocks playback selection, edits, Ctrl+S, Save and confirmed Discard/reload');
  await root.focus(); await page.keyboard.press('Control+f');
  assert.equal(await page.locator('#preview-search').evaluate(e => e === document.activeElement), true);
  await page.locator('#preview-search').fill('no-caption-matches-qa-875'); await page.waitForSelector('#caption-empty:not([hidden])');
  await page.locator('#clear-caption-search').click(); await page.waitForSelector('#preview-body tr[data-cue]');
  record('Ctrl+F, live search, no-match state and clear search');
  await page.locator('#preview-body tr[data-cue]').first().click(); await page.locator('#preview-body textarea').first().fill(original + ' leave check');
  await page.locator('#process-another').click(); await page.locator('[data-choice="cancel"]').click();
  assert.equal(await page.locator('#completed-view').isVisible(), true);
  await page.locator('#reload-captions').click(); await page.locator('[data-choice="discard"]').click();
  await page.waitForFunction(() => document.querySelector('#editor-status').dataset.state === 'saved');
  record('Leaving with unsaved edits opens Save / Don’t save / Cancel; Cancel preserves the current screen');
  await page.mouse.move(4, 4); await shot('review-final');
  if (leave) {
    await page.locator('#process-another').click(); await page.waitForSelector('#ready-view:not([hidden])'); record('Add another video returns to Home through existing reset handler');
  }
  const report = { packaged, checks, layouts };
  await writeFile(join(output, 'review-checks.json'), JSON.stringify(report, null, 2));
  return report;
}
