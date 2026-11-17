const { app, BrowserWindow } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const root = process.env.CAPS_QA_ROOT;
const output = process.env.CAPS_QA_OUTPUT;
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const window = new BrowserWindow({ width: 1180, height: 820, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.removeMenu();
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  await window.loadFile(path.join(root, 'src/desktop/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 350));
  const report = [];
  for (const size of [[1180, 820], [1000, 700], [1920, 1080]]) {
    window.setSize(...size);
    await window.webContents.executeJavaScript(`document.querySelector('#settings-toggle').click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const states = [];
    for (const state of ['idle', 'preparing', 'downloading', 'verifying', 'failed', 'installed']) {
      await window.webContents.executeJavaScript(`window.caps.__setDownloadState(${JSON.stringify(state)})`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const dimensions = await window.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('#settings-panel');
        const body = document.querySelector('.settings-scroll');
        const cards = [...document.querySelectorAll('#model-cards .model-choice')];
        const rectangle = (element) => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom }; };
        const result = { state:${JSON.stringify(state)}, panel:rectangle(panel), body:rectangle(body),
          cards:cards.map(rectangle), columns:[...document.querySelectorAll('.settings-columns > section')].map(rectangle),
          bodyScroll:body.scrollHeight > body.clientHeight + 1, overflow:panel.scrollHeight > panel.clientHeight + 1 };
        if (Math.abs(result.cards[0].height - result.cards[1].height) > 1) throw new Error('Model card heights differ');
        if (result.bodyScroll || result.overflow) throw new Error('Settings overflows');
        if (Math.abs(result.columns[0].bottom - result.columns[1].bottom) > 1) throw new Error('Settings columns do not align');
        if (result.panel.y < 0 || result.panel.bottom > innerHeight) throw new Error('Settings leaves viewport');
        return result;
      })()`);
      states.push(dimensions);
    }
    if (states.some((state) => Math.abs(state.panel.height - states[0].panel.height) > 1
      || Math.abs(state.cards[0].height - states[0].cards[0].height) > 1)) throw new Error('Download state changes Settings geometry');
    await window.webContents.executeJavaScript(`(() => {
      const settings = document.querySelector('#settings-panel');
      const height = settings.getBoundingClientRect().height;
      const trigger = document.querySelector('#open-timing'); trigger.click();
      const popup = document.querySelector('#timing-popup');
      if (popup.hidden || !settings.inert || document.activeElement !== popup.querySelector('.popup-close')) throw new Error('Popup focus did not move');
      document.querySelector('#timing-min').value = '180';
      const done = popup.querySelector('.popup-footer button'); done.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true}));
      if (document.activeElement !== popup.querySelector('.popup-close')) throw new Error('Popup Tab escaped');
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
      if (!popup.hidden || settings.hidden || document.activeElement !== trigger) throw new Error('Escape dismissed parent or lost focus');
      trigger.click();
      if (document.querySelector('#timing-min').value !== '180' || window.caps.__saveCount() !== 0) throw new Error('Timing draft was lost or saved early');
      done.click();
      document.querySelector('#open-diagnostics').click();
      document.querySelector('#settings-popup-scrim').click();
      if (!document.querySelector('#diagnostics-popup').hidden || settings.hidden) throw new Error('Popup backdrop dismissed Settings');
      if (height !== settings.getBoundingClientRect().height) throw new Error('Popup changed Settings height');
    })()`);
    await writeFile(path.join(output, `settings-${size.join('x')}.png`), (await window.webContents.capturePage()).toPNG());
    report.push({ size, states });
    await window.webContents.executeJavaScript(`document.querySelector('#settings-close').click()`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(path.join(output, 'settings-report.json'), JSON.stringify(report, null, 2));
  window.destroy(); app.quit();
}).catch(async (error) => { if (output) { await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'error.txt'), error.stack); } app.exit(1); });
