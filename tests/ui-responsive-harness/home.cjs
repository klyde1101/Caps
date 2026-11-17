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
  await window.loadFile(path.join(root, 'src/desktop/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const report = [];
  // Client sizes include room lost to the Windows borders/title bar at the minimum window size.
  for (const size of [[984, 661], [1164, 781], [1920, 1040], [1024, 600]]) {
    window.setContentSize(...size);
    for (const setup of [false, true]) {
      await window.webContents.executeJavaScript(`document.querySelector('#environment-banner').hidden = ${!setup}`);
      for (const orientation of ['9:16', '4:5', '16:9']) {
        await window.webContents.executeJavaScript(`document.querySelector('[data-orientation="${orientation}"].orientation-toggle').click()`);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const result = await window.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('.mode-card'); const box = panel.getBoundingClientRect();
          const preview = document.querySelector('.layout-preview');
          const elements = [...panel.querySelectorAll('button, select, .layout-preview, .caption-frame, .layout-details, .layout-details > div')];
          const outside = elements.filter((element) => {
            const r = element.getBoundingClientRect();
            return r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.right > box.right + 1;
          }).map((element) => element.id || element.className || element.tagName);
          const frame = document.querySelector('.caption-frame').getBoundingClientRect();
          const frameRatio = frame.width / frame.height;
          const expectedRatio = ${orientation === '9:16' ? 9 / 16 : orientation === '4:5' ? 4 / 5 : 16 / 9};
          const result = { viewport:[innerWidth,innerHeight], setup:${setup}, orientation:${JSON.stringify(orientation)},
            cardHeight:box.height, previewHeight:preview.clientHeight, outside,
            overflow:panel.scrollHeight > panel.clientHeight + 1 || panel.scrollWidth > panel.clientWidth + 1,
            scrollContainer:['auto','scroll'].includes(getComputedStyle(panel).overflowY),
            frameRatio, previewOverflow:preview.scrollHeight > preview.clientHeight + 1 };
          if (result.overflow || result.scrollContainer || result.previewOverflow || outside.length) throw new Error(JSON.stringify(result));
          if (Math.abs(frameRatio - expectedRatio) > .03) throw new Error('Preview aspect ratio changed');
          return result;
        })()`);
        report.push(result);
      }
    }
    await window.webContents.executeJavaScript(`document.querySelector('#environment-banner').hidden = true`);
    await writeFile(path.join(output, `home-${size.join('x')}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await writeFile(path.join(output, 'home-report.json'), JSON.stringify(report, null, 2));
  window.destroy(); app.quit();
}).catch(async (error) => {
  if (output) { await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'error.txt'), error.stack); }
  app.exit(1);
});
