import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { launcherRuntime } from './clean-project.mjs';
import { fixture } from '../tests/ui-responsive-harness/browser-preview.mjs';
import { chromium } from '../data/ui-qa/round3/tooling/node_modules/playwright-core/index.mjs';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const root = resolve('.');
const runtime = await launcherRuntime(join(root, 'Caps.exe'), root);
const archive = join(runtime, 'resources/app.asar');
const output = join(root, 'data/ui-qa/beta1');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const report = [], errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:8766/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (!pathname.startsWith('/src/')) return route.fulfill({ status: 404, body: '' });
    let body = asar.extractFile(archive, normalize(pathname.slice(1)));
    if (pathname.endsWith('/index.html')) body = Buffer.from(body.toString().replace('<script type="module" src="app.js"></script>', '<script type="module" src="/fixture.js"></script>'));
    await route.fulfill({ body, contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' })[extname(pathname)] || 'application/octet-stream' });
  });
  await page.goto('http://127.0.0.1:8766/src/desktop/renderer/index.html');
  await page.waitForTimeout(500);
  for (const [width, height] of [[984, 661], [1180, 820], [1920, 1040], [1024, 600]]) {
    await page.setViewportSize({ width, height });
    for (const notice of [false, true]) {
      await page.evaluate(notice => { document.querySelector('#environment-banner').hidden = !notice; }, notice);
      for (const orientation of ['9:16', '4:5', '16:9']) {
        await page.locator(`[data-orientation="${orientation}"].orientation-toggle`).click();
        const layout = await page.evaluate(() => {
          const main = document.querySelector('main'), workflow = document.querySelector('.workflow-grid'), card = document.querySelector('.mode-card');
          return { viewport: [innerWidth, innerHeight], mainOverflow: main.scrollHeight > main.clientHeight + 1,
            workflowOverflow: workflow.scrollHeight > workflow.clientHeight + 1, cardOverflow: card.scrollHeight > card.clientHeight + 1,
            fontControls: !!document.querySelector('#caption-font-family,#caption-font-size') };
        });
        report.push({ ...layout, orientation, notice });
        assert.ok(!layout.mainOverflow && !layout.workflowOverflow && !layout.cardOverflow && !layout.fontControls, JSON.stringify(report.at(-1)));
      }
    }
    await page.screenshot({ path: join(output, `home-${width}x${height}.png`) });
  }
  await page.locator('#select-input').click();
  await page.locator('#file-card:not([hidden])').waitFor();
  await page.locator('[data-orientation="9:16"].orientation-toggle').click();
  await page.locator('[data-orientation="16:9"].orientation-toggle').click();
  assert.ok((await page.locator('#output-path').inputValue()).endsWith('_16X9.srt'));
  await page.evaluate(() => { caps.checkBatch = async requests => { window.qaRequests = requests; return { conflicts: [] }; }; });
  await page.locator('#start-job').click();
  await page.waitForFunction(() => !!window.qaRequests);
  const requests = await page.evaluate(() => window.qaRequests);
  assert.ok(requests[0].outputPath.endsWith('_16X9.srt'));
  assert.equal(requests[0].grouping.fontFamily, 'proxima-nova-semibold');
  assert.equal(requests[0].grouping.fontSize, 60);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'home-report.json'), JSON.stringify({ runtime, report, requests, errors, apis: 'synthetic' }, null, 2));
  console.log(`Passed ${report.length} packaged-renderer Home layouts and export request checks.`);
} finally { await browser.close(); }
