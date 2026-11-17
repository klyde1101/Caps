import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { IPC_CHANNELS, validateStartRequest } from '../src/desktop/ipc-contract.js';
import { inspectLocalModel } from '../src/whisperx-runner.js';
import { JobController } from '../src/desktop/job-controller.js';
import { resolveDesktopRuntimeRequest } from '../src/desktop/runtime-request.js';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/desktop/settings-store.js';
import { createSplashWindowOptions, createWindowOptions, SECURITY_WEB_PREFERENCES, SPLASH_SIZE, WINDOW_SIZE } from '../src/desktop/window-config.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'caps-desktop-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('desktop job requests reject malformed and unsupported input', () => {
  assert.throws(() => validateStartRequest(null), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateStartRequest({ inputPath: 'relative.mp4' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\video.exe' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\video.mp4', surprise: true }), { code: 'INVALID_REQUEST' });
});

test('desktop main entry parses before packaging', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(projectRoot, 'src', 'desktop', 'main.js')], { stdio: 'pipe' }));
});

test('desktop IPC accepts only the exact renderer window and main frame', async () => {
  const main = await readFile(join(projectRoot, 'src', 'desktop', 'main.js'), 'utf8');
  assert.match(main, /event\.sender === contents/);
  assert.match(main, /event\.senderFrame === contents\.mainFrame/);
  assert.match(main, /event\.senderFrame\.url === rendererUrl/);
  assert.doesNotMatch(main, /url\.startsWith\('file:\/\/'\)/);
});

test('desktop job requests accept supported absolute paths and settings', () => {
  const request = validateStartRequest({
    inputPath: 'C:\\Media\\clip.mp4',
    outputPath: 'C:\\Media\\clip_SOCIAL-MEDIA.srt',
    mode: 'social-media',
    language: 'en',
    device: 'cpu',
    computeType: 'int8'
  });
  assert.equal(request.mode, 'social-media');
  assert.notEqual(request, undefined);
});

test('desktop job validation supports runtime device values', () => {
  assert.doesNotThrow(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', device: 'auto', deviceIndex: 0 }));
  assert.doesNotThrow(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', device: 'cuda', deviceIndex: 3 }));
  assert.doesNotThrow(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', device: 'xpu', deviceIndex: 1 }));
  assert.doesNotThrow(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', device: 'mps' }));
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', device: 'directml' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateStartRequest({ inputPath: 'C:\\Media\\clip.mp4', deviceIndex: 16 }), { code: 'INVALID_REQUEST' });
});

test('job controller prevents concurrent jobs and waits for cancellation', async () => {
  let release;
  const controller = new JobController(({ signal }) => new Promise((resolve, reject) => {
    release = resolve;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
  }));
  const first = controller.start({ inputPath: 'first.mp4' });
  const firstRejection = assert.rejects(first, { code: 'CANCELLED' });

  await assert.rejects(controller.start({ inputPath: 'second.mp4' }), { code: 'JOB_ACTIVE' });
  assert.equal(controller.active, true);
  assert.equal(await controller.cancelAndWait(), true);
  await firstRejection;
  assert.equal(controller.active, false);
  assert.equal(controller.cancel(), false);
  void release;
});

test('settings store persists validated settings and recovers from corrupt JSON', async () => {
  await withTempDirectory(async (directory) => {
    const store = createSettingsStore(directory);
    const saved = await store.save({ mode: 'social-media', language: 'fil', whisperxPath: 'custom.exe', device: 'cpu', computeType: 'int8', outputBehavior: 'choose' });
    assert.equal(saved.mode, 'social-media');
    assert.equal(saved.language, 'en');
    assert.equal(saved.whisperxPath, '');
    assert.equal(saved.computeType, 'default');
    assert.equal(saved.outputBehavior, 'beside-input');
    assert.deepEqual(await store.read(), saved);

    await writeFile(join(directory, 'settings.json'), '{broken', 'utf8');
    assert.deepEqual(await store.read(), DEFAULT_SETTINGS);
  });
});

test('settings store deep-merges partial nested settings with defaults', async () => {
  await withTempDirectory(async (directory) => {
    const store = createSettingsStore(directory);
    const saved = await store.save({ timing: { bridgeGapMs: 120 } });
    assert.deepEqual(saved.timing, { ...DEFAULT_SETTINGS.timing, bridgeGapMs: 120 });
  });
});

test('desktop media jobs require a complete local model while SRT jobs do not', () => {
  const dependencies = {
    resolveModelSelection: (model) => model === 'installed' ? 'C:\\Models\\installed' : model,
    inspectModel: (model) => model.includes('\\')
      ? { model, type: 'path', valid: true, missingFiles: [] }
      : { model, type: 'name', valid: true, missingFiles: [] }
  };
  const media = resolveDesktopRuntimeRequest({ inputPath: 'C:\\Media\\clip.mp4', model: 'installed' }, dependencies);
  assert.equal(media.model, 'C:\\Models\\installed');
  assert.throws(
    () => resolveDesktopRuntimeRequest({ inputPath: 'C:\\Media\\clip.mp4', model: 'remote-name' }, dependencies),
    { code: 'MODEL_NOT_FOUND' }
  );
  assert.deepEqual(resolveDesktopRuntimeRequest({ inputPath: 'C:\\Media\\aligned.srt', model: 'remote-name' }, dependencies), { inputPath: 'C:\\Media\\aligned.srt', model: 'remote-name' });
  assert.equal(inspectLocalModel('remote-name', dependencies).valid, false);
});

test('settings store migrates unsupported model selections to the WhisperX default', async () => {
  await withTempDirectory(async (directory) => {
    const store = createSettingsStore(directory);
    assert.equal((await store.save({ model: 'distil-large-v3' })).model, 'large-v3-turbo');
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ model: 'custom/model' }), 'utf8');
    assert.equal((await store.read()).model, 'large-v3-turbo');
  });
});

test('desktop window uses production security settings', () => {
  const options = createWindowOptions('C:\\caps\\preload.cjs');
  assert.deepEqual(SECURITY_WEB_PREFERENCES, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false
  });
  assert.equal(options.webPreferences.preload, 'C:\\caps\\preload.cjs');
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.deepEqual(WINDOW_SIZE, { width: 1180, height: 820 });
  assert.equal(options.width, WINDOW_SIZE.width);
  assert.equal(options.height, WINDOW_SIZE.height);
  assert.equal(options.minWidth, 1000);
  assert.equal(options.minHeight, 700);
  for (const constraint of ['maxWidth', 'maxHeight']) {
    assert.equal(options[constraint], undefined, `${constraint} must not lock resizing`);
  }
  assert.equal(options.resizable, true);
  assert.equal(options.maximizable, true);
  assert.equal(options.fullscreenable, true);
});

