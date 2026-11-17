// Isolated browser QA: real renderer, synthetic media and in-memory model/SRT APIs.
// This fixture never transcribes, downloads or deletes installed models.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wave = Buffer.alloc(44 + 16000 * 2 * 12);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
export const fixture = `
import { exportSrt } from '/src/exporters/srt.js';
const mode = new URL(location.href).searchParams.get('mode');
const states = { 'large-v3-turbo': { state: ['missing','none'].includes(mode) ? 'idle' : 'installed' }, small: { state: ['last','none'].includes(mode) ? 'idle' : 'installed' } };
const cues = Array.from({length:6}, (_,i) => ({index:i+1,start:i*2000,end:i*2000+1800,text:'Caption line '+(i+1)}));
let notify = () => {};
window.qaDeletes = [];
let settings = {model:mode==='none'?'none':'large-v3-turbo',device:mode==='cpu'?'cpu':'cuda',deviceIndex:0};
const snapshot = () => structuredClone({ models: states, catalog: {}, activeId: null });
window.caps = {
 getSettings: async () => settings, saveSettings: async value => (settings={...value}),
 getModelDownloads: async () => snapshot(), onModelDownloads: callback => { notify=callback; },
 installModel: async id => {states[id]={state:'installed'};notify(snapshot());return snapshot();},
 cancelModelInstall: async () => snapshot(),
 deleteModel: async id => { window.qaDeletes.push(id); if(mode==='locked')throw Error('Model files are in use or locked.'); states[id]={state:'idle'}; if(settings.model===id)settings.model=Object.keys(states).find(key=>states[key].state==='installed')??'none'; notify(snapshot());return {...snapshot(),selectedModel:settings.model};},
 getDiagnostics: async () => ({memory:{totalBytes:32*1024**3},cuda:{available:mode!=='no-cuda',devices:mode==='no-cuda'?[]:[{index:0,name:'Test GPU',totalMemoryBytes:8*1024**3,freeMemoryBytes:(mode==='low-vram'?2:8)*1024**3}]},runtimes:{cpu:{available:true},cuda:{available:mode!=='no-cuda'}},whisperx:{available:true,cudaSupport:'supported',path:'Bundled runtime'},model:{valid:states[settings.model]?.state==='installed'},models:Object.entries(states).map(([id,state])=>({id,installed:state.state==='installed',sizeBytes:id==='small'?490000000:1620000000,path:'models/'+id}))}),
 selectInputs: async () => ['C:/Demo/Interview.wav'],
 inspectInput: async path => ({path,name:'Interview.wav',extension:'WAV',size:waveSize}),
 suggestOutput: async () => 'C:/Demo/Interview_SOCIAL-MEDIA.srt',checkBatch:async()=>({conflicts:[]}),
 startQueue: async () => [{inputName:'Interview.wav',inputPath:'C:/Demo/Interview.wav',outputPath:'C:/Demo/Interview_SOCIAL-MEDIA.srt',previewToken:'fixture',mediaUrl:'/test.mp4',alignedWordCount:18,generatedCaptionCount:6,validation:{valid:true},processingDurationMs:2400,totalElapsedMs:8100}],
 getPreview: async ({query='',offset=0,limit=200}) => {const matches=cues.filter(c=>c.text.toLowerCase().includes(query.toLowerCase()));return {cues:matches.slice(offset,offset+limit),offset,total:cues.length,matches:matches.length};},
 saveCaptions: async ({changes}) => {for(const change of changes)cues[change.index-1].text=change.text;return {original:exportSrt(cues)};},
 onQueueChanged:()=>{},onProgress:()=>{},onLog:()=>{},cancelJob:async()=>{},
 openOutputFolder:async()=>{},copyText:async()=>{},pathForFile:()=>''
};
await import('/src/desktop/renderer/app.js');
`.replace('waveSize', String(wave.length));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/test.mp4') {
      const bytes = await readFile(join(root, 'data/ui-qa/player.mp4'));
      res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]), end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
        if (start > end) { res.writeHead(416); res.end(); return; }
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
        res.end(bytes.subarray(start, end + 1)); return;
      }
      res.setHeader('Content-Length', bytes.length); res.end(bytes); return;
    }
    if (url.pathname === '/test.wav') { res.setHeader('Content-Type','audio/wav'); res.setHeader('Content-Length',wave.length); res.end(wave); return; }
    if (url.pathname === '/fixture.js') { res.setHeader('Content-Type','text/javascript'); res.end(fixture); return; }
    const path = resolve(root, '.' + url.pathname);
    if (!path.startsWith(root + sep) || !['src', 'build'].some(folder => path.startsWith(resolve(root, folder) + sep))) {
      res.writeHead(404); res.end(); return;
    }
    let bytes = await readFile(path);
    if (path.endsWith('renderer' + sep + 'index.html')) bytes = Buffer.from(bytes.toString().replace('<script type="module" src="app.js"></script>','<script type="module" src="/fixture.js"></script>'));
    res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'})[extname(path)] ?? 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
if (process.argv[1]?.endsWith('browser-preview.mjs')) server.listen(Number(process.env.CAPS_QA_PORT || 8766), '127.0.0.1', () => console.log('Caps browser QA: http://127.0.0.1:8766/src/desktop/renderer/index.html'));
