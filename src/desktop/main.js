import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, nativeTheme } from 'electron';
import { stat } from 'node:fs/promises';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IPC_CHANNELS, SUPPORTED_EXTENSIONS, serializeError, validateBatchRequests, validateOutputPath, validateStartRequest, validateQueueChange } from './ipc-contract.js';
import { createJobEventForwarder } from './job-event-forwarder.js';
import { JobController } from './job-controller.js';
import { createPreviewStore } from './preview-store.js';
import { createMediaPreview } from './media-preview.js';
import { ffmpegDirectory } from '../whisperx-runner.js';
import { createSettingsStore } from './settings-store.js';
import { createSplashWindowOptions, createWindowOptions, SECURITY_WEB_PREFERENCES } from './window-config.js';
import { prepareOutput } from './output-safeguards.js';
import { ModelDownloadManager } from './model-download-manager.js';
import { protectRendererFromFraming } from './renderer-policy.js';
import { createWarmTranscriberPool } from '../warm-transcriber.js';
import { AVAILABLE_MODELS, NO_MODEL, modelLabel } from '../model-catalog.js';

import { captionOutputPath } from '../captions/output-path.js';

const APP_ID = 'com.caps.desktop';
const startupStarted = performance.now();
app.setAppUserModelId(APP_ID);
nativeTheme.themeSource = 'dark';
const runtimeDirectory = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? dirname(process.execPath) : undefined);
if (runtimeDirectory) {
  app.setPath('userData', join(runtimeDirectory, 'data'));
}

function startupLog(stage, error = '') {
  try { const root = runtimeDirectory || process.cwd(); mkdirSync(join(root, 'data'), { recursive: true });
    appendFileSync(join(root, 'data', 'startup.log'), new Date().toISOString() + ' ' + stage + ' ' + (error.stack || error) + '\n');
  } catch {}
}
startupLog('main-entry');
process.on('uncaughtException', error => { startupLog('uncaught-exception', error); app.exit(1); });
process.on('unhandledRejection', error => { startupLog('unhandled-rejection', error ?? 'Unknown rejection'); app.exit(1); });

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(desktopDirectory, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
const previews = createPreviewStore();
const mediaPreviews = createMediaPreview({ root: runtimeDirectory || resolve(desktopDirectory, '../..'),
  inputForToken: token => previews.input(token), ffmpeg: join(ffmpegDirectory(), 'ffmpeg.exe') });
app.on('will-quit', () => mediaPreviews.close());
const warmTranscribers = createWarmTranscriberPool();
const jobs = new JobController(async (request) => {
  if (typeof request.alignedSrt === 'string') {
    const { generateCaptionJob } = await import('../application/generate-caption-job.js');
    return previews.register(await generateCaptionJob(request, { alignedSrt: request.alignedSrt }), request.inputPath);
  }
  const { generateCaptionBatchJob } = await import('../application/generate-caption-batch-job.js');
  return generateCaptionBatchJob(request, { finalizeResult: (result) => previews.register(result, result.inputPath) });
}, {
  createTranscriber: async (options) => {
    return warmTranscribers.acquire(options);
  }
});
let mainWindow;
let splashWindow;
let launchComplete = false;
let forceQuit = false;
let diagnosticsCache;
let diagnosticsPromise;
let downloadShutdownComplete = false;
let downloadsReady = Promise.resolve();
let admittingJobs = 0;
const installedDownloadIds = new Set();
const modelDownloads = new ModelDownloadManager({
  root: runtimeDirectory || resolve(desktopDirectory, '../..'),
  isModelInUse: () => jobs.active || admittingJobs > 0,
  onChange(snapshot) {
    for (const [id, state] of Object.entries(snapshot.models)) {
      if (state.state === 'installed' && !installedDownloadIds.has(id)) {
        installedDownloadIds.add(id); diagnosticsCache = undefined;
      }
      if (state.state !== 'installed' && installedDownloadIds.delete(id)) diagnosticsCache = undefined;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.MODEL_DOWNLOADS_CHANGED, snapshot);
  }
});

export const WINDOW_OPTIONS = Object.freeze(createWindowOptions(join(desktopDirectory, 'preload.cjs')));
export const SPLASH_WINDOW_OPTIONS = Object.freeze(createSplashWindowOptions());
export { SECURITY_WEB_PREFERENCES };

async function collectDiagnostics(settings) {
  const [whisperxModule, systemDiagnostics] = await Promise.all([
    import('../whisperx-runner.js'),
    import('./system-diagnostics.js')
  ]);
  const { defaultModel, findWhisperxRuntime, inspectInstalledModels, inspectLocalModel, verifyFfmpeg } = whisperxModule;
  const { detectCudaDevices, detectSystemMemory } = systemDiagnostics;
  const currentSettings = await settings.read();
  const [cuda, models] = await Promise.all([
    detectCudaDevices(),
    inspectInstalledModels()
  ]);
  const runtimeStatus = async (device) => {
    try {
      await verifyFfmpeg();
      const runtime = await findWhisperxRuntime({ device });
      const { executable: path, ...capabilities } = runtime;
      return { available: true, path, ...capabilities };
    } catch (error) {
      return { available: false, error: serializeError(error) };
    }
  };
  const [cpuRuntime, cudaRuntime] = await Promise.all([runtimeStatus('cpu'), runtimeStatus('cuda')]);
  const selectedRuntime = currentSettings.device === 'cpu' ? cpuRuntime
    : currentSettings.device === 'cuda' ? cudaRuntime
      : cudaRuntime.available ? cudaRuntime : cpuRuntime;
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    model: inspectLocalModel(currentSettings.model || defaultModel()),
    models,
    cuda,
    memory: detectSystemMemory(),
    whisperx: selectedRuntime,
    runtimes: { cpu: cpuRuntime, cuda: cudaRuntime }
  };
}

