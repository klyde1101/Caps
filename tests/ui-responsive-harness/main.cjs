const { app, BrowserWindow } = require('electron');
const { appendFile, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const projectRoot = process.env.CAPS_QA_ROOT;
const outputDirectory = process.env.CAPS_QA_OUTPUT;
const progressPath = outputDirectory && path.join(outputDirectory, 'progress.log');
const sizes = [
  { name: 'desktop', width: 1180, height: 820 },
  { name: 'minimum', width: 1000, height: 700 },
  { name: 'maximized', width: 1180, height: 820, maximized: true },
  { name: 'wide', width: 1920, height: 1080 },
  { name: 'fixed', width: 1024, height: 640 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'small', width: 320, height: 640 },
  { name: 'zoomed', width: 1180, height: 820, zoom: 1.5 },
  { name: 'narrow', width: 375, height: 812 },
  { name: 'landscape', width: 780, height: 500 }
];

function snapshotScript(state) {
  return `(() => {
    const ready = document.querySelector('#ready-view');
    const completed = document.querySelector('#completed-view');
    const banner = document.querySelector('#environment-banner');
    const drop = document.querySelector('#drop-zone');
    const file = document.querySelector('#file-card');
    const settings = document.querySelector('#settings-panel');
    const scrim = document.querySelector('#settings-scrim');
    let staticStyle = document.querySelector('#qa-static-style');
    if (!staticStyle) {
      staticStyle = document.createElement('style');
      staticStyle.id = 'qa-static-style';
      staticStyle.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
      document.head.append(staticStyle);
    }

    banner.hidden = ${state !== 'setup'};
    if (${state === 'setup'}) document.querySelector('#environment-message').textContent = 'WhisperX was not detected. SRT conversion remains available.';
    ready.hidden = ${['completed', 'processing', 'failed'].includes(state)};
    completed.hidden = ${state !== 'completed'};
    document.querySelector('#processing-view').hidden = ${state !== 'processing'};
    document.querySelector('#failed-view').hidden = ${state !== 'failed'};
    drop.hidden = ${state === 'selected'};
    file.hidden = ${state !== 'selected'};
    document.querySelector('#start-job').disabled = ${state !== 'selected'};
    settings.hidden = ${!['settings', 'settings-low-vram'].includes(state)};
    scrim.hidden = ${!['settings', 'settings-low-vram'].includes(state)};
    document.body.classList.toggle('settings-open', ${['settings', 'settings-low-vram'].includes(state)});

    if (${['settings', 'settings-low-vram'].includes(state)}) {
      const device = document.querySelector('#setting-device');
      device.value = 'cuda';
      device.dispatchEvent(new Event('change', { bubbles: true }));
      if (${state === 'settings-low-vram'}) {
        const cudaDevice = document.querySelector('#setting-device-index');
        cudaDevice.value = '1';
        cudaDevice.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('.settings-scroll').scrollTop = 0;
    }

    if (${state === 'selected'}) {
      document.querySelector('#file-count').textContent = '3 files selected';
      const list = document.querySelector('#file-list');
      list.replaceChildren(...['Interview footage with a reasonably long filename.mp4', 'Voiceover.wav', 'Aligned interview.srt'].map((fileName, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.className = 'file-item' + (index === 0 ? ' selected' : '');
        const kind = document.createElement('span'); kind.className = 'file-kind'; kind.textContent = fileName.split('.').at(-1).toUpperCase();
        const copy = document.createElement('span'); copy.className = 'file-copy';
        const name = document.createElement('strong'); name.textContent = fileName;
        const meta = document.createElement('small'); meta.textContent = '248.6 MB · Dynamic';
        copy.append(name, meta); button.append(kind, copy); item.append(button); return item;
      }));
      document.querySelector('#output-path').value = 'C:\\\\Media\\\\Interview footage_DYNAMIC.srt';
      document.querySelector('#start-job').disabled = false;
    }

    if (${state === 'completed'}) {
      document.querySelector('#completed-title').textContent = '3 caption files are ready.';
      document.querySelector('#completed-path').textContent = 'C:\\\\Media\\\\Interview footage_DYNAMIC.srt';
      document.querySelector('#stat-words').textContent = '264';
      document.querySelector('#stat-captions').textContent = '92';
      const results = document.querySelector('#batch-results'); results.hidden = false;
      results.replaceChildren(...['Interview footage.mp4', 'Voiceover.wav', 'Aligned interview.srt'].map((fileName, index) => {
        const button = document.createElement('button'); button.className = 'batch-result'; button.setAttribute('aria-pressed', String(index === 0));
        const name = document.createElement('strong'); name.textContent = fileName;
        const status = document.createElement('span'); status.textContent = '30 captions · Saved';
        button.append(name, status); return button;
      }));
      const body = document.querySelector('#preview-body');
      body.replaceChildren(...Array.from({ length: 50 }, (_, index) => {
        const row = document.createElement('tr');
        for (const value of [index + 1, '00:00:01,000', '00:00:02,200', 'Responsive caption preview text']) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        return row;
      }));
    }

    if (${state === 'processing'}) {
      document.querySelector('#stage-label').textContent = 'Aligning words to audio';
      document.querySelector('#batch-progress-label').textContent = 'Interview footage.mp4';
      document.querySelector('#job-progress').value = 48;
      document.querySelector('#progress-percent').textContent = '48%';
      const list = document.querySelector('#file-progress-list');
      list.replaceChildren(...['Interview footage.mp4', 'Voiceover.wav', 'Aligned interview.srt'].map((name, index) => {
        const row = document.createElement('li'); row.className = 'file-progress-row';
        row.dataset.state = index === 0 ? 'active' : 'queued';
        const head = document.createElement('div'); head.className = 'file-progress-head';
        const title = document.createElement('strong'); title.textContent = name;
        const status = document.createElement('span'); status.className = 'queue-badge'; status.textContent = index === 0 ? 'Aligning' : 'Queued';
        head.append(title, status);
        const progress = document.createElement('progress'); progress.max = 100; progress.value = index === 0 ? 48 : 0;
        row.append(head, progress); return row;
      }));
    }
    if (${state === 'failed'}) {
      document.querySelector('#error-message').textContent = 'The selected model could not be found.';
      document.querySelector('#error-recovery').textContent = 'Choose an installed model in Settings, then try again.';
    }

    const selectors = ${JSON.stringify({
      ready: ['.topbar', 'main', '.hero', '.workflow-grid', '.input-stage', '.mode-picker', '.export-panel'],
      setup: ['.topbar', 'main', '.hero', '#environment-banner', '.workflow-grid', '.input-stage', '.mode-picker', '.export-panel'],
      selected: ['.topbar', 'main', '.hero', '#environment-banner', '.workflow-grid', '#file-card', '.mode-picker', '.export-panel'],
      completed: ['.topbar', 'main', '.completion-heading', '.result-overview', '.preview', '.table-wrap'],
      settings: ['.topbar', 'main', '#settings-panel', '.settings-head', '.settings-scroll', '.settings-actions'],
      'settings-low-vram': ['.topbar', 'main', '#settings-panel', '.settings-head', '.settings-scroll', '.settings-actions']
      , processing: ['.topbar', 'main', '.progress-card', '.file-progress-list', '.queue-actions']
      , failed: ['.topbar', 'main', '#failed-view', '#retry-job']
    })}[${JSON.stringify(state)}];
    const viewport = { width: innerWidth, height: innerHeight };
    const elements = Object.fromEntries(selectors.map((selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [selector, {
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
        right: Math.round(rect.right), bottom: Math.round(rect.bottom),
        visible: !element.hidden && style.display !== 'none' && style.visibility !== 'hidden',
        withinViewport: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
        overflowX: style.overflowX, overflowY: style.overflowY,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight
      }];
    }));
    const workflow = document.querySelector('.workflow-grid').getBoundingClientRect();
    const input = document.querySelector('.input-stage').getBoundingClientRect();
    const modes = document.querySelector('.mode-picker').getBoundingClientRect();
    const overflowCandidates = [...document.querySelectorAll('.mode-picker label > span, .drop-zone, .file-card, .export-panel')];
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => button.getClientRects().length && !button.closest('[hidden]'))
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          id: button.id || null,
          className: button.className || null,
          label: button.getAttribute('aria-label') || button.textContent.trim().replace(/\\s+/g, ' '),
          x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
          right: Math.round(rect.right), bottom: Math.round(rect.bottom),
          display: style.display,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          disabled: button.disabled
        };
      });
    return {
      state: ${JSON.stringify(state)}, viewport,
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        pageOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
        pageOverflowY: document.documentElement.scrollHeight > innerHeight + 1
      },
      proportions: {
        mainToViewport: +(document.querySelector('main').getBoundingClientRect().width / innerWidth).toFixed(3),
        workflowToMain: +(workflow.width / document.querySelector('main').getBoundingClientRect().width).toFixed(3),
        inputShare: +(input.width / workflow.width).toFixed(3),
        modesShare: +(modes.width / workflow.width).toFixed(3)
      },
      buttons,
      elements,
      failures: Object.entries(elements).filter(([, value]) => value.visible && !value.withinViewport).map(([selector]) => selector),
      contentOverflow: overflowCandidates
        .filter((element) => !element.hidden && getComputedStyle(element).display !== 'none')
        .filter((element) => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          element: element.matches('.mode-picker label > span') ? 'mode-card:' + element.querySelector('strong')?.textContent : element.className,
          client: [element.clientWidth, element.clientHeight], scroll: [element.scrollWidth, element.scrollHeight]
        })),
      settingsSelections: ${['settings', 'settings-low-vram'].includes(state)} ? {
        devices: [...document.querySelector('#setting-device').options].map((option) => ({ value: option.value, label: option.textContent, disabled: option.disabled })),
        cudaDevices: [...document.querySelector('#setting-device-index').options].map((option) => ({ value: option.value, label: option.textContent, disabled: option.disabled })),
        model: document.querySelector('#setting-model')?.selectedOptions[0]?.textContent
      } : undefined
    };
  })()`;
}

async function capture(window, size, state) {
  let metrics;
  try {
    await window.webContents.executeJavaScript(snapshotScript(state));
    await new Promise((resolve) => setTimeout(resolve, 260));
    metrics = await window.webContents.executeJavaScript(snapshotScript(state));
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  } catch (error) {
    throw new Error(`Layout measurement failed for ${size.name} ${state}: ${error.message}`, { cause: error });
  }
  try {
    const image = await window.webContents.capturePage();
    await writeFile(path.join(outputDirectory, `${size.name}-${size.width}x${size.height}-${state}.png`), image.toPNG());
  } catch (error) {
    metrics.screenshotError = error.message;
  }
  return metrics;
}

app.whenReady().then(async () => {
  if (!projectRoot || !outputDirectory) throw new Error('CAPS_QA_ROOT and CAPS_QA_OUTPUT are required.');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(progressPath, 'Electron ready\n');
  const report = [];
  const window = new BrowserWindow({
    width: sizes[0].width,
    height: sizes[0].height,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  window.removeMenu();
  await window.loadFile(path.join(projectRoot, 'src', 'desktop', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const orientationChecks = await window.webContents.executeJavaScript(`(() => {
    return ['9:16', '4:5', '16:9'].map((orientation) => {
      document.querySelector('input[name="orientation"][value="' + orientation + '"]').click();
      const frame = document.querySelector('#caption-frame');
      const area = document.querySelector('.caption-safe-area');
      return { orientation, checked: document.querySelector('input[name="orientation"]:checked').value,
        preview: frame.dataset.orientation, limit: document.querySelector('#caption-limit').textContent,
        safeWidth: area.getBoundingClientRect().width / (frame.clientWidth),
        safeHeight: area.getBoundingClientRect().height / (frame.clientHeight) };
    });
  })()`);
  for (const [index, check] of orientationChecks.entries()) {
    if (check.checked !== check.orientation || check.preview !== check.orientation || !check.limit.startsWith(String([24, 32, 42][index]))) throw new Error('Orientation controls did not update correctly.');
    if (Math.abs(check.safeWidth - 0.7) > 0.02 || Math.abs(check.safeHeight - 0.7) > 0.02) throw new Error('Caption preview exceeds the 70% safe area.');
  }
  await writeFile(path.join(outputDirectory, 'orientation-checks.json'), JSON.stringify(orientationChecks, null, 2));
  await window.webContents.executeJavaScript(`document.querySelector('input[name="orientation"][value="9:16"]').click()`);

  const fontChecks = await window.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#caption-font-size');
    const results = [60, 65, 70].map(fontSize => {
      select.value = String(fontSize);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { fontSize, selected: Number(select.value), limit: document.querySelector('#caption-limit').textContent };
    });
    select.value = '65'; select.dispatchEvent(new Event('change', { bubbles: true }));
    return results;
  })()`);
  for (const [index, check] of fontChecks.entries()) {
    if (check.selected !== check.fontSize || !check.limit.startsWith(String([26, 24, 22][index]))) throw new Error('Caption size did not update its fit limit.');
  }
  await writeFile(path.join(outputDirectory, 'caption-size-checks.json'), JSON.stringify(fontChecks, null, 2));

  const familyChecks = await window.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#caption-font-family');
    const defaultFont = select.value;
    const results = [...select.options].map(option => {
      select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true }));
      return { id: option.value, label: option.textContent, help: document.querySelector('#caption-font-help').textContent };
    });
    select.value = defaultFont; select.dispatchEvent(new Event('change', { bubbles: true }));
    return { defaultFont, results };
  })()`);
  if (familyChecks.defaultFont !== 'proxima-nova-semibold' || familyChecks.results.length !== 6 ||
      familyChecks.results.some(check => !check.help.startsWith(check.label))) throw new Error('Caption font selection did not update fit guidance.');
  await writeFile(path.join(outputDirectory, 'caption-font-checks.json'), JSON.stringify(familyChecks, null, 2));

  const modelChecks = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('#settings-panel'); panel.hidden = false;
    const device = document.querySelector('#setting-device');
    const gpu = document.querySelector('#setting-device-index');
    device.value = 'cuda'; device.dispatchEvent(new Event('change'));
    gpu.value = '1'; gpu.dispatchEvent(new Event('change'));
    const turbo = document.querySelector('input[name="transcription-model"][value="large-v3-turbo"]');
    const small = document.querySelector('input[name="transcription-model"][value="small"]');
    if (!turbo.disabled || small.disabled) throw new Error('Low VRAM model gating failed');
    device.value = 'cpu'; device.dispatchEvent(new Event('change'));
    if (turbo.disabled) throw new Error('CPU fallback was incorrectly disabled');
    small.click();
    if (document.querySelector('#setting-model').value !== 'small') throw new Error('Small selection failed');
    const info = document.querySelector('.info-button'); info.focus();
    if (getComputedStyle(document.querySelector('.model-tooltip')).visibility !== 'visible') throw new Error('Keyboard tooltip is hidden');
    document.querySelector('input[name="transcription-model"][value="large-v3-turbo"]').click();
    panel.hidden = true;
    return { lowVramGating: true, cpuFallback: true, smallSelectable: true, keyboardTooltip: true };
  })()`);
  await writeFile(path.join(outputDirectory, 'model-checks.json'), JSON.stringify(modelChecks, null, 2));
  // Exercise the actual dialog controls, including keyboard dismissal and focus return.
  await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#settings-toggle');
    button.focus(); button.click();
    if (document.querySelector('#settings-panel').hidden || !document.querySelector('main').inert
      || document.activeElement.id !== 'settings-close') throw new Error('Settings did not open accessibly.');
  })()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  if (!await window.webContents.executeJavaScript(`document.activeElement.id === 'save-settings'`)) throw new Error('Settings focus did not wrap.');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  if (!await window.webContents.executeJavaScript(`document.querySelector('#settings-panel').hidden && !document.querySelector('main').inert && document.activeElement.id === 'settings-toggle'`)) throw new Error('Settings did not return focus on Escape.');
  await writeFile(path.join(outputDirectory, 'keyboard-checks.json'), JSON.stringify({ opened: true, focusTrapped: true, escapeClosed: true, focusReturned: true }));
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#settings-toggle').click();
    const device = document.querySelector('#setting-device');
    device.value = 'auto'; device.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#timing-min').value = '150';
    document.querySelector('#save-settings').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    if (!document.querySelector('#settings-panel').hidden || document.querySelector('#app-toast').hidden) throw new Error('Saving Settings did not close the dialog and show feedback.');
    document.querySelector('#settings-toggle').click();
    if (document.querySelector('#timing-min').value !== '150') throw new Error('Saved timing was not retained.');
    document.querySelector('#settings-close').click();
    document.querySelector('#app-toast').hidden = true;
  })()`);
  const scrollChecks = [];

  for (const size of sizes) {
    await appendFile(progressPath, `Opening ${size.name} ${size.width}x${size.height}\n`);
    if (window.isMaximized()) window.unmaximize();
    window.setSize(size.width, size.height);
    if (size.maximized) window.maximize();
    window.webContents.setZoomFactor(size.zoom || 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const state of ['ready', 'selected', 'setup', 'completed', 'processing', 'failed', 'settings', 'settings-low-vram']) {
      await appendFile(progressPath, `Measuring ${size.name} ${state}\n`);
      report.push({ window: size, metrics: await capture(window, size, state) });
      const measured = report.at(-1).metrics;
      if (measured.document.pageOverflowX || measured.contentOverflow.length) throw new Error(`Content overflows at ${size.name} ${state}`);
      if (measured.viewport.width >= 900 && measured.viewport.height >= 600) {
        const main = measured.elements.main;
        if (measured.document.pageOverflowY || main.scrollHeight > main.clientHeight + 1) {
          throw new Error(`Desktop workspace scrolls at ${size.name} ${state}`);
        }
        if (!state.startsWith('settings') && measured.failures.length) {
          throw new Error(`Desktop controls leave the viewport at ${size.name} ${state}: ${measured.failures.join(', ')}`);
        }
      }
      if (state.startsWith('settings') && measured.failures.length) throw new Error(`Settings controls leave the viewport at ${size.name}`);
      if (state.startsWith('settings') && measured.viewport.width >= 900 && measured.viewport.height >= 650) {
        const panel = measured.elements['.settings-scroll'];
        if (panel.scrollHeight > panel.clientHeight + 1) throw new Error(`Default settings scroll at ${size.name} ${state}`);
      }
      if (state === 'settings') {
        const popupChecks = await window.webContents.executeJavaScript(`(() => {
          const settings = document.querySelector('#settings-panel');
          const before = settings.getBoundingClientRect().height;
          const results = ['timing', 'diagnostics'].map(name => {
            const trigger = document.querySelector('#open-' + name);
            trigger.click();
            const popup = document.querySelector('#' + name + '-popup');
            const rect = popup.getBoundingClientRect();
            const result = !popup.hidden && settings.inert && rect.top >= 0 && rect.bottom <= innerHeight + 1
              && settings.getBoundingClientRect().height === before;
            popup.querySelector('.popup-close').click();
            return result && !settings.hidden && document.activeElement === trigger;
          });
          return results.every(Boolean);
        })()`);
        if (!popupChecks) throw new Error('Settings popup is inaccessible at ' + size.name);
      }
      if (['ready', 'selected', 'setup'].includes(state)) {
        const reachable = await window.webContents.executeJavaScript(`(() => {
          const main = document.querySelector('main'); main.scrollTop = main.scrollHeight;
          const rect = document.querySelector('#start-job').getBoundingClientRect();
          const reachable = rect.top >= 0 && rect.bottom <= innerHeight + 1;
          main.scrollTop = 0; return reachable;
        })()`);
        scrollChecks.push({ size: size.name, state, reachable });
        if (!reachable) throw new Error('Generate button cannot be reached by scrolling.');
      }
    }
  }

  await writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDirectory, 'scroll-checks.json'), JSON.stringify(scrollChecks, null, 2));
  await appendFile(progressPath, 'Complete\n');
  window.destroy();
  app.quit();
}).catch(async (error) => {
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'error.txt'), error.stack || String(error));
  }
  app.exit(1);
});
