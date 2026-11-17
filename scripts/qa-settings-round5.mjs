import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkSettings(page, output, { packaged = false } = {}) {
  await mkdir(output, { recursive: true });
  const original = await page.evaluate(() => caps.getSettings());
  const checks = [], measures = [];
  const shot = name => page.screenshot({ path: join(output, name + '.png'), timeout: 5000, animations: 'disabled' });
  const record = name => checks.push({ name, passed: true });
  async function measure(name) {
    const result = await page.evaluate(() => {
      const root = document.querySelector('#settings-panel');
      const visible = e => !e.closest('[hidden],.sr-only') && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), sizes = [];
      while (walker.nextNode()) {
        const e = walker.currentNode.parentElement;
        if (walker.currentNode.textContent.trim() && visible(e)) sizes.push({ text: walker.currentNode.textContent.trim(), size: parseFloat(getComputedStyle(e).fontSize) });
      }
      const buttons = [...root.querySelectorAll('button')].filter(visible);
      return { minFont: Math.min(...sizes.map(s => s.size)), smallText: sizes.filter(s => s.size < 13),
        minButtonHeight: Math.min(...buttons.map(e => e.getBoundingClientRect().height)),
        title: getComputedStyle(document.querySelector('#settings-title')).fontSize,
        saveHeight: document.querySelector('#save-settings').getBoundingClientRect().height,
        bodyWidth: root.scrollWidth, width: root.clientWidth,
        backdrop: getComputedStyle(document.querySelector('#settings-scrim')).backgroundColor };
    });
    assert.ok(result.minFont >= 13, JSON.stringify(result.smallText));
    assert.ok(result.minButtonHeight >= 40); assert.equal(result.title, '24px'); assert.ok(result.saveHeight >= 48);
    assert.ok(result.bodyWidth <= result.width + 1); measures.push({ page: name, ...result });
  }
  try {
    await page.waitForFunction(() => !document.querySelector('#hardware-summary').textContent.includes('Detecting'));
    await page.locator('#settings-toggle').click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#settings-panel').getAnimations().every(a => a.playState === 'finished'));
    assert.equal(await page.locator('#settings-general-tab').getAttribute('aria-selected'), 'true');
    await page.locator('[data-device="cpu"]').click();
    assert.equal(await page.locator('#use-automatic').isVisible(), true);
    assert.match(await page.locator('#device-recommendation-detail').textContent(), /CPU is currently selected/);
    assert.equal((await page.evaluate(() => caps.getSettings())).device, original.device);
    await measure('general'); await shot('general-cpu-recommendation');
    await page.locator('#use-automatic').click();
    assert.equal(await page.locator('[data-device="auto"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#use-automatic').isVisible(), false);
    record('CPU choice explained, GPU recommendation and draft-only Use Automatic action');
    await page.locator('#settings-model-tab').click();
    await measure('model'); await shot('models');
    assert.equal(await page.locator('.model-specs').count(), 2);
    assert.equal(await page.locator('.developer-credit').count(), 0);
    assert.equal(await page.locator('[data-model="large-v3-turbo"] .model-selected-check').isVisible(), original.model === 'large-v3-turbo');
    const installedTrash = page.locator('[data-delete]:visible').first();
    await installedTrash.click();
    assert.equal(await page.locator('#model-delete-dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-panel').isVisible(), true);
    assert.equal(await page.locator('#model-delete-dialog').isVisible(), false);
    record('readable specs, solid selection and removal confirmation with Escape');
    await page.locator('#open-timing').click();
    const timingValue = String(Number(await page.locator('#timing-min').inputValue()) + 10);
    await page.locator('#timing-min').fill(timingValue);
    await measure('timing'); await shot('timing');
    await page.locator('#settings-model-tab').click(); await page.locator('#open-timing').click();
    assert.equal(await page.locator('#timing-min').inputValue(), timingValue);
    await page.locator('#open-timing').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#open-diagnostics').getAttribute('aria-selected'), 'true');
    await page.locator('#refresh-diagnostics').click();
    await measure('diagnostics'); await shot('diagnostics');
    record('Timing drafts preserved across tabs; arrow-key navigation and Diagnostics work');
    await page.locator('#save-settings').click();
    await page.waitForFunction(() => document.querySelector('#settings-panel').hidden);
    const saved = await page.evaluate(() => caps.getSettings());
    assert.equal(saved.device, 'auto'); assert.equal(saved.timing.minDurationMs, Number(timingValue));
    await page.locator('#settings-toggle').click();
    assert.equal(await page.locator('[data-device="auto"]').getAttribute('aria-pressed'), 'true');
    await measure('general-auto'); await shot('general-auto');
    await page.locator('#settings-close').focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#save-settings').evaluate(e => e === document.activeElement), false); // Saved button is disabled.
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#settings-panel').isVisible(), false);
    record('Save persists device and timing; reopening, focus containment and Escape work');
    return { checks, measures };
  } finally {
    await page.evaluate(value => caps.saveSettings(value), original);
    await page.reload();
    await writeFile(join(output, 'settings-checks.json'), JSON.stringify({ packaged, checks, measures }, null, 2));
  }
}
