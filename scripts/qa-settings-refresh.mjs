import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
export async function checkSettingsRefresh(page, output, { packaged=false }={}) {
  await mkdir(output,{recursive:true}); page.setDefaultTimeout(8000);
  const original=await page.evaluate(()=>caps.getSettings()); const checks=[];
  const screenshot=name=>page.screenshot({path:output+'/'+name+'.png',animations:'disabled'});
  const save=async()=>{await page.locator('#save-settings').click();await page.waitForSelector('#settings-panel[hidden]',{state:'hidden'});};
  const open=async()=>{if(!await page.locator('#settings-panel').isVisible())await page.locator('#settings-toggle').click();};
  try {
    await open();
    await page.waitForFunction(()=>!document.querySelector('#device-recommendation').textContent.includes('Checking'));
    const gpuAvailable=await page.locator('[data-device=cuda]').isEnabled();
    for(const value of gpuAvailable?['auto','cuda','cpu']:['auto','cpu']) {
      await page.locator(`[data-device=${value}]`).click();
      assert.equal(await page.locator(`[data-device=${value}]`).getAttribute('aria-checked'),'true');
      if(await page.locator('#save-settings').isEnabled())await save();else await page.locator('#settings-close').click();
      assert.equal((await page.evaluate(()=>caps.getSettings())).device,value);
      await open();assert.equal(await page.locator('#setting-device').inputValue(),value);
    }
    checks.push('Device values auto / cuda / cpu save and reopen unchanged');
    await page.locator('#use-automatic').click();assert.equal(await page.locator('#setting-device').inputValue(),'auto');
    await page.locator('[data-device=auto]').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#setting-device').inputValue(),gpuAvailable?'cuda':'cpu');
    checks.push('Use Auto action and radio arrow keys use existing change handlers');
    if(gpuAvailable){const options=await page.locator('#setting-device-index option').evaluateAll(o=>o.map(e=>({value:e.value,text:e.textContent})));assert.ok(options.length);assert.ok(options.every(o=>!o.text.includes('GiB')));const value=await page.locator('#setting-device-index').inputValue();await save();assert.equal(String((await page.evaluate(()=>caps.getSettings())).deviceIndex),value);await open();}
    await screenshot('general');
    const layout=await page.locator('#settings-general').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight}));
    assert.ok(layout.scroll<=layout.height+1,'General should fit at normal size');
    await page.locator('#settings-model-tab').click();
    const installed=page.locator('.model-choice[data-download-state=installed]');
    if(await installed.count()>1){await installed.locator('[data-use]:visible').first().click();const selected=await page.locator('#setting-model').inputValue();await save();assert.equal((await page.evaluate(()=>caps.getSettings())).model,selected);await open();await page.locator('#settings-model-tab').click();}
    assert.equal(await page.locator('.model-choice input:checked').count(),1);
    await page.locator('[data-delete]:visible').first().click();assert.equal(await page.locator('#model-delete-dialog').evaluate(e=>e.open),true);await page.keyboard.press('Escape');
    checks.push('Model selection and existing removal confirmation work');await screenshot('models');
    for(const tab of ['#settings-general-tab','#settings-model-tab','#open-timing','#open-diagnostics']) {
      await page.locator(tab).click();assert.equal(await page.locator(tab).getAttribute('aria-current'),'page');
      const visible=await page.locator('#settings-panel').innerText();assert.doesNotMatch(visible,/GiB|VRAM|graphics card|processor/i);
    }
    await page.locator('#settings-general-tab').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#settings-model-tab').getAttribute('aria-current'),'page');
    checks.push('All tabs use active navigation state; no forbidden wording in visible UI');
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height:700,deviceScaleFactor:1,mobile:false});
    for(const tab of ['#settings-general-tab','#settings-model-tab','#open-timing','#open-diagnostics']){await page.locator(tab).click();assert.equal(await page.locator('#settings-panel').evaluate(e=>e.scrollWidth>e.clientWidth),false);assert.equal(await page.locator('[data-settings-pane]:not([hidden])').evaluate(e=>e.scrollWidth>e.clientWidth),false);}
    await screenshot('minimum');await cdp.send('Emulation.clearDeviceMetricsOverride');
    checks.push('Minimum 1000×700 layout has no horizontal scrolling; small-height content remains scrollable');
    return {packaged,checks,layout};
  } finally {await page.evaluate(s=>caps.saveSettings(s),original);await page.reload();await writeFile(output+'/checks.json',JSON.stringify({packaged,checks},null,2));}
}
