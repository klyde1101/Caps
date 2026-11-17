// Real DOM/dialog interaction with in-memory model APIs; never deletes user models.
import { chromium } from '../data/ui-qa/round3/tooling/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const out = new URL('../data/ui-qa/round3/browser/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
const report = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
async function load(mode = '') {
  await page.goto('http://127.0.0.1:8766/src/desktop/renderer/index.html?mode=' + mode);
  await page.waitForFunction(() => document.querySelector('[data-model="large-v3-turbo"]')?.dataset.downloadState === (new URL(location.href).searchParams.get('mode') === 'none' ? 'idle' : 'installed'));
  await page.locator('#settings-toggle').click();
  await page.locator('[data-model="large-v3-turbo"] [data-delete]').waitFor({ state: mode === 'none' ? 'hidden' : 'visible' });
}
async function open() {
  await page.locator('[data-model="large-v3-turbo"] [data-delete]').click();
  await page.locator('#model-delete-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#model-delete-dialog [data-dismiss]').evaluate(el => el === document.activeElement), true);
}
try {
  await load();
  for (const action of ['cancel', 'escape', 'backdrop', 'native-close']) {
    await open();
    if (action === 'cancel') await page.locator('#model-delete-dialog [data-dismiss]').click();
    if (action === 'escape') await page.keyboard.press('Escape');
    if (action === 'backdrop') await page.mouse.click(5, 5);
    if (action === 'native-close') await page.locator('#model-delete-dialog').evaluate(el => el.close());
    await page.locator('#model-delete-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('[data-model="large-v3-turbo"] [data-delete]').disabled);
    assert.equal(await page.evaluate(() => qaDeletes.length), 0);
    assert.equal(await page.locator('#settings-panel').isVisible(), true);
    report.push({ case: action, passed: true });
  }
  await open();
  await page.screenshot({ path: new URL('delete-dialog.png', out).pathname.replace(/^\/(\w:)/, '$1') });
  await page.locator('#model-delete-dialog [data-confirm]').evaluate(el => { el.click(); el.click(); });
  await page.waitForFunction(() => document.querySelector('#setting-model').value === 'small');
  assert.deepEqual(await page.evaluate(() => qaDeletes), ['large-v3-turbo']);
  report.push({ case: 'double confirm and selected-model fallback', passed: true });
  await load('locked'); await open();
  await page.locator('#model-delete-dialog [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#settings-status').textContent.includes('locked'));
  assert.equal(await page.locator('#setting-model').inputValue(), 'large-v3-turbo');
  assert.equal(await page.locator('[data-model="large-v3-turbo"] [data-delete]').isVisible(), true);
  report.push({ case: 'failed delete leaves selection and installed state', passed: true });
  await load('last'); await open();
  await page.locator('#model-delete-dialog [data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#setting-model').value === 'none');
  assert.equal(await page.locator('[data-install]:visible').count(), 2);
  report.push({ case: 'last model resolves, selects None and offers downloads', passed: true });
  await page.locator('#settings-close').click();
  await page.locator('#select-input').click();
  await page.waitForFunction(() => document.querySelector('#ready-status').textContent.includes('not downloaded'));
  assert.equal(await page.locator('#start-job').isDisabled(), true);
  assert.equal(await page.locator('#open-model-settings').isVisible(), true);
  report.push({ case: 'no model blocks Generate with settings action', passed: true });
  await page.screenshot({ path: new URL('none-blocked.png', out).pathname.replace(/^\/(\w:)/, '$1') });
  for (const mode of ['none', 'low-vram', 'cpu']) {
    await load(mode);
    await page.screenshot({ path: new URL('settings-' + mode + '.png', out).pathname.replace(/^\/(\w:)/, '$1') });
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(new URL('report.json', out), JSON.stringify({ report, errors }, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
