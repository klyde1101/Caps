// Run explicitly with Electron; exercises the real renderer, preload and SRT save.
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const output = process.env.CAPS_QA_OUTPUT;
app.setPath('userData', path.join(output, 'profile'));
app.setPath('crashDumps', path.join(output, 'crashes'));
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const { createPreviewStore } = await import(pathToFileURL(path.join(root, 'src/desktop/preview-store.js')));
  const { exportSrt } = await import(pathToFileURL(path.join(root, 'src/exporters/srt.js')));
  const store = createPreviewStore();
  const outputPath = path.join(output, 'editor-test.srt');
  const media = path.join(output, 'preview.mp4');
  const cues = Array.from({ length: 205 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 900, text: `Caption number ${i + 1}` }));
  await writeFile(outputPath, exportSrt(cues));
  const result = store.register({ inputPath: media, inputName: 'preview.mp4', outputPath, alignedWordCount: 615, generatedCaptionCount: 205, validation: { valid: true } }, media);
  const handle = (channel, fn) => ipcMain.handle(`caps:${channel}`, async (_, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: { name: e.name, code: e.code, message: e.message } }; }
  });
  handle('get-settings', () => ({ model: 'large-v3-turbo', device: 'cpu', timing: { minDurationMs: 100, bridgeGapMs: 80 } }));
  handle('get-diagnostics', () => ({ whisperx: { available: true }, cuda: { available: false, devices: [] }, models: [{ id: 'large-v3-turbo', installed: true }], model: { valid: true } }));
  handle('select-input', () => [media]);
  handle('inspect-input', (inputPath) => ({ path: inputPath, name: 'preview.mp4', extension: 'MP4', size: 1024 }));
  handle('suggest-output', () => outputPath);
  handle('check-batch', () => ({ conflicts: [] }));
  handle('save-settings', (settings) => settings);
  handle('start-queue', () => [result]);
  handle('get-preview', (request) => store.page(request));
  handle('save-captions', (request) => store.save(request));
  const window = new BrowserWindow({ show: false, width: 1180, height: 820,
    webPreferences: { preload: path.join(root, 'src/desktop/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  await window.loadFile(path.join(root, 'src/desktop/renderer/index.html'));
  const run = (script) => window.webContents.executeJavaScript(script);
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  await pause();
  const layouts = [];
  async function layout(state) {
    for (const [width, height] of [[1180, 820], [1920, 1080], [1024, 700]]) {
      window.setSize(width, height); await pause();
      const metrics = await run(`(() => {
        const main = document.querySelector('main');
        const view = document.querySelector('#${state}-view');
        const selectors = ${JSON.stringify(state === 'ready' ? ['.hero', '.workflow-grid', '.mode-card', '.export-panel', '#start-job'] : ['.completion-heading', '.editor-workspace', '.video-stage', '.preview', '.preview-pagination', '#save-captions'])};
        return { width: innerWidth, height: innerHeight, scroll: [main.clientHeight, main.scrollHeight],
          panels: selectors.map(s => { const e = document.querySelector(s), r = e.getBoundingClientRect(); return { s, top: r.top, bottom: r.bottom, right: r.right, height: r.height, overflow: e.scrollHeight - e.clientHeight }; }) };
      })()`);
      layouts.push({ state, ...metrics });
      await writeFile(path.join(output, `${state}-${width}.png`), (await window.webContents.capturePage()).toPNG());
      if (metrics.scroll[1] > metrics.scroll[0] + 1 || metrics.panels.some(p => p.bottom > metrics.height + 1 || p.right > metrics.width + 1 || p.height <= 0)) {
        throw new Error(`Workspace overflows: ${JSON.stringify(layouts.at(-1))}`);
      }
    }
  }
  await layout('ready');
  await run(`document.querySelector('#select-input').click()`); await pause();
  await run(`document.querySelector('#start-job').click()`); await pause(); await pause();
  if (!await run(`!document.querySelector('#completed-view').hidden && !!document.querySelector('.caption-text')`)) throw new Error('Editor did not open after generation');
  await layout('completed');
  await run(`(() => { const t = document.querySelector('.caption-text'); t.value = 'Corrected caption'; t.dispatchEvent(new Event('input')); document.querySelector('#caption-video').currentTime = 0.3; })()`);
  await pause();
  const playback = await run(`(async () => { const v = document.querySelector('#caption-video'); await v.play(); return { playing: !v.paused, overlay: document.querySelector('#video-caption').textContent }; })()`);
  if (!playback.playing || playback.overlay !== 'Corrected caption') throw new Error(`Playback/correction sync failed: ${JSON.stringify(playback)}`);
  await run(`document.querySelector('#caption-video').pause(); document.querySelector('#preview-next').click()`); await pause();
  await run(`document.querySelector('#preview-prev').click()`); await pause();
  if (await run(`document.querySelector('.caption-text').value`) !== 'Corrected caption') throw new Error('Draft lost on pagination');
  await run(`document.querySelector('#save-captions').click()`); await pause();
  if (!(await readFile(outputPath, 'utf8')).includes('Corrected caption')) throw new Error('Save failed');
  await run(`document.querySelector('.cue-seek').click()`);
  if (await run(`document.querySelector('#caption-video').currentTime`) > 0.1) throw new Error('Seek failed');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ layouts, playback, saved: true, draftsRetained: true, seek: true, errors }, null, 2));
  window.destroy(); app.quit();
}).catch(async error => {
  await writeFile(path.join(output, 'error.txt'), error.stack || String(error));
  app.exit(1);
});
