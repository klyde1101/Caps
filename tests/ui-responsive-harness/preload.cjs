const { contextBridge } = require('electron');

const settings = {
  mode: 'dynamic',
  language: 'en',
  model: 'large-v3-turbo',
  whisperxPath: '',
  device: 'auto',
  deviceIndex: 0,
  computeType: 'default',
  outputBehavior: 'beside-input',
  dynamic: { minWords: 2, preferredWords: 3, maxWords: 4, maxCharacters: 22, pauseThresholdMs: 450, maxDurationMs: 1600 },
  standard: { minWords: 5, preferredWords: 7, maxWords: 9, maxCharacters: 42, pauseThresholdMs: 450, maxDurationMs: 3500 },
  timing: { minDurationMs: 100, bridgeGapMs: 80 }
};

let downloadListener;
let saveCount = 0;
const downloads = { activeId: null, models: { 'large-v3-turbo': { state: 'installed' }, small: { state: 'idle' } },
  catalog: { 'large-v3-turbo': { totalBytes: 1620000000 }, small: { totalBytes: 486000000 } } };
contextBridge.exposeInMainWorld('caps', {
  getSettings: async () => structuredClone(settings),
  getModelDownloads: async () => structuredClone(downloads),
  onModelDownloads: (listener) => { downloadListener = listener; },
  __setDownloadState: (state) => {
    downloads.models.small = { state, percent: 42, bytes: 204120000, totalBytes: 486000000, speed: 2000000, eta: 140, message: state === 'failed' ? 'Offline. Retry to resume.' : '' };
    downloads.activeId = ['preparing', 'downloading', 'verifying'].includes(state) ? 'small' : null;
    downloadListener?.(structuredClone(downloads));
  },
  __saveCount: () => saveCount,
  getDiagnostics: async () => ({
    whisperx: { available: true, path: 'C:\\WhisperX\\whisperx-standalone.exe' },
    model: { valid: true, type: 'path', model: 'C:\\Caps\\models\\large-v3-turbo', missingFiles: [] },
    models: [{ id: 'small', label: 'Small', installed: downloads.models.small.state === 'installed', sizeBytes: 484000000 }, { id: 'large-v3-turbo', label: 'Large v3 Turbo', path: 'C:\\Caps\\models\\large-v3-turbo', installed: true, sizeBytes: 3090835702 }],
    cuda: {
      available: true,
      devices: [
        { index: 0, name: 'NVIDIA GeForce RTX 3050', totalMemoryMiB: 8192, freeMemoryMiB: 7424, totalMemoryBytes: 8589934592, freeMemoryBytes: 7784628224 },
        { index: 1, name: 'NVIDIA GeForce GTX 1050', totalMemoryMiB: 2048, freeMemoryMiB: 1900, totalMemoryBytes: 2147483648, freeMemoryBytes: 1992294400 }
      ]
    },
    memory: { totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 },
    runtimes: { cpu: { available: true }, cuda: { available: true } },
    appVersion: '1.0.0',
    electronVersion: process.versions.electron
  }),
  saveSettings: async (value) => { saveCount++; return value; },
  selectInputs: async () => [],
  selectOutput: async () => null,
  inspectInput: async () => ({}),
  suggestOutput: async () => '',
  startJob: async () => ({}),
  cancelJob: async () => true,
  openOutputFolder: async () => true,
  copyText: async () => true,
  pathForFile: () => '',
  onProgress: () => {},
  onLog: () => {}
});
