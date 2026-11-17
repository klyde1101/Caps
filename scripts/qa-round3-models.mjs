import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Use ONLY the final-isolated root populated with disposable model files.
export async function checkModelDialogs(page, output) {
  const checks = [];
  const dialog = page.locator('#model-delete-dialog');
  const trash = page.locator('[data-model="large-v3-turbo"] [data-delete]');
  for (const action of ['cancel', 'escape', 'backdrop', 'native-close']) {
    await trash.click({ timeout: 5000 });
    assert.equal(await dialog.locator('[data-dismiss]').evaluate(e => e === document.activeElement), true);
    if (action === 'cancel') await dialog.locator('[data-dismiss]').click();
    else if (action === 'escape') await page.keyboard.press('Escape');
    else if (action === 'backdrop') await page.mouse.click(5, 5);
    else await dialog.evaluate(e => e.close());
    await page.waitForFunction(() => !document.querySelector('#model-delete-dialog').open && !document.querySelector('[data-model="large-v3-turbo"] [data-delete]').disabled);
    assert.equal(await page.locator('#setting-model').inputValue(), 'large-v3-turbo');
    checks.push({ action, passed: true });
  }
  await trash.click(); await page.screenshot({ path: join(output, 'packaged-delete-dialog.png') });
  await dialog.locator('[data-confirm]').evaluate(e => { e.click(); e.click(); });
  await page.waitForFunction(() => document.querySelector('#setting-model').value === 'small');
  assert.equal((await page.evaluate(() => caps.getSettings())).model, 'small');
  checks.push({ action: 'double confirm, selected deletion and persisted fallback', passed: true });
  await page.locator('[data-model="small"] [data-delete]').click();
  await dialog.locator('[data-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#setting-model').value === 'none');
  assert.equal((await page.evaluate(() => caps.getSettings())).model, 'none');
  assert.equal(await page.locator('[data-install]:visible').count(), 2);
  await page.screenshot({ path: join(output, 'packaged-settings-none.png') });
  checks.push({ action: 'last-model deletion, persisted None and Download actions', passed: true });
  await page.locator('#settings-close').click();
  await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'file'; input.id = 'qa-source'; input.hidden = true; document.body.append(input);
  });
  const session = await page.context().newCDPSession(page), doc = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#qa-source' });
  await session.send('DOM.setFileInputFiles', { nodeId, files: [join(output, 'release-single.mp4')] });
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(document.querySelector('#qa-source').files[0]);
    document.querySelector('#drop-zone').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  });
  await page.waitForFunction(() => !document.querySelector('#open-model-settings').hidden);
  assert.equal(await page.locator('#start-job').isDisabled(), true);
  await page.screenshot({ path: join(output, 'packaged-home-blocked.png') });
  checks.push({ action: 'Generate blocked with model-settings action', passed: true });
  await page.reload();
  assert.equal((await page.evaluate(() => caps.getSettings())).model, 'none');
  checks.push({ action: 'None survives renderer restart', passed: true });
  await writeFile(join(output, 'packaged-model-report.json'), JSON.stringify({ checks }, null, 2));
  return checks;
}
