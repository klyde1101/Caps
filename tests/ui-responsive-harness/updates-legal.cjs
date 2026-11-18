const { app, BrowserWindow, ipcMain } = require('electron');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const root = process.env.CAPS_QA_ROOT;
const output = process.env.CAPS_QA_OUTPUT;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const names = { privacy: 'src/legal/privacy.txt', terms: 'src/legal/terms.txt', eula: 'src/legal/eula.txt',
    disclaimer: 'src/legal/disclaimer.txt', license: 'LICENSE', notices: 'src/legal/third-party-notices.txt' };
  ipcMain.handle('qa:legal-document', (_event, id) => {
    if (!Object.hasOwn(names, id)) throw Error('Unknown document');
    return readFile(path.join(root, names[id]), 'utf8');
  });
  const window = new BrowserWindow({ width: 1180, height: 820, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  await window.loadFile(path.join(root, 'src/desktop/renderer/index.html'));
  await wait(500);
  await window.webContents.executeJavaScript(`document.querySelector('#settings-toggle').click()`);
  await wait(350);
  const measurements = [];
  for (const [width, height, zoom] of [[1180, 820, 1], [1000, 700, 1], [1180, 820, 1.5]]) {
    window.setSize(width, height); window.webContents.setZoomFactor(zoom);
    for (const pane of ['updates', 'legal']) {
      await window.webContents.executeJavaScript(`document.querySelector('#settings-${pane}-tab').click()`);
      await wait(500);
      const result = await window.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('#settings-panel');
        const pane = document.querySelector('[data-settings-pane="${pane}"]');
        if (pane.hidden) throw Error('Pane is hidden');
        if (pane.scrollWidth > pane.clientWidth + 1) throw Error('Horizontal pane overflow');
        if (panel.scrollWidth > panel.clientWidth + 1) throw Error('Horizontal Settings overflow');
        const tabs = [...document.querySelectorAll('[data-settings-page]')];
        if (tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length !== 1) throw Error('Invalid selected tabs');
        return { pane:'${pane}', width:innerWidth, height:innerHeight, scrollHeight:pane.scrollHeight, clientHeight:pane.clientHeight };
      })()`);
      measurements.push(result);
      await window.webContents.capturePage();
      await wait(100);
      await writeFile(path.join(output, `${pane}-${width}x${height}-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  for (const id of Object.keys(names)) {
    await window.webContents.executeJavaScript(`(() => { const choice = document.querySelector('#legal-document'); choice.value='${id}'; choice.dispatchEvent(new Event('change')); })()`);
    for (let i = 0; i < 100; i++) {
      if (await window.webContents.executeJavaScript(`document.querySelector('#legal-document-content').getAttribute('aria-busy') === 'false'`)) break;
      await wait(50);
    }
    const text = await window.webContents.executeJavaScript(`document.querySelector('#legal-document-content').textContent`);
    if (text.length < 100) throw Error('Missing document ' + id);
  }
  await window.webContents.executeJavaScript(`document.querySelector('#settings-updates-tab').click(); document.querySelector('#automatic-updates').click()`);
  await wait(100);
  if (await window.webContents.executeJavaScript(`document.querySelector('#automatic-updates').checked`)) throw Error('Automatic update switch did not save');
  await window.webContents.executeJavaScript(`document.querySelector('#check-app-update').click()`);
  await wait(100);
  if (!await window.webContents.executeJavaScript(`document.querySelector('#app-update-status').textContent.includes('ready')`)) throw Error('Manual update status missing');
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ measurements, documents: Object.keys(names), errors }, null, 2));
  window.destroy(); app.quit();
}).catch(async error => { await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'error.txt'), error.stack); app.exit(1); });