async function getDiagnostics(settings, force = false) {
  if (!force && diagnosticsCache && Date.now() - diagnosticsCache.createdAt < 300000) return diagnosticsCache.value;
  if (!force && diagnosticsPromise) return diagnosticsPromise;
  diagnosticsPromise = collectDiagnostics(settings).then((value) => {
    diagnosticsCache = { createdAt: Date.now(), value };
    return value;
  }).finally(() => { diagnosticsPromise = undefined; });
  return diagnosticsPromise;
}

function assertTrustedSender(event) {
  const contents = mainWindow?.webContents;
  const trusted = contents
    && event.sender === contents
    && event.senderFrame === contents.mainFrame
    && event.senderFrame.url === rendererUrl;
  if (!trusted) throw Object.assign(new Error('Untrusted IPC sender.'), { code: 'UNTRUSTED_SENDER' });
}

async function resolveRuntimeRequest(request) {
  const { resolveDesktopRuntimeRequest } = await import('./runtime-request.js');
  const settings = { read: async () => request };
  return resolveDesktopRuntimeRequest(request, { diagnostics: await getDiagnostics(settings) });
}

function safeHandler(handler) {
  return async (event, ...args) => {
    try {
      assertTrustedSender(event);
      return { ok: true, value: await handler(event, ...args) };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  };
}

function registerIpcHandlers(settings) {
  ipcMain.handle(IPC_CHANNELS.CREATE_MEDIA_PREVIEW, safeHandler(async (event, token) =>
    mediaPreviews.create(token, progress => { if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.MEDIA_PREVIEW_PROGRESS, progress); })));
  const jobHandler = handler => safeHandler(async (...args) => {
    if (modelDownloads.deleting) throw Object.assign(new Error('Wait for model deletion to finish.'), { code: 'MODEL_BUSY' });
    admittingJobs++;
    mainWindow?.setProgressBar(2, { mode: 'indeterminate' });
    let completed = false;
    try { const result = await handler(...args); completed = true; return result; }
    finally {
      admittingJobs--; mainWindow?.setProgressBar(-1);
      if (completed && mainWindow && !mainWindow.isFocused()) { mainWindow.flashFrame(true); mainWindow.once('focus', () => mainWindow?.flashFrame(false)); }
    }
  });
  ipcMain.handle(IPC_CHANNELS.DELETE_MODEL, safeHandler(async (_event, id) => {
    await downloadsReady;
    const { target } = modelDownloads.paths(id);
    const busy = () => jobs.active || admittingJobs > 0;
    if (busy()) throw Object.assign(new Error('Finish or cancel the current job before deleting a model.'), { code: 'MODEL_BUSY' });
    // The renderer's modal owns confirmation and focus. Admission is rechecked
    // here, independently of the dialog, before any filesystem mutation.
    if (busy()) throw Object.assign(new Error('A job has started. The model was not deleted.'), { code: 'MODEL_BUSY' });
    const snapshot = await modelDownloads.deleteModel(id);
    diagnosticsCache = undefined;
    const stored = await settings.read();
    if (stored.model === id) {
      const fallback = AVAILABLE_MODELS.find(spec => snapshot.models[spec.id]?.state === 'installed')?.id ?? NO_MODEL;
      await settings.save({ ...stored, model: fallback });
      snapshot.selectedModel = fallback;
    }
    return snapshot;
  }));
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_DOWNLOADS, safeHandler(async () => { await downloadsReady; return modelDownloads.snapshot(); }));
  ipcMain.handle(IPC_CHANNELS.INSTALL_MODEL, safeHandler(async (_event, id) => { await downloadsReady; return modelDownloads.start(id); }));
  ipcMain.handle(IPC_CHANNELS.CANCEL_MODEL_INSTALL, safeHandler(async (_event, id) => { await downloadsReady; return modelDownloads.cancel(id); }));
  ipcMain.handle(IPC_CHANNELS.SELECT_INPUT, safeHandler(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported media and subtitles', extensions: SUPPORTED_EXTENSIONS.map((extension) => extension.slice(1)) }]
    });
    return result.canceled ? [] : result.filePaths;
  }));

  ipcMain.handle(IPC_CHANNELS.INSPECT_INPUT, safeHandler(async (_event, inputPath) => {
    const request = validateStartRequest({ inputPath });
    const details = await stat(request.inputPath);
    if (!details.isFile()) throw Object.assign(new Error('The selected input is not a file.'), { code: 'INVALID_INPUT' });
    return { path: request.inputPath, name: basename(request.inputPath), extension: extname(request.inputPath).slice(1).toUpperCase(), size: details.size };
  }));

  ipcMain.handle(IPC_CHANNELS.SUGGEST_OUTPUT, safeHandler(async (_event, inputPath, mode, orientation) => {
    const request = validateStartRequest({ inputPath, mode, grouping: { orientation } });
    return captionOutputPath(request.inputPath, request.grouping?.orientation);
  }));

  ipcMain.handle(IPC_CHANNELS.START_JOB, jobHandler(async (event, value) => {
    const request = await resolveRuntimeRequest(validateStartRequest(value));
    const finalOutputPath = await prepareOutput({ inputPath: request.inputPath, outputPath: request.outputPath ?? captionOutputPath(request.inputPath, request.grouping?.orientation), overwrite: request.overwrite });
    const forwarder = createJobEventForwarder((type, payload) => { if (type !== 'log') { if (Number.isFinite(payload.percent) && payload.percent > 0 && !payload.indeterminate) mainWindow?.setProgressBar(Math.min(.99, payload.percent / 100)); else mainWindow?.setProgressBar(2, { mode: 'indeterminate' }); } event.sender.send(type === 'log' ? IPC_CHANNELS.JOB_LOG : IPC_CHANNELS.JOB_PROGRESS, payload); });
    try {
      return await jobs.start({ ...request, outputPath: finalOutputPath }, { onProgress: forwarder.progress, onLog: forwarder.log });
    } finally {
      forwarder.flush();
    }
  }));

  ipcMain.handle(IPC_CHANNELS.CHECK_BATCH, safeHandler(async (_event, values) => {
    const requests = validateBatchRequests(values);
    const conflicts = [];
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      try {
        await prepareOutput({ inputPath: request.inputPath, outputPath: request.outputPath, overwrite: false });
      } catch (error) {
        if (error.code === 'OUTPUT_CONFLICT') conflicts.push(index);
        else throw error;
      }
    }
    return { conflicts };
  }));

  ipcMain.handle(IPC_CHANNELS.START_BATCH, jobHandler(async (event, values) => {
    const requests = await Promise.all(validateBatchRequests(values).map(resolveRuntimeRequest));
    for (const request of requests) {
      await prepareOutput({ inputPath: request.inputPath, outputPath: request.outputPath, overwrite: request.overwrite });
    }
    const forwarder = createJobEventForwarder((type, payload) => { if (type !== 'log') { if (Number.isFinite(payload.percent) && payload.percent > 0 && !payload.indeterminate) mainWindow?.setProgressBar(Math.min(.99, payload.percent / 100)); else mainWindow?.setProgressBar(2, { mode: 'indeterminate' }); } event.sender.send(type === 'log' ? IPC_CHANNELS.JOB_LOG : IPC_CHANNELS.JOB_PROGRESS, payload); });
    try {
      return await jobs.start({ requests }, { onProgress: forwarder.progress, onLog: forwarder.log });
    } finally {
      forwarder.flush();
    }
  }));

  const prepareQueueRequests = async (values) => {
    const requests = await Promise.all(validateBatchRequests(values).map(resolveRuntimeRequest));
    for (const request of requests) await prepareOutput({ inputPath: request.inputPath, outputPath: request.outputPath, overwrite: request.overwrite });
    return requests;
  };
  ipcMain.handle(IPC_CHANNELS.START_QUEUE, jobHandler(async (event, values) => {
    const requests = await prepareQueueRequests(values);
    const forwarder = createJobEventForwarder((type, payload) => { if (type !== 'log') { if (Number.isFinite(payload.percent) && payload.percent > 0 && !payload.indeterminate) mainWindow?.setProgressBar(Math.min(.99, payload.percent / 100)); else mainWindow?.setProgressBar(2, { mode: 'indeterminate' }); } event.sender.send(type === 'log' ? IPC_CHANNELS.JOB_LOG : IPC_CHANNELS.JOB_PROGRESS, payload); });
    try {
      return await jobs.startQueue(requests, { onProgress: forwarder.progress, onLog: forwarder.log,
        onQueue: (snapshot) => { forwarder.flush(); event.sender.send(IPC_CHANNELS.QUEUE_CHANGED, snapshot); } });
    } finally { forwarder.flush(); }
  }));
  ipcMain.handle(IPC_CHANNELS.ADD_QUEUE, safeHandler(async (_event, value) => {
    const { queueId, requests } = validateQueueChange(value);
    return jobs.enqueue(queueId, await prepareQueueRequests(requests));
  }));
  ipcMain.handle(IPC_CHANNELS.MOVE_QUEUE, safeHandler(async (_event, value) => {
    const { queueId, itemId, beforeId } = validateQueueChange(value, true);
    return jobs.moveQueued(queueId, itemId, beforeId);
  }));
  ipcMain.handle(IPC_CHANNELS.CANCEL_JOB, safeHandler(async () => jobs.cancel()));
  ipcMain.handle(IPC_CHANNELS.GET_PREVIEW, safeHandler(async (_event, request) => previews.page(request)));
  ipcMain.handle(IPC_CHANNELS.SAVE_CAPTIONS, safeHandler(async (_event, request) => previews.save(request)));
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, safeHandler(async () => settings.read()));
  ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, safeHandler(async (_event, value) => {
    const saved = await settings.save(value);
    diagnosticsCache = undefined;
    return saved;
  }));
  ipcMain.handle(IPC_CHANNELS.OPEN_OUTPUT_FOLDER, safeHandler(async (_event, outputPath) => {
    shell.showItemInFolder(validateOutputPath(outputPath));
    return true;
  }));
  ipcMain.handle(IPC_CHANNELS.COPY_TEXT, safeHandler(async (_event, value) => {
    if (typeof value !== 'string' || value.length > 32000) throw Object.assign(new Error('Invalid text.'), { code: 'INVALID_REQUEST' });
    clipboard.writeText(value);
    return true;
  }));
  ipcMain.handle(IPC_CHANNELS.GET_DIAGNOSTICS, safeHandler(async (_event, force = false) => {
    if (typeof force !== 'boolean') throw Object.assign(new Error('Invalid diagnostics request.'), { code: 'INVALID_REQUEST' });
    return getDiagnostics(settings, force);
  }));
}

