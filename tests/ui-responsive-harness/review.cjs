// Native QA of the final packaged renderer/preload, with isolated SRT fixtures.
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFile, writeFile, mkdir, copyFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'data/ui-qa/review-responsive/packaged');
app.setPath('userData', path.join(output,'profile'));
app.setPath('crashDumps',path.join(output,'crashes'));
app.whenReady().then(async()=>{
  await mkdir(output,{recursive:true});
  const { launcherRuntime } = await import(pathToFileURL(path.join(root,'scripts/clean-project.mjs')));
  const build=await launcherRuntime(path.join(root,'Caps.exe'),root);
  const asar=path.join(build,'resources/app.asar');
  const { createPreviewStore } = await import(pathToFileURL(path.join(asar,'src/desktop/preview-store.js')));
  const { exportSrt } = await import(pathToFileURL(path.join(asar,'src/exporters/srt.js')));
  const store=createPreviewStore(),results=[];
  const media=path.join(output,'preview.mp4');
  await copyFile(path.join(root,'data/ui-qa/player.mp4'),media);
  for(let i=0;i<5;i++){
    const outputPath=path.join(output,`review-${i}.srt`);
    await writeFile(outputPath,exportSrt(Array.from({length:43},(_,n)=>({start:n*200,end:n*200+195,text:`Caption number ${n+1} for review`}))));
    results.push({...store.register({inputPath:media,inputName:`Interview ${i+1} with a longer filename.${i%2?'wav':'mp4'}`,outputPath,alignedWordCount:215,generatedCaptionCount:43,validation:{valid:true},processingDurationMs:2400},media),mediaUrl:pathToFileURL(media).href,mediaKind:i%2?'audio':'video'});
  }
  const handle=(channel,fn)=>ipcMain.handle('caps:'+channel,async(_, ...args)=>{try{return {ok:true,value:await fn(...args)};}catch(e){return {ok:false,error:{name:e.name,message:e.message,code:e.code}};}});
  handle('get-settings',()=>({model:'large-v3-turbo',device:'cpu',mode:'dynamic',timing:{minDurationMs:100,bridgeGapMs:80}}));
  handle('get-model-downloads',()=>({activeId:null,models:{'large-v3-turbo':{state:'installed'}},catalog:{}}));
  handle('get-diagnostics',()=>({memory:{totalBytes:32*1024**3},whisperx:{available:true},cuda:{available:false,devices:[]},runtimes:{cpu:{available:true}},models:[{id:'large-v3-turbo',installed:true}],model:{valid:true}}));
  handle('select-input',()=>[media]);
  handle('inspect-input',()=>({path:media,name:'preview.mp4',extension:'MP4',size:16872}));
  handle('suggest-output',()=>path.join(output,'preview.srt'));
  handle('check-batch',()=>({conflicts:[]}));
  handle('start-queue',()=>results);
  handle('get-preview',r=>store.page(r));
  handle('save-captions',r=>store.save(r));
  handle('copy-text',()=>true);handle('open-output-folder',()=>true);
  const window=new BrowserWindow({show:false,width:1180,height:820,titleBarStyle:'hidden',titleBarOverlay:{color:'#202020',symbolColor:'#ececef',height:64},webPreferences:{preload:path.join(asar,'src/desktop/preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  const run=s=>window.webContents.executeJavaScript(s,true);
  const errors=[];window.webContents.on('console-message',(_,d)=>{if(d.level==='error')errors.push(d.message);});
  const wait=async s=>{for(let n=0;n<100;n++){if(await run(s))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+s);};
  await window.loadFile(path.join(asar,'src/desktop/renderer/index.html'));
  await run(`document.querySelector('#select-input').click()`);
  await wait(`!document.querySelector('#start-job').disabled`);
  await run(`document.querySelector('#start-job').click()`);
  await wait(`!document.querySelector('#completed-view').hidden && !!document.querySelector('.caption-text') && document.querySelector('video').readyState>=2`);
  await run(`Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))`);
  const layouts=[];
  for(const kind of ['video','audio']){
    await run(`document.querySelectorAll('.batch-result')[${kind==='audio'?1:4}].click()`);
    await wait(`document.querySelector('#editor-status').dataset.state==='saved'`);
    for(const [width,height,zoom] of [[1180,820,1],[1000,700,1],[1366,768,1],[1366,768,1.25],[1366,768,1.5],[1920,1080,1],[1920,1080,1.25],[1920,1080,1.5]]){
      window.setContentSize(width,height);window.webContents.setZoomFactor(zoom);
      await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      const layout=await run(`(()=>{
        const b=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
        const batch=document.querySelector('#batch-results'),tab=batch.querySelector('[aria-pressed="true"]'),tr=tab.getBoundingClientRect(),br=batch.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,mainScroll:document.querySelector('main').scrollHeight>document.querySelector('main').clientHeight,player:b('.playback-panel'),toolbar:b('.player-toolbar'),list:b('.table-wrap'),footer:b('.review-status'),batchClipped:batch.scrollHeight>batch.clientHeight,selectedVisible:tr.left>=br.left-1&&tr.right<=br.right+1,controls:[...document.querySelectorAll('.player-toolbar > button,.speed-control > button,.volume-control > button')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,height:r.height};}),colors:['#open-folder .material-icon','#process-another .ui-icon','.review-search > svg','[data-player="back"]','[data-player="mute"]'].map(s=>getComputedStyle(document.querySelector(s)).color)};
      })()`);
      layouts.push({kind,zoom,...layout});
      assert.equal(layout.overflow,false);assert.equal(layout.mainScroll,false);assert.equal(layout.batchClipped,false);assert.equal(layout.selectedVisible,true);
      assert.ok(layout.footer.bottom<=layout.height+1);assert.ok(layout.list.height>60);assert.equal(new Set(layout.colors).size,1);
      for(const c of layout.controls)assert.ok(c.x>=layout.toolbar.x-1&&c.right<=layout.toolbar.right+1&&c.width>=43.9&&c.height>=43.9);
      await writeFile(path.join(output,`${kind}-${width}x${height}-${zoom}.png`),(await window.webContents.capturePage()).toPNG());
    }
  }
  window.setContentSize(1180,820);window.webContents.setZoomFactor(1);
  await run(`document.querySelector('.cue-seek').click();const input=document.querySelector('.caption-text');input.value='Verified packaged review edit';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await run(`document.querySelector('#editor-status').dataset.state`),'unsaved');
  await run(`document.querySelector('#save-captions').click()`);
  await wait(`document.querySelector('#editor-status').dataset.state==='saved'`);
  assert.ok((await readFile(results[1].outputPath,'utf8')).includes('Verified packaged review edit'));
  await run(`document.querySelectorAll('.batch-result')[4].click()`);await wait(`document.querySelector('#editor-status').dataset.state==='saved'`);
  await run(`document.querySelectorAll('.batch-result')[1].click()`);await wait(`document.querySelector('.caption-text').value==='Verified packaged review edit'`);
  await run(`const input=document.querySelector('#preview-search');input.value='no-matches-qa';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await wait(`!document.querySelector('#caption-empty').hidden`);
  await run(`document.querySelector('#clear-caption-search').click()`);await wait(`!!document.querySelector('.caption-text')`);
  await run(`document.querySelector('[data-player="play"]').click()`);await wait(`!document.querySelector('video').paused`);
  await run(`document.querySelector('[data-player="play"]').click()`);await wait(`document.querySelector('video').paused`);
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'),JSON.stringify({build,packagedRenderer:true,fixtureBackend:true,layouts,checks:['video/audio layouts at 16 native size/zoom combinations','batch active visibility','icon colors','caption editing and actual SRT disk save','switch files and restore edit','search/clear','play/pause'],errors},null,2));
  console.log('Final packaged renderer: 16 native size/zoom layouts, real SRT disk save, batch navigation, search and playback passed.');
  window.destroy();app.quit();
}).catch(async e=>{await mkdir(output,{recursive:true});await writeFile(path.join(output,'error.txt'),e.stack||String(e));console.error(e);app.exit(1);});
