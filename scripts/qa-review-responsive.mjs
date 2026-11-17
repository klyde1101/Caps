import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, extname, normalize } from 'node:path';
import { fixture } from '../tests/ui-responsive-harness/browser-preview.mjs';
import { createRequire } from 'node:module';
import { launcherRuntime } from './clean-project.mjs';
import { chromium } from '../data/ui-qa/round3/tooling/node_modules/playwright-core/index.mjs';
import { checkReview } from './qa-review-round6.mjs';
import { installEditorFixture } from './qa-editor-round4.mjs';

export async function checkReviewLayouts(page, output) {
  const layouts = [];
  const originalViewport = page.viewportSize();
  for (const [width,height] of [[1180,820],[1000,700],[1366,768],[1920,1080],[1093,614],[911,512],[1280,720],[700,820]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate(() => {
      const rect = e => { const b = e.getBoundingClientRect(); return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}; };
      const visible = e => e.getClientRects().length;
      const toolbar = document.querySelector('.player-toolbar');
      const tabs = [...document.querySelectorAll('.batch-result')];
      return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
        mainScroll: document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight,
        workspace: rect(document.querySelector('.editor-workspace')), player: rect(document.querySelector('.playback-panel')),
        list: rect(document.querySelector('.table-wrap')), footer: rect(document.querySelector('.review-status')),
        toolbar: rect(toolbar), controls: [...toolbar.querySelectorAll('button')].filter(visible).map(rect),
        tabs: tabs.map(e => ({box:rect(e), children:[...e.children].map(rect)})),
        batch:rect(document.querySelector('#batch-results')), batchOverflowY:document.querySelector('#batch-results').scrollHeight > document.querySelector('#batch-results').clientHeight,
        header:rect(document.querySelector('.completion-heading')),
        actions:[...document.querySelectorAll('.completion-heading .actions button')].map(rect),
        colors: ['#open-folder .material-icon','#process-another .ui-icon','.review-search > svg','[data-player="back"]','[data-player="mute"]'].map(s => getComputedStyle(document.querySelector(s)).color) };
    });
    layouts.push(layout);
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    assert.equal(layout.mainScroll, false, JSON.stringify(layout));
    assert.ok(layout.footer.bottom <= height + 1);
    assert.ok(layout.list.height >= 60);
    assert.equal(layout.batchOverflowY,false,'Batch labels must not be clipped');
    for (const tab of layout.tabs) for (const child of tab.children) assert.ok(child.y >= tab.box.y && child.bottom <= tab.box.bottom + 1);
    for (const b of layout.actions) assert.ok(b.right <= width && b.bottom <= layout.header.bottom);
    for (const b of layout.controls) assert.ok(b.x >= layout.toolbar.x && b.right <= layout.toolbar.right + 1);
    assert.equal(new Set(layout.colors).size,1,'Action and playback icons share the accent');
    await page.screenshot({path:`${output}/layout-${width}x${height}.png`});
  }
  await page.setViewportSize(originalViewport);
  await writeFile(`${output}/responsive-layouts.json`,JSON.stringify(layouts,null,2));
  return layouts;
}

if (process.argv[1]?.endsWith('qa-review-responsive.mjs')) {
  const packaged = process.argv.includes('--packaged');
  const output = 'data/ui-qa/review-responsive/'+(packaged?'packaged-browser':'browser');
  const asar = packaged ? createRequire(import.meta.url)('@electron/asar') : null;
  const archive = packaged ? resolve(await launcherRuntime(resolve('Caps.exe'),resolve('.')),'resources/app.asar') : null;
  await mkdir(output,{recursive:true});
  const browser = await chromium.launch({ executablePath:'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',headless:true });
  try {
    const page = await browser.newPage({viewport:{width:1180,height:820}});
    await page.route('http://127.0.0.1:8766/**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:fixture});
      const file=resolve('.'+(pathname==='/test.mp4'?'/data/ui-qa/player.mp4':pathname));
      let body=packaged&&pathname.startsWith('/src/') ? asar.extractFile(archive,normalize(pathname.slice(1))) : await readFile(file);
      if(pathname==='/test.mp4'){
        const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range??'');
        if(range){const start=Number(range[1]),end=Math.min(body.length-1,range[2]?Number(range[2]):body.length-1);return route.fulfill({status:206,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${body.length}`},body:body.subarray(start,end+1)});}
      }
      if(pathname.endsWith('index.html'))body=Buffer.from(body.toString().replace('<script type="module" src="app.js"></script>','<script type="module" src="/fixture.js"></script>'));
      await route.fulfill({contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'})[extname(file)]??'application/octet-stream',body});
    });
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8766/src/desktop/renderer/index.html');
    await installEditorFixture(page,{cueStepMs:1000});
    await page.evaluate(() => {
      const start=caps.startQueue;
      caps.startQueue=async(...args)=>(await start(...args)).flatMap(r=>Array.from({length:8},(_,i)=>({...r,inputName:`Interview ${i+1} with a longer filename.wav`,outputPath:`C:/Demo/Interview-${i+1}_SOCIAL-MEDIA.srt`,previewToken:`fixture-${i}`})));
    });
    await page.locator('#select-input').click();
    await page.locator('#start-job').click();
    await page.waitForSelector('#completed-view:not([hidden])');
    await page.waitForFunction(() => !!document.querySelector('.caption-text'));
    await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
    await checkReviewLayouts(page,output);
    await checkReview(page,output,{packaged});
    await page.evaluate(() => { document.querySelector('.caps-player').classList.add('audio-only'); document.querySelector('#audio-placeholder').hidden=false; });
    await mkdir(output+'/audio',{recursive:true});
    await checkReviewLayouts(page,output+'/audio');
    assert.deepEqual(errors,[]);
    await writeFile(output+'/run.json',JSON.stringify({packaged,archive,fixtureBackend:true,errors},null,2));
    console.log(`${packaged?'Final packaged renderer':'Source renderer'}: responsive batch video/audio layouts and review interactions passed.`);
  } finally { await browser.close(); }
}