test('launch splash is compact, frameless, and sandboxed', () => {
  const options = createSplashWindowOptions();
  assert.deepEqual(SPLASH_SIZE, { width: 360, height: 220 });
  assert.equal(options.width, 360);
  assert.equal(options.height, 220);
  assert.equal(options.frame, false);
  assert.equal(options.transparent, true);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.resizable, false);
  assert.deepEqual(options.webPreferences, SECURITY_WEB_PREFERENCES);
});

test('renderer declares a restrictive CSP and uses only the preload API', async () => {
  const html = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'index.html'), 'utf8');
  const renderer = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'app.js'), 'utf8');
  const styles = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'styles.css'), 'utf8');
  const workspace = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'workspace.css'), 'utf8');
  const tokens = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'tokens.css'), 'utf8');
  const preload = await readFile(join(projectRoot, 'src', 'desktop', 'preload.cjs'), 'utf8');
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(renderer, /require\s*\(|node:/);
  assert.match(renderer, /window\.caps\.startQueue/);
  assert.match(renderer, /window\.caps\.getPreview/);
  assert.match(renderer, /window\.caps\.selectInputs/);
  assert.match(html, /class="mode-card"/);
  assert.match(html, /Exports are saved beside each source file\./);
  assert.match(html, /id="app-toast"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /class="mode-stage"/);
  assert.doesNotMatch(html, /[⚙✓✕]/u);
  assert.match(renderer, /settingsReturnFocus/);
  assert.match(renderer, /setAttribute\('aria-busy'/);
  assert.match(tokens, /--accent:\s*#9D8CFF/i);
  assert.doesNotMatch(styles, /#5eead4|#2dd4bf|45 212 191|#fdba74|#fda4af|253 164 175/i);
  assert.doesNotMatch(html, /Runs locally|class="local-note"/i);
  assert.doesNotMatch(html, /YOUR CAPTION WORKSPACE|Great stories\./);
  assert.match(html, /id="ready-title">New captions<\/h1>/);
  assert.match(html, /Turn audio and video into edit-ready captions\./);
  assert.doesNotMatch(html, /Speech, meet subtitles\.|>CAPTION GENERATOR<\/p>/);
  assert.doesNotMatch(html, /privacy-chip/);
  assert.match(html, /id="select-input" class="primary"/);
  assert.doesNotMatch(html, />0[123]<\/i>/);
  assert.match(html, /Captions use/);
  assert.match(html, /id="restore-settings" class="ghost"/);
  assert.match(tokens, /--focus:\s*var\(--accent\)/);
  assert.match(html, /class="brand-icon"[^>]*caps-logo\.svg"[^>]*alt="Caps logo"/);
  assert.match(html, /class="brand-name">Caps<\/strong>/);
  assert.doesNotMatch(html, /brand-separator|openai-logo|nvidia-logo/);
  assert.doesNotMatch(html, /class="brand-product">Transcription<\/span>/);
  assert.doesNotMatch(html, /Caption workspace|class="mark"/);
  assert.match(workspace, /\.brand-icon\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/s);
  assert.match(styles, /overflow-y:\s*auto/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(max-width: 480px\)/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(html, /class="settings-page processing-settings"/);
  assert.match(html, /class="settings-page model-settings"/);
  assert.match(html, /role="tablist"[^>]*aria-orientation="vertical"/);
  assert.match(preload, /selectInputs/);
  for (const channel of Object.values(IPC_CHANNELS)) assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('startup uses a reduced-motion splash and defers noncritical diagnostics', async () => {
  const main = await readFile(join(projectRoot, 'src', 'desktop', 'main.js'), 'utf8');
  const renderer = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'app.js'), 'utf8');
  const splash = await readFile(join(projectRoot, 'src', 'desktop', 'splash', 'index.html'), 'utf8');
  const splashStyles = await readFile(join(projectRoot, 'src', 'desktop', 'splash', 'styles.css'), 'utf8');
  assert.match(main, /createSplashWindow\(\)/);
  assert.match(main, /showInactive\(\)/);
  assert.match(main, /splashWindow\.destroy\(\)/);
  assert.match(splash, /role="status"/);
  assert.match(splash, /default-src 'self'/);
  assert.match(splashStyles, /prefers-reduced-motion: reduce/);
  assert.match(splashStyles, /animation: audio-pulse 1200ms ease-in-out infinite/);
  assert.match(renderer, /requestIdleCallback/);
  assert.match(renderer, /void initializeRenderer\(\)/);
});

test('desktop and renderer expose the bulk caption workflow', async () => {
  const main = await readFile(join(projectRoot, 'src', 'desktop', 'main.js'), 'utf8');
  const html = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'index.html'), 'utf8');
  const renderer = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'app.js'), 'utf8');
  assert.match(main, /properties:\s*\['openFile', 'multiSelections'\]/);
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
  assert.match(main, /const APP_ID = 'com\.caps\.desktop'/);
  assert.match(main, /PORTABLE_EXECUTABLE_DIR/);
  assert.match(main, /app\.isPackaged \? dirname\(process\.execPath\)/);
  assert.match(main, /app\.setPath\('userData', join\(runtimeDirectory, 'data'\)\)/);
  assert.match(html, /id="file-list"/);
  assert.match(html, /class="mode-card"/);
  assert.match(html, /saved beside each source file/i);
  assert.match(html, /id="setting-model"/);
  assert.match(html, /value="large-v3-turbo">Large v3 Turbo/);
  assert.doesNotMatch(html, /value="large-v3"/);
  assert.doesNotMatch(html, /id="setting-model-preset"/);
  assert.match(html, /value="auto">Auto/);
  assert.doesNotMatch(html, /value="xpu"|Intel XPU/);
  assert.doesNotMatch(html, /value="mps"|Apple Metal|XPU and MPS/);
  assert.match(html, /id="setting-device-index"/);
  assert.match(html, /id="setting-cuda-option" value="cuda"/);
  assert.match(html, /id="device-help"[^>]*role="status"/);
  assert.match(html, /id="model-cards"/);
  assert.match(html, /id="model-download-announcement"[^>]*role="status"/);
  assert.doesNotMatch(html, />Device 15</);
  assert.match(renderer, /model: DEFAULT_MODEL/);
  assert.doesNotMatch(renderer, /currently free|Models larger than total VRAM|insufficient VRAM/);
  assert.doesNotMatch(renderer, /GPU names and total VRAM are shown below/);
  assert.doesNotMatch(renderer, /`Ready · \$\{data\.whisperx\.path\}`|'Ready'/);
  assert.match(renderer, /device\.name[^\n]*formatStorageSize\(device\.totalMemoryBytes\)/);
  for (const removedId of ['setting-language', 'setting-compute', 'setting-output', 'setting-whisperx']) assert.doesNotMatch(html, new RegExp(`id="${removedId}"`));
  assert.doesNotMatch(html, /All four models are loaded from the local models folder/);
  assert.match(renderer, /window\.caps\.startQueue\(requests\)/);
  assert.match(renderer, /MAX_TECHNICAL_LOG_CHARACTERS/);
  assert.doesNotMatch(renderer, /technical-log'\)\.textContent \+=/);
  assert.match(renderer, /\.\.\.event\.dataTransfer\.files/);
});