function createSplashWindow() {
  return new Promise((resolveSplash) => {
    splashWindow = new BrowserWindow(SPLASH_WINDOW_OPTIONS);
    splashWindow.removeMenu();
    splashWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    splashWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    splashWindow.once('ready-to-show', () => {
      if (!launchComplete && splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.showInactive();
      }
      resolveSplash();
    });
    splashWindow.on('closed', () => { splashWindow = undefined; });
    splashWindow.loadFile(join(desktopDirectory, 'splash', 'index.html'));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({ ...WINDOW_OPTIONS, icon: join(desktopDirectory, '../../build/caps-icon.ico') });
  protectRendererFromFraming(mainWindow.webContents.session, rendererUrl);
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => startupLog('page-load-failed', code + ' ' + description));
  mainWindow.webContents.on('render-process-gone', (_event, details) => startupLog('renderer-gone', JSON.stringify(details)));
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://github.com/klyde1101') void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['Keep editing', 'Discard and exit'], defaultId: 0, cancelId: 0,
      message: 'You have unsaved caption corrections.'
    });
    if (choice === 1) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => {
    launchComplete = true;
    startupLog('window-ready', JSON.stringify({ mainToWindowMs: Math.round(performance.now() - startupStarted) }));
    if (process.env.CAPS_READY_FILE) {
      const readyFile = resolve(process.env.CAPS_READY_FILE);
      if (dirname(readyFile) === resolve(runtimeDirectory || process.cwd(), 'data')) writeFileSync(readyFile, String(process.pid));
    }
    const revealMainWindow = () => {
      mainWindow.show();
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
    };
    revealMainWindow();
    // Network metadata is useful in Settings, but never gates first paint.
    void downloadsReady.then(() => modelDownloads.refreshCatalog());
  });
  mainWindow.on('close', (event) => {
    if (!jobs.active || forceQuit) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep Processing', 'Cancel Job and Exit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A caption job is still running.',
      detail: 'Closing Caps will cancel the active transcription.'
    });
    if (choice === 0) event.preventDefault();
    else {
      forceQuit = true;
      event.preventDefault();
      jobs.cancelAndWait().finally(() => {
        mainWindow.destroy();
        app.quit();
      });
    }
  });
  mainWindow.loadFile(rendererPath);
}

app.whenReady().then(async () => {
  void createSplashWindow();
  downloadsReady = modelDownloads.initialize().catch(error => startupLog('download-state-failed', error));
  registerIpcHandlers(createSettingsStore(app.getPath('userData')));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stop downloads only after existing job/unsaved-edit close guards have accepted exit.
app.on('will-quit', (event) => {
  if (downloadShutdownComplete) return;
  event.preventDefault();
  void Promise.allSettled([modelDownloads.shutdown(), warmTranscribers.shutdown()])
    .finally(() => { downloadShutdownComplete = true; app.quit(); });
});
