const { contextBridge, ipcRenderer, webUtils } = require('electron');

const channels = Object.freeze({
  GET_MODEL_DOWNLOADS: 'caps:get-model-downloads', INSTALL_MODEL: 'caps:install-model',
  DELETE_MODEL: 'caps:delete-model',
  CREATE_MEDIA_PREVIEW: 'caps:create-media-preview', MEDIA_PREVIEW_PROGRESS: 'caps:media-preview-progress',
  CANCEL_MODEL_INSTALL: 'caps:cancel-model-install', MODEL_DOWNLOADS_CHANGED: 'caps:model-downloads-changed',
  SELECT_INPUT: 'caps:select-input',
  INSPECT_INPUT: 'caps:inspect-input',
  SUGGEST_OUTPUT: 'caps:suggest-output',
  START_JOB: 'caps:start-job',
  CHECK_BATCH: 'caps:check-batch',
  START_BATCH: 'caps:start-batch',
  START_QUEUE: 'caps:start-queue', ADD_QUEUE: 'caps:add-queue', MOVE_QUEUE: 'caps:move-queue', QUEUE_CHANGED: 'caps:queue-changed',
  CANCEL_JOB: 'caps:cancel-job',
  JOB_PROGRESS: 'caps:job-progress',
  JOB_LOG: 'caps:job-log',
  GET_PREVIEW: 'caps:get-preview',
  SAVE_CAPTIONS: 'caps:save-captions',
  GET_DIAGNOSTICS: 'caps:get-diagnostics',
  GET_SETTINGS: 'caps:get-settings',
  SAVE_SETTINGS: 'caps:save-settings',
  OPEN_OUTPUT_FOLDER: 'caps:open-output-folder',
  COPY_TEXT: 'caps:copy-text'
});

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response.ok) return response.value;
  // Error instances lose custom properties across contextBridge. Reject with a
  // plain record so the renderer retains recovery codes such as QUEUE_CLOSED.
  throw { name: response.error.name, code: response.error.code, message: response.error.message };
}

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('caps', Object.freeze({
  createMediaPreview: token => invoke(channels.CREATE_MEDIA_PREVIEW, token),
  onMediaPreviewProgress: listener => subscribe(channels.MEDIA_PREVIEW_PROGRESS, listener),
  deleteModel: (id) => invoke(channels.DELETE_MODEL, id),
  getModelDownloads: () => invoke(channels.GET_MODEL_DOWNLOADS),
  installModel: (id) => invoke(channels.INSTALL_MODEL, id),
  cancelModelInstall: (id) => invoke(channels.CANCEL_MODEL_INSTALL, id),
  onModelDownloads: (listener) => subscribe(channels.MODEL_DOWNLOADS_CHANGED, listener),
  selectInputs: () => invoke(channels.SELECT_INPUT),
  inspectInput: (inputPath) => invoke(channels.INSPECT_INPUT, inputPath),
  suggestOutput: (inputPath, mode, orientation) => invoke(channels.SUGGEST_OUTPUT, inputPath, mode, orientation),
  pathForFile: (file) => webUtils.getPathForFile(file),
  startJob: (request) => invoke(channels.START_JOB, request),
  checkBatch: (requests) => invoke(channels.CHECK_BATCH, requests),
  startBatch: (requests) => invoke(channels.START_BATCH, requests),
  startQueue: (requests) => invoke(channels.START_QUEUE, requests),
  addToQueue: (change) => invoke(channels.ADD_QUEUE, change),
  moveQueueItem: (change) => invoke(channels.MOVE_QUEUE, change),
  onQueueChanged: (listener) => subscribe(channels.QUEUE_CHANGED, listener),
  cancelJob: () => invoke(channels.CANCEL_JOB),
  onProgress: (listener) => subscribe(channels.JOB_PROGRESS, listener),
  onLog: (listener) => subscribe(channels.JOB_LOG, listener),
  getPreview: (request) => invoke(channels.GET_PREVIEW, request),
  saveCaptions: (request) => invoke(channels.SAVE_CAPTIONS, request),
  getDiagnostics: (force = false) => invoke(channels.GET_DIAGNOSTICS, force),
  getSettings: () => invoke(channels.GET_SETTINGS),
  saveSettings: (settings) => invoke(channels.SAVE_SETTINGS, settings),
  openOutputFolder: (outputPath) => invoke(channels.OPEN_OUTPUT_FOLDER, outputPath),
  copyText: (value) => invoke(channels.COPY_TEXT, value)
}));
