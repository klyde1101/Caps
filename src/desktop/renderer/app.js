import { createModelDeleteDialog } from './model-delete-dialog.js';
import { createCueList } from './cue-list.js';
import { processingStep, queueRowPhase } from './processing-state.js';
import { captionLayout, captionFits, DEFAULT_ORIENTATION, DEFAULT_FONT_SIZE, DEFAULT_CAPTION_FONT } from '../../captions/layout.js';
import { createProgressTracker, formatRemaining } from './job-progress.js';
import { createCaptionEditor } from './caption-editor.js';
import { mountReviewScreen } from './review-screen.js';
import { mountPlayerControls } from './player-controls.js';
import { settingsChanged } from './settings-draft.js';
import { generationAvailability, modelInstalled } from './generation-availability.js';
import { mountModelCards, renderModelDownload } from './model-cards.js';
import { createSettingsNavigation } from './settings-navigation.js';
import { deviceRecommendation } from './device-recommendation.js';
import { DEFAULT_MODEL, NO_MODEL, AVAILABLE_MODELS, isSupportedModel, modelLabel, modelCompatibility, getModelStatus, modelInformation } from '../../model-catalog.js';

import { captionOutputPath } from '../../captions/output-path.js';

const $ = (selector) => document.querySelector(selector);
const displayWording = value => String(value ?? '').replace(/\bGiB\b/g, 'GB').replace(/\bMiB\b/g, 'MB').replace(/\bVRAM\b/g, 'GPU memory').replace(/\bgraphics card\b/gi, 'GPU').replace(/\bprocessor\b/gi, 'CPU').replace(/NVIDIA CUDA/g, 'GPU').replace(/Automatic/g, 'Auto');

// Presentation-only controls forward to the existing inputs and change handlers.
function createUiIcon(name) {
  const icon = $('#ui-icon-templates').content.querySelector(`[data-ui-icon="${name}"]`).cloneNode(true);
  icon.removeAttribute('data-ui-icon');
  return icon;
}

const cueList = createCueList($('#preview-body'), $('.preview .table-wrap'), cue => makeCueRow(cue));
const confirmModelDelete = createModelDeleteDialog($('#model-delete-dialog'));
const captionEditor = createCaptionEditor(() => renderPreview(lastResult, $('#preview-search').value, 0), index => cueList.ensureCue(index));
mountReviewScreen();
mountPlayerControls($('#caption-player'));
const settingsNavigation = createSettingsNavigation($('#settings-panel'), { onDiagnostics: () => refreshDiagnostics() });
let modelCards;
let downloadSnapshot;
const downloadAnnouncements = new Map();
const views = ['ready', 'processing', 'completed', 'failed'];
const stageNames = {
  'inspecting-input': 'Inspecting input…', 'locating-whisperx': 'Locating WhisperX…',
  'transcribing-and-aligning': 'Transcribing and aligning speech…', 'grouping-captions': 'Grouping captions…',
  validating: 'Validating output…', 'writing-output': 'Writing subtitle file…', complete: 'Complete'
};
const recovery = {
  INVALID_INPUT: 'Choose a supported media file or a valid aligned SRT and try again.',
  WHISPERX_NOT_FOUND: 'Keep the Caps WhisperX runtime folders beside the app, then try again.',
  MODEL_NOT_FOUND: 'Install the selected model beside Caps, or choose an installed model in Settings.',
  CUDA_UNAVAILABLE: 'Choose CPU in Settings, or provide a CUDA-enabled WhisperX runtime.',
  TRANSCRIPTION_FAILED: 'Review the technical details, then verify the model, device, and compute settings.',
  INVALID_GENERATED_SRT: 'Check the source timing and try again.',
  OUTPUT_UNWRITABLE: 'Move the source file to a writable folder, then try again.',
  PATH_TOO_LONG: 'Move or rename the source file to shorten its path, then try again.',
  CANCELLED: 'The job was cancelled safely. You can start it again when ready.'
};
const defaults = {
  orientation: DEFAULT_ORIENTATION,
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_CAPTION_FONT,
  mode: 'social-media', language: 'en', model: DEFAULT_MODEL, whisperxPath: '', device: 'auto', deviceIndex: 0, computeType: 'default', outputBehavior: 'beside-input',
  timing: { minDurationMs: 100, bridgeGapMs: 80 }
};
const availableDevices = new Set(['auto', 'cpu', 'cuda']);
const indexedDevices = new Set(['cuda']);
const fixedRuntimeSettings = Object.freeze({ fontSize: DEFAULT_FONT_SIZE, fontFamily: DEFAULT_CAPTION_FONT, language: 'en', whisperxPath: '', computeType: 'default', outputBehavior: 'beside-input' });

let settings = structuredClone(defaults);
let savedSettings = structuredClone(defaults);
let settingsFormBase;
let selectedFiles = [];
let selectedIndex = 0;
let lastResult;
let batchResults = [];
let currentBatchIndex = -1;
let batchRunning = false;
let activeBatchFiles = [];
let elapsedTimer;
let startedAt;
let progressTracker;
let progressRows = [];
let queueSnapshot;
let queueAdding = false;
let queueMoving = false;
let draggedQueueId;
let activeJobSettings;
let queueEpoch = 0;
let nextQueueFiles;
let previewToken = 0;
let previewOffset = 0;
let previewSearchTimer;
let settingsReturnFocus;
let toastTimer;
let environmentDiagnostics = { cuda: { available: false, devices: [] } };
let settingsSaving = false;
let deletingModel = false;
let technicalLogCharacters = 0;
const PREVIEW_PAGE_SIZE = 200;
const MAX_TECHNICAL_LOG_CHARACTERS = 512 * 1024;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const navigationAnimations = new WeakMap();

// One animation per surface: rapid navigation replaces, rather than stacks, motion.
function animateNavigation(element, keyframes, duration = 220) {
  navigationAnimations.get(element)?.cancel();
  if (reducedMotion.matches) return;
  const animation = element.animate(keyframes, { duration, easing: 'cubic-bezier(.2,.8,.2,1)' });
  navigationAnimations.set(element, animation);
  return animation;
}

reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) document.getAnimations().forEach((animation) => animation.cancel());
});

function showView(name) {
  const target = $(`#${name}-view`);
  const changed = target.hidden;
  for (const view of views) navigationAnimations.get($(`#${view}-view`))?.cancel();
  for (const view of views) $(`#${view}-view`).hidden = view !== name;
  document.body.classList.toggle('review-screen', name === 'completed');
  $('main').setAttribute('aria-busy', String(name === 'processing'));
  $('main').scrollTop = 0;
  document.title = 'Caps';
  if (!changed) return;
  animateNavigation(target, [
    { opacity: 0, transform: `translateY(${name === 'ready' ? '-8px' : '10px'})` },
    { opacity: 1, transform: 'translateY(0)' }
  ]);
  const heading = target.querySelector('h1');
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

function showToast(message) {
  const toast = $('#app-toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function formatBytes(bytes) {
  if (bytes > 0 && bytes < 1024 ** 3 * .001) return '<0.001 GB';
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(3)} GB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function currentMode() { return 'social-media'; }

async function chooseInput() {
  const paths = await window.caps.selectInputs();
  if (paths?.length) await addPaths(paths);
}

function selectedFile() { return selectedFiles[selectedIndex]; }

function updateReadyStatus() { updateGenerateButton(); }

function updateGenerateButton() {
  const state = generationAvailability({ files: selectedFiles, settings,
    diagnostics: environmentDiagnostics, downloads: downloadSnapshot, running: batchRunning });
  $('#start-job').disabled = !state.enabled || deletingModel;
  $('#ready-status').textContent = deletingModel ? 'Deleting model' : displayWording(state.reason);
  $('#open-model-settings').hidden = !state.openSettings || deletingModel;
}

function applyDownloadSnapshot(snapshot) {
  if (!snapshot?.models) return;
  const completed = Object.entries(snapshot.models).some(([id, model]) => model.state === 'installed' && downloadSnapshot?.models?.[id]?.state !== 'installed');
  downloadSnapshot = snapshot;
  updateModelControls(); updateReadyStatus();
  $('#diag-downloads').textContent = Object.entries(snapshot.models).map(([id, model]) =>
    `${modelLabel(id)}: ${model.state}${model.message ? ' — ' + model.message : ''}`).join('\n')
    + '\nDetailed download logs: data/logs/model-download-<name>.log beside Caps.';
  if (completed) void loadStartupDiagnostics();
}

async function requestModelInstall(id) {
  try { applyDownloadSnapshot(await window.caps.installModel(id)); }
  catch (error) {
    applyDownloadSnapshot({ ...(downloadSnapshot ?? {}), models: { ...downloadSnapshot?.models,
      [id]: { id, state: 'failed', message: error.message || 'Could not start download.' } } });
  }
}

async function cancelModelInstall(id) {
  try { applyDownloadSnapshot(await window.caps.cancelModelInstall(id)); }
  catch { /* The next app-level update restores the actual running state. */ }
}

async function requestModelDelete(id) {
  if (batchRunning) { $('#settings-status').textContent = 'Finish or cancel the current job before deleting a model.'; return; }
  if (deletingModel) return;
  $('#settings-status').textContent = '';
  deletingModel = true; updateModelControls(); updateGenerateButton();
  const info = modelInformation(id, environmentDiagnostics);
  if (!await confirmModelDelete(modelLabel(id), info.modelSize)) { deletingModel = false; updateModelControls(); updateReadyStatus(); document.getElementById(`model-${id}`)?.focus(); return; }
  try {
    const snapshot = await window.caps.deleteModel(id);
    if (snapshot.cancelled) return;
    applyDownloadSnapshot(snapshot);
    const next = snapshot.selectedModel ?? AVAILABLE_MODELS.find(spec => modelInstalled(spec.id, environmentDiagnostics, snapshot))?.id ?? NO_MODEL;
    if (settings.model === id) {
      settings = { ...settings, model: next };
      savedSettings = { ...savedSettings, model: next };
      if (snapshot.selectedModel === undefined) await window.caps.saveSettings(savedSettings);
      updateEngineLabel();
    }
    if ($('#setting-model').value === id) $('#setting-model').value = next;
    if (settingsFormBase?.model === id) settingsFormBase.model = next;
    showToast(modelLabel(id) + ' deleted.');
    void loadStartupDiagnostics(true);
  } catch (error) { $('#settings-status').textContent = error.message; }
  finally { deletingModel = false; updateModelControls(); updateReadyStatus(); }
}

async function inspectPaths(paths, files = selectedFiles) {
    const existing = new Set(files.map((file) => file.path.toLowerCase()));
    const pending = [];
    for (const path of paths) {
      if (!path || existing.has(path.toLowerCase())) continue;
      existing.add(path.toLowerCase());
      pending.push((async () => {
        const mode = currentMode();
        const details = await window.caps.inspectInput(path);
        const outputPath = captionOutputPath(path, (activeJobSettings ?? settings).orientation);
        return { ...details, path, mode, outputPath };
      })());
    }
    return Promise.all(pending);
}

async function addPaths(paths) {
  try {
    const additions = await inspectPaths(paths);
    if (!additions.length) return;
    const wasEmpty = selectedFiles.length === 0;
    selectedFiles.push(...additions);
    if (wasEmpty) selectedIndex = 0;
    renderFileSelection();
  } catch (error) { displayFailure(error); }
}

function renderFileSelection() {
  const hasFiles = selectedFiles.length > 0;
  $('#drop-zone').hidden = hasFiles;
  $('#file-card').hidden = !hasFiles;
  updateReadyStatus();
  const list = $('#file-list'); list.replaceChildren();
  selectedFiles.forEach((file, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button'; button.className = `file-item${index === selectedIndex ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(index === selectedIndex));
    const kind = document.createElement('span'); kind.className = 'file-kind';
    const extension = file.extension.toLowerCase().replace(/^\./, '');
    const audio = ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'].includes(extension);
    const typeIcon = createUiIcon(extension === 'srt' ? 'file' : audio ? 'audio' : 'video');
    kind.append(typeIcon, document.createTextNode(file.extension));
    const copy = document.createElement('span'); copy.className = 'file-copy';
    const name = document.createElement('strong'); name.textContent = file.name;
    const meta = document.createElement('small'); meta.textContent = `${formatBytes(file.size)} · ${settings.orientation}`;
    copy.append(name, meta); button.append(kind, copy);
    button.addEventListener('click', () => {
      if (selectedIndex === index) return;
      selectedIndex = index;
      for (const [buttonIndex, item] of [...list.querySelectorAll('button')].entries()) {
        item.classList.toggle('selected', buttonIndex === index);
        item.setAttribute('aria-pressed', String(buttonIndex === index));
      }
      $('#output-path').value = file.outputPath;
      $('#output-file-label').textContent = `· ${file.name}`;
      animateNavigation($('#output-path'), [{ opacity: .45 }, { opacity: 1 }], 160);
    });
    item.append(button); list.append(item);
  });
  $('#file-count').textContent = `${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} selected`;
  const active = selectedFile();
  if (active) {
    $('#output-path').value = active.outputPath;
    $('#output-file-label').textContent = `· ${active.name}`;
  } else {
    $('#output-path').value = ''; $('#output-file-label').textContent = '';
  }
}

function applyOrientation() {
  const layout = captionLayout(settings.orientation);
  for (const input of document.querySelectorAll('input[name="orientation"]')) input.checked = input.value === layout.orientation;
  for (const button of document.querySelectorAll('[data-orientation].orientation-toggle')) {
    button.setAttribute('aria-pressed', String(button.dataset.orientation === layout.orientation));
  }
}

function groupingSettings(config = settings) { return { timing: config.timing, orientation: config.orientation, fontSize: DEFAULT_FONT_SIZE, fontFamily: DEFAULT_CAPTION_FONT }; }

function jobRequest(file, overwrite = false, config = settings) {
  return {
    inputPath: file.path, outputPath: captionOutputPath(file.path, config.orientation), overwrite, mode: file.mode, language: fixedRuntimeSettings.language,
    model: config.model || undefined, whisperxPath: undefined,
    device: config.device, deviceIndex: config.deviceIndex, computeType: fixedRuntimeSettings.computeType, grouping: groupingSettings(config)
  };
}

function clearTechnicalLog() {
  $('#technical-log').replaceChildren();
  technicalLogCharacters = 0;
}

function appendTechnicalLog(value) {
  const text = String(value ?? '');
  if (!text) return;
  const log = $('#technical-log');
  if (text.length >= MAX_TECHNICAL_LOG_CHARACTERS) {
    const tail = text.slice(-MAX_TECHNICAL_LOG_CHARACTERS);
    log.replaceChildren(document.createTextNode(tail));
    technicalLogCharacters = tail.length;
  } else {
    log.append(document.createTextNode(text));
    technicalLogCharacters += text.length;
    while (technicalLogCharacters > MAX_TECHNICAL_LOG_CHARACTERS && log.firstChild) {
      const overflow = technicalLogCharacters - MAX_TECHNICAL_LOG_CHARACTERS;
      const first = log.firstChild;
      if (first.data.length <= overflow) {
        technicalLogCharacters -= first.data.length;
        first.remove();
      } else {
        first.data = first.data.slice(overflow);
        technicalLogCharacters -= overflow;
      }
    }
  }
  log.scrollTop = log.scrollHeight;
}

async function runJob() {
  updateGenerateButton();
  if ($('#start-job').disabled) return;
  batchRunning = true;
  $('.orientation-picker').disabled = true;
  $('#start-job').disabled = true;
  const files = [...selectedFiles];
  activeBatchFiles = files;
  activeJobSettings = structuredClone(settings);
  queueEpoch += 1;
  queueAdding = false; queueMoving = false;
  queueSnapshot = undefined;
  $('#queue-status').hidden = true;
  $('#add-queue-files').disabled = true;
  try {
    const requests = files.map((file) => jobRequest(file, false, activeJobSettings));
    const { conflicts } = await window.caps.checkBatch(requests);
    if (conflicts.length) {
      const names = conflicts.slice(0, 5).map((index) => files[index].name).join('\n');
      const extra = conflicts.length > 5 ? `\n…and ${conflicts.length - 5} more` : '';
      if (!window.confirm(`${conflicts.length} caption export${conflicts.length === 1 ? '' : 's'} already exist. Replace them?\n\n${names}${extra}`)) return;
      for (const index of conflicts) requests[index].overwrite = true;
    }
    await window.caps.saveSettings(settings);
    savedSettings = structuredClone(settings);
    showView('processing');
    clearTechnicalLog();
    $('#job-progress').value = 0;
    $('#stage-label').textContent = 'Preparing your files…';
    $('#batch-progress-label').textContent = files.length === 1 ? files[0].name : `${files.length} files in your queue`;
    $('#cancel-job').disabled = false;
    batchResults = [];
    startedAt = Date.now();
    initializeProgress(files);
    updateElapsed(); elapsedTimer = setInterval(updateElapsed, 1000);
    const results = await window.caps.startQueue(requests);
    batchResults = results;
    showCompleted(batchResults);
  } catch (error) {
    displayFailure(error);
  } finally {
    clearInterval(elapsedTimer);
    currentBatchIndex = -1;
    activeBatchFiles = [];
    batchRunning = false;
    $('#add-queue-files').disabled = true;
    $('.orientation-picker').disabled = false;
        updateReadyStatus(); updateModelControls();
    if (nextQueueFiles?.length) {
      prepareNextQueue(nextQueueFiles);
      nextQueueFiles = undefined;
    }
  }
}

function updateElapsed() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  $('#elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} elapsed`;
  renderProgress();
}

const progressStages = {
  queued: 'Queued', preparing: 'Preparing model', 'inspecting-input': 'Inspecting file',
  'locating-whisperx': 'Preparing model', 'transcribing-and-aligning': 'Processing speech',
  transcribing: 'Transcribing', 'awaiting-alignment': 'Awaiting alignment', aligning: 'Aligning words',
  recovering: 'Recovering speech with Turbo', 'awaiting-export': 'Waiting to save',
  finishing: 'Finishing transcription', 'grouping-captions': 'Grouping captions', validating: 'Validating',
  'writing-output': 'Saving captions', complete: 'Saved'
};

function initializeProgress(files, resetTracker = true) {
  if (resetTracker) progressTracker = createProgressTracker(files, startedAt);
  const list = $('#file-progress-list');
  list.replaceChildren();
  $('#progress-scope').textContent = files.length > 1 ? 'Overall progress' : 'File progress';
  list.hidden = false;
  progressRows = files.map((file) => {
    const row = document.createElement('li'); row.className = 'file-progress-row';
    if (file.id) row.dataset.queueId = file.id;
    const handle = document.createElement('span'); handle.className = 'queue-handle';
    const grip = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    grip.setAttribute('viewBox', '0 0 16 24');
    const gripPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gripPath.setAttribute('d', 'M5 5h.01M11 5h.01M5 12h.01M11 12h.01M5 19h.01M11 19h.01');
    grip.append(gripPath); handle.append(grip); handle.setAttribute('aria-hidden', 'true');
    const controls = document.createElement('div'); controls.className = 'queue-controls';
    const up = document.createElement('button'); up.type = 'button'; up.textContent = '↑';
    up.setAttribute('aria-label', `Move ${file.name} up`); up.title = 'Move up';
    const down = document.createElement('button'); down.type = 'button'; down.textContent = '↓';
    down.setAttribute('aria-label', `Move ${file.name} down`); down.title = 'Move down';
    controls.append(up, down);
    const head = document.createElement('div'); head.className = 'file-progress-head';
    const name = document.createElement('strong'); name.textContent = file.name; name.title = file.name;
    const percent = document.createElement('span');
    head.append(name, percent);
    const bar = document.createElement('progress'); bar.max = 100; bar.value = 0;
    bar.setAttribute('aria-label', `Progress for ${file.name}`);
    const footer = document.createElement('div'); footer.className = 'file-progress-meta';
    const status = document.createElement('span'); status.className = 'queue-badge'; const eta = document.createElement('span');
    footer.append(status, eta); row.append(handle, head, bar, footer, controls); list.append(row);
    up.addEventListener('click', () => moveQueueBy(file.id, -1));
    down.addEventListener('click', () => moveQueueBy(file.id, 1));
    row.addEventListener('dragstart', (event) => {
      if (!row.draggable || queueMoving) { event.preventDefault(); return; }
      draggedQueueId = file.id;
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', file.id);
      row.classList.add('queue-dragging');
    });
    row.addEventListener('dragend', clearQueueDrag);
    row.addEventListener('dragover', (event) => {
      if (!draggedQueueId || !row.draggable) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      row.classList.add('queue-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('queue-drop-target'));
    row.addEventListener('drop', (event) => {
      if (!draggedQueueId || !row.draggable) return;
      event.preventDefault(); event.stopPropagation();
      const itemId = draggedQueueId;
      const pending = queueSnapshot.items.filter((item) => item.state === 'queued');
      const rect = row.getBoundingClientRect();
      const targetIndex = pending.findIndex((item) => item.id === file.id);
      const beforeId = event.clientY > rect.top + rect.height / 2 ? pending[targetIndex + 1]?.id ?? null : file.id;
      clearQueueDrag(); void moveQueueItem(itemId, beforeId);
    });
    return { row, percent, bar, status, eta, up, down, controls, handle };
  });
  renderProgress();
}

function renderProgress() {
  if (!progressTracker) return;
  const state = progressTracker.snapshot();
  const items = state.items;
  $('#processor-progress').textContent = `Transcription: ${items.filter(item => item.percent >= 70).length}/${items.length} · Alignment: ${items.filter(item => item.percent >= 95).length}/${items.length}`;
  const current = items.find((item, i) => queueSnapshot?.items.find(q => q.index === i)?.state === 'active')
    ?? items.find(item => item.stage !== 'queued' && item.percent < 100) ?? items[0];
  const step = processingStep(current?.stage);
  const steps = ['prepare', 'transcribe', 'align', 'export'];
  for (const element of document.querySelectorAll('#job-steps [data-step]')) {
    const index = steps.indexOf(element.dataset.step), active = steps.indexOf(step);
    element.dataset.state = index < active ? 'done' : index === active ? 'current' : 'upcoming';
    if (index === active) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current');
  }
  $('#stage-label').textContent = { prepare: 'Preparing', transcribe: 'Transcribing', align: 'Aligning', export: 'Exporting' }[step];
  $('#processor-progress').textContent = `${items.length} ${items.length === 1 ? 'file' : 'files'} · Transcription ${items.filter(item => item.percent >= 70).length}/${items.length} · Alignment ${items.filter(item => item.percent >= 95).length}/${items.length}`;
  const known = state.percent > 0;
  if (known) $('#job-progress').value = state.percent; else $('#job-progress').removeAttribute('value');
  $('#progress-percent').hidden = !known;
  $('#progress-percent').textContent = `${Math.floor(state.percent)}%`;
  $('#estimated-time').hidden = !known || !Number.isFinite(state.remaining);
  $('#cancel-job').textContent = items.length > 1 ? 'Cancel all' : 'Cancel';
  $('#queue-reorder-hint').hidden = (queueSnapshot?.items.filter(item => item.state === 'queued').length ?? 0) < 2;
  $('#progress-count').textContent = activeBatchFiles.length > 1
    ? `${state.completed} of ${activeBatchFiles.length} files saved` : 'Transcribe · Align · Export';
  const completionTime = state.remaining > 0
    ? new Date(Date.now() + state.remaining).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  $('#estimated-time').textContent = `${formatRemaining(state.remaining)}${completionTime ? ` · Finish ~${completionTime}` : ''}`;
  $('#estimated-time').title = 'Estimated completion adapts as processing continues.';
  state.items.forEach((item, index) => {
    const parts = progressRows[index];
    if (!parts) return;
    parts.percent.textContent = `${Math.floor(item.percent)}%`;
    parts.bar.value = item.percent;
    parts.status.textContent = progressStages[item.stage] ?? 'Processing';
    parts.eta.textContent = item.stage === 'queued' ? 'Waiting to start' : formatRemaining(item.remaining);
    parts.row.dataset.state = item.percent === 100 ? 'complete' : item.stage === 'queued' ? 'queued' : 'active';
    const queued = queueSnapshot?.items.find((entry) => entry.index === index);
    const waiting = queued?.state === 'queued' && queueSnapshot.accepting;
    parts.row.draggable = Boolean(waiting && !queueMoving);
    parts.controls.hidden = !waiting; parts.handle.hidden = !waiting;
    parts.row.classList.toggle('queue-waiting', Boolean(waiting));
    if (queued) parts.status.textContent = queued.state === 'queued' ? 'Up next' : queued.state === 'active' ? progressStages[item.stage] ?? 'Processing' : queued.state === 'complete' ? 'Saved' : progressStages[queued.state] ?? queued.state;
    const phase = queueRowPhase(item, queued?.state);
    parts.row.dataset.state = phase;
    if (phase === 'queued') parts.status.textContent = 'Queued';
    if (phase === 'awaiting-alignment') parts.status.textContent = 'Awaiting alignment';
    if (phase === 'complete') parts.status.textContent = 'Saved';
    if (phase === 'active') parts.row.setAttribute('aria-current', 'step');
    else parts.row.removeAttribute('aria-current');
    const pending = queueSnapshot?.items.filter((entry) => entry.state === 'queued') ?? [];
    const position = pending.findIndex((entry) => entry.index === index);
    parts.up.disabled = queueMoving || position <= 0;
    parts.down.disabled = queueMoving || position < 0 || position === pending.length - 1;
    if (phase === 'active') {
      const activeStage = item.stage === 'queued' ? 'prepare' : processingStep(item.stage);
      parts.status.textContent = { prepare: 'Preparing', transcribe: 'Transcribing', align: 'Aligning', export: 'Exporting' }[activeStage];
    }
    // During admission there is no queue snapshot yet: the first source is preparing.
    if (!queueSnapshot && index === 0) { parts.status.textContent = 'Preparing'; parts.row.dataset.state = 'active'; }
    const hasPercent = item.percent > 0;
    parts.percent.hidden = !hasPercent;
    if (hasPercent) parts.bar.value = item.percent; else parts.bar.removeAttribute('value');
    parts.eta.textContent = phase === 'queued' && queueSnapshot ? 'Waiting to start' : Number.isFinite(item.remaining) ? formatRemaining(item.remaining) : '';
  });
  $('#add-queue-files').disabled = !batchRunning || !queueSnapshot?.accepting || queueAdding;
}

function queueNotice(message) {
  $('#queue-status').textContent = message;
  $('#queue-status').hidden = false;
}

function applyQueueSnapshot(snapshot) {
  if (!batchRunning || (queueSnapshot && (snapshot.id !== queueSnapshot.id || snapshot.revision <= queueSnapshot.revision))) return;
  queueSnapshot = snapshot;
  const knownFiles = new Map(selectedFiles.map((file) => [file.path.toLowerCase(), file]));
  selectedFiles = snapshot.items.map((item) => ({ ...knownFiles.get(item.path.toLowerCase()), ...item }));
  activeBatchFiles = [...snapshot.items].sort((a, b) => a.index - b.index);
  const active = snapshot.items.find((item) => item.state === 'active');
  $('#batch-progress-label').textContent = active ? `Now processing · ${active.name}` : `${snapshot.items.length} files in your queue`;
  if (!snapshot.accepting && snapshot.items.some((item) => item.state === 'awaiting-alignment')) {
    $('#batch-progress-label').textContent = 'Transcription finished · Aligning queued files';
  }
  if (progressTracker) {
    progressTracker.syncFiles(activeBatchFiles);
    // New rows need event handlers; retain all existing progress samples.
    const focused = document.activeElement;
    const focusedLabel = focused?.getAttribute('aria-label');
    const scrollTop = $('#file-progress-list').scrollTop;
    initializeProgress(activeBatchFiles, false);
    const fragment = document.createDocumentFragment();
    for (const item of snapshot.items) fragment.append(progressRows[item.index].row);
    $('#file-progress-list').replaceChildren(fragment);
    $('#file-progress-list').scrollTop = scrollTop;
    renderProgress();
    if (focusedLabel) [...$('#file-progress-list').querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === focusedLabel && !button.disabled)?.focus({ preventScroll: true });
  }
}

function clearQueueDrag() {
  draggedQueueId = undefined;
  for (const parts of progressRows) parts.row.classList.remove('queue-dragging', 'queue-drop-target');
}

async function moveQueueItem(itemId, beforeId) {
  if (!queueSnapshot?.accepting || queueMoving || itemId === beforeId) return;
  const queueId = queueSnapshot.id;
  const epoch = queueEpoch;
  const restoreFocus = $('#file-progress-list').contains(document.activeElement);
  queueMoving = true; renderProgress();
  try {
    const snapshot = await window.caps.moveQueueItem({ queueId, itemId, beforeId });
    if (epoch !== queueEpoch || queueSnapshot?.id !== queueId) return;
    applyQueueSnapshot(snapshot);
    queueNotice('Queue order updated. The current file will finish first.');
  } catch (error) { if (epoch === queueEpoch) queueNotice(error.message); }
  finally {
    if (epoch !== queueEpoch) return;
    queueMoving = false; renderProgress();
    if (restoreFocus) {
      const file = activeBatchFiles.find((item) => item.id === itemId);
      progressRows[file?.index]?.controls.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }
  }
}

function moveQueueBy(itemId, direction) {
  const pending = queueSnapshot?.items.filter((item) => item.state === 'queued') ?? [];
  const index = pending.findIndex((item) => item.id === itemId);
  if (index < 0 || index + direction < 0 || index + direction >= pending.length) return;
  void moveQueueItem(itemId, direction < 0 ? pending[index - 1].id : pending[index + 2]?.id ?? null);
}

async function addQueueFiles(paths) {
  if (queueAdding || !queueSnapshot?.accepting) return;
  const queueId = queueSnapshot.id;
  const epoch = queueEpoch;
  queueAdding = true; renderProgress();
  let additions = [];
  try {
    paths ??= await window.caps.selectInputs();
    if (!paths?.length) return;
    additions = await inspectPaths(paths, activeBatchFiles);
    if (!additions.length) { queueNotice('These files are already in the queue.'); return; }
    const requests = additions.map((file) => jobRequest(file, false, activeJobSettings));
    const { conflicts } = await window.caps.checkBatch(requests);
    if (conflicts.length) {
      if (!window.confirm(`${conflicts.length} caption exports already exist. Replace them?\n\n${conflicts.map((index) => additions[index].name).join('\n')}`)) return;
      for (const index of conflicts) requests[index].overwrite = true;
    }
    const snapshot = await window.caps.addToQueue({ queueId, requests });
    if (epoch !== queueEpoch || queueSnapshot?.id !== queueId) return;
    applyQueueSnapshot(snapshot);
    for (const file of additions) {
      const selected = selectedFiles.find((item) => item.path.toLowerCase() === file.path.toLowerCase());
      if (selected) Object.assign(selected, file);
    }
    queueNotice(`${additions.length} ${additions.length === 1 ? 'file added' : 'files added'} to the queue.`);
  } catch (error) {
    if (epoch !== queueEpoch) return;
    if (error.code === 'QUEUE_CLOSED' && additions.length) {
      if (batchRunning) nextQueueFiles = additions;
      else prepareNextQueue(additions);
    } else queueNotice(error.message);
  } finally { if (epoch === queueEpoch) { queueAdding = false; renderProgress(); } }
}

function prepareNextQueue(files) {
  selectedFiles = files; selectedIndex = 0; renderFileSelection(); showView('ready');
  showToast('The previous queue finished. Your new files are ready to start.');
}

function displayFailure(error) {
  showView('failed');
  $('#error-message').textContent = error.message;
  $('#error-recovery').textContent = recovery[error.code] ?? 'Review the technical details or choose another file and try again.';
  $('#error-details').textContent = `Code: ${error.code ?? 'UNKNOWN'}\n${error.stack ?? error.message}\n\n${$('#technical-log').textContent}`;
  $('#retry-job').hidden = error.code === 'CANCELLED';
}

function selectCompletedResult(index) {
  const result = batchResults[index];
  if (!result || (lastResult === result && $('#batch-results').querySelector('button[aria-pressed="true"]')?.dataset.index === String(index))) return;
  lastResult = result;
  captionEditor.open(result);
  const folder = lastResult.outputPath.replace(/[\\/][^\\/]+$/, '');
  $('#completed-path').textContent = folder.split(/[\\/]/).at(-1) || folder;
  $('#completed-path').title = folder;
  const filename = lastResult.outputPath.split(/[\\/]/).at(-1);
  $('#result-filename').dataset.fullName = filename;
  $('#result-filename').title = filename;
  if (lastResult.styledOutputPath) $('#result-filename').title += `\nStyled font export: ${lastResult.styledOutputPath}`;
  $('#result-filename').textContent = filename;
  $('#file-duration').textContent = Number.isFinite(lastResult.processingDurationMs) ? String(Math.round(lastResult.processingDurationMs / 1000)) : '—';
  $('#preview-search').value = ''; previewOffset = 0; renderPreview(lastResult, '', 0);
  for (const [buttonIndex, button] of [...$('#batch-results').querySelectorAll('button')].entries()) button.setAttribute('aria-pressed', String(buttonIndex === index));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}h ` : ''}${hours || minutes ? `${minutes}m ` : ''}${seconds % 60}s`;
}

function showCompleted(results) {
  batchResults = results; lastResult = results.at(-1);
  $('#completed-title').textContent = 'Review your captions';
  $('#stat-words').textContent = results.reduce((total, result) => total + result.alignedWordCount, 0);
  $('#stat-captions').textContent = results.reduce((total, result) => total + result.generatedCaptionCount, 0);
  $('#stat-validation').textContent = results.every((result) => result.validation.valid) ? 'No problems found' : 'Captions need review';
  $('#stat-validation').dataset.valid = String(results.every(result => result.validation.valid));
  $('#total-duration').textContent = formatDuration(results[0]?.totalElapsedMs);
  $('#overall-time-fact').hidden = true;
  $('#file-duration-label').textContent = results.length === 1 ? 'Processed in' : 'Selected file';
  const resultList = $('#batch-results'); resultList.replaceChildren(); resultList.hidden = results.length < 2;
  results.forEach((result, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'batch-result';
    button.dataset.index = String(index);
    button.setAttribute('aria-pressed', 'false');
    const name = document.createElement('strong'); name.textContent = result.inputName;
    name.title = result.inputName;
    const status = document.createElement('span'); status.textContent = `${result.generatedCaptionCount} captions · Saved`;
    const duration = document.createElement('span'); duration.className = 'result-duration';
    duration.textContent = formatDuration(result.processingDurationMs);
    duration.title = `Processing time: ${duration.textContent}`;
    button.append(name, status, duration); button.addEventListener('click', () => selectCompletedResult(index)); resultList.append(button);
  });
  selectCompletedResult(results.length - 1);
  showView('completed');
}

function cueIsUnusual(cue) {
  const wordCount = cue.text.trim().split(/\s+/).length;
  const layout = lastResult?.layout ?? captionLayout(settings.orientation, settings.fontSize, settings.fontFamily);
  return wordCount > 5 || !captionFits(cue.text, layout);
}

function makeCueRow(cue) {
  const row = document.createElement('tr');
  if (cueIsUnusual(cue)) {
    row.className = 'warning-row';
    row.title = !/\s/u.test(cue.text.trim())
      ? 'This word exceeds the selected caption limit and was kept intact. Review its fit in your video editor.'
      : 'This caption exceeds the estimated line fit or five-word target.';
  }
  for (const value of [cue.index, formatTime(cue.start), formatTime(cue.end), cue.text]) {
    const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
  }
  if (row.classList.contains('warning-row')) {
    const badge = document.createElement('span'); badge.className = 'review-badge'; badge.textContent = 'Needs review';
    row.lastElementChild.append(badge);
  }
  captionEditor.decorate(row, cue, lastResult);
  return row;
}

async function renderPreview(result, query, offset) {
  clearTimeout(previewSearchTimer);
  if (!result) return;
  const token = ++previewToken;
  const body = $('#preview-body');
  const preview = $('.preview');
  navigationAnimations.get(body)?.cancel();
  preview.setAttribute('aria-busy', 'true');
  $('#preview-count').textContent = 'Loading captions…';
  try {
    const cues = []; let page;
    do {
      page = await window.caps.getPreview({ previewToken: result.previewToken, query, offset: cues.length, limit: PREVIEW_PAGE_SIZE });
      if (token !== previewToken) return;
      cues.push(...page.cues);
    } while (cues.length < page.matches && page.cues.length);
    previewOffset = 0;
    cueList.set(cues);
    captionEditor.syncPlayback();
    $('#preview-count').textContent = query.trim() ? page.matches + ' of ' + page.total : page.total + ' in total';
    $('#caption-empty').hidden = cues.length !== 0;
  } catch (error) {
    if (token !== previewToken) return;
    cueList.set([]);
    $('#preview-count').textContent = error.message;
  } finally {
    if (token === previewToken) preview.setAttribute('aria-busy', 'false');
  }
}

async function resetReady() {
  if (!await captionEditor.reset()) return;
  clearTimeout(previewSearchTimer); ++previewToken;
  $('.preview').setAttribute('aria-busy', 'false');
  selectedFiles = []; selectedIndex = 0; batchResults = []; lastResult = undefined; currentBatchIndex = -1;
  $('#drop-zone').hidden = false; $('#file-card').hidden = true; $('#start-job').disabled = true; $('#output-path').value = '';
  updateReadyStatus();
  $('#completed-title').textContent = 'Captions are ready.'; $('#batch-results').replaceChildren(); $('#batch-results').hidden = true;
  showView('ready');
}

function openSettings(open) {
  if (!open) settingsNavigation.close();
  if (open) settingsReturnFocus = document.activeElement;
  $('#settings-panel').hidden = !open; $('#settings-toggle').setAttribute('aria-expanded', String(open));
  $('#settings-scrim').hidden = !open; document.body.classList.toggle('settings-open', open);
  $('#settings-toggle').disabled = open;
  $('main').inert = open;
  if (open) {
    $('#settings-status').textContent = batchRunning ? 'Model and device changes apply to the next run.' : ''; applySettingsToForm(); refreshDiagnostics(); $('.settings-scroll').scrollTop = 0; $('#settings-close').focus();
    animateNavigation($('#settings-panel'), [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'translateX(0)' }], 260);
    animateNavigation($('#settings-scrim'), [{ opacity: 0 }, { opacity: 1 }], 180);
  }
  else {
    navigationAnimations.get($('#settings-panel'))?.cancel();
    navigationAnimations.get($('#settings-scrim'))?.cancel();
    const returnTarget = settingsReturnFocus?.isConnected ? settingsReturnFocus : $('#settings-toggle');
    settingsReturnFocus = undefined;
    returnTarget.focus();
  }
  updateGenerateButton();
}

function formatStorageSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unavailable';
  const gibibyte = 1024 ** 3;
  const mebibyte = 1024 ** 2;
  if (bytes >= gibibyte) {
    const value = bytes / gibibyte;
    return `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '')} GB`;
  }
  return `${(bytes / gibibyte).toFixed(2)} GB`;
}

function cudaDevices() { return environmentDiagnostics.cuda?.devices ?? []; }

function selectedCudaDevice() {
  const index = Number($('#setting-device-index').value);
  return cudaDevices().find((device) => device.index === index);
}

function updateSaveButton() {
  $('#save-settings').disabled = settingsSaving || deletingModel || !settingsChanged(savedSettings, settingsFromForm());
}

function renderCudaDevices() {
  const devices = cudaDevices();
  const cudaRuntimeAvailable = environmentDiagnostics.runtimes?.cuda?.available
    ?? environmentDiagnostics.whisperx?.cudaSupport === 'supported';
  const select = $('#setting-device-index');
  const firstDetection = select.dataset.detected !== 'true';
  const preferredIndex = firstDetection ? String(settings.deviceIndex ?? 0) : select.value;
  select.replaceChildren();
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = String(device.index);
    option.textContent = `${device.name} · ${formatStorageSize(device.totalMemoryBytes)}`;
    select.append(option);
  }
  if (!devices.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No CUDA devices detected';
    select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === preferredIndex) ? preferredIndex : select.options[0].value;
  select.dataset.detected = 'true';
  if (firstDetection && devices.length) settings.deviceIndex = Number(select.value);
  $('#setting-cuda-option').disabled = false;
  updateDeviceControls();
}

function updateDeviceControls() {
  const device = $('#setting-device').value;
  $('#device-index-field').hidden = !indexedDevices.has(device);
  $('#device-index-label').textContent = 'GPU to use';
  $('#device-help').title = $('#device-help').textContent;
  for (const button of document.querySelectorAll('[data-device]')) {
    button.setAttribute('aria-pressed', String(button.dataset.device === device));
    button.setAttribute('aria-checked', String(button.dataset.device === device));
    button.tabIndex = button.dataset.device === device ? 0 : -1;
    button.disabled = ([...$('#setting-device').options].find(option => option.value === button.dataset.device)?.disabled ?? false) || button.dataset.device === 'cuda' && (!cudaDevices().length || !(environmentDiagnostics.runtimes?.cuda?.available ?? environmentDiagnostics.whisperx?.cudaSupport === 'supported'));
    button.title = button.disabled ? 'No compatible GPU is available. Check Diagnostics for details.' : '';
  }
  updateModelControls();
}

function applySettingsToForm(config = settingsFormBase ?? settings) {
  $('#setting-device').value = availableDevices.has(config.device) ? config.device : defaults.device;
  $('#setting-device-index').value = String(config.deviceIndex ?? 0);
  $('#setting-model').value = config.model;
  $('#timing-min').value = config.timing.minDurationMs; $('#timing-bridge').value = config.timing.bridgeGapMs;
  updateDeviceControls();
}

function settingsFromForm() {
  return { ...(settingsFormBase ?? settings), ...fixedRuntimeSettings, mode: currentMode(), device: $('#setting-device').value, deviceIndex: +$('#setting-device-index').value, model: $('#setting-model').value,
    timing: { minDurationMs: +$('#timing-min').value, bridgeGapMs: +$('#timing-bridge').value } };
}

async function saveSettings() {
  const button = $('#save-settings');
  settingsSaving = true;
  updateSaveButton();
  button.querySelector('.button-label').textContent = 'Saving…';
  try {
    settings = await window.caps.saveSettings(settingsFromForm());
    savedSettings = structuredClone(settings);
    updateReadyStatus();
    updateEngineLabel();
    applyOrientation();
    void loadStartupDiagnostics();
    $('#settings-status').textContent = '';
    openSettings(false);
    showToast('Settings saved.');
  } catch (error) {
    $('#settings-status').textContent = error.message;
  } finally {
    settingsSaving = false;
    updateSaveButton();
    button.querySelector('.button-label').textContent = 'Save settings';
  }
}

async function refreshDiagnostics(force = false) {
  try {
    const data = await window.caps.getDiagnostics(force);
    environmentDiagnostics = data;
    renderCudaDevices();
    updateModelControls();
    updateReadyStatus();
    const capability = data.whisperx.cudaSupport === 'supported'
      ? ` · CUDA ${data.whisperx.cudaVersion ?? 'enabled'}`
      : data.whisperx.cudaSupport === 'unsupported' ? ' · CPU-only PyTorch' : '';
    $('#diag-whisperx').textContent = data.whisperx.available
      ? `${data.whisperx.path}${capability}`
      : data.whisperx.error?.message ?? 'Not detected';
    $('#diag-cuda').textContent = data.cuda.devices.length
      ? data.cuda.devices.map((device) => `${device.name} · ${formatStorageSize(device.totalMemoryBytes)} GPU memory`).join(' · ')
      : 'No compatible device detected';
    $('#diag-runtime').textContent = `Caps ${data.appVersion} · Electron ${data.electronVersion}`;
  } catch (error) { $('#diag-runtime').textContent = error.message; }
}

function updateEngineLabel() { $('#brand-engine').textContent = 'WhisperX'; }

function compatibility(id) {
  return getModelStatus(id, { ...environmentDiagnostics, downloads: downloadSnapshot }, {
    device: $('#setting-device').value, deviceIndex: Number($('#setting-device-index').value || 0)
  });
}

function updateModelControls() {
  const selected = $('#setting-model').value;
  const hardware = { ...environmentDiagnostics, downloads: downloadSnapshot };
  for (const spec of AVAILABLE_MODELS) {
    const card = modelCards.get(spec.id);
    const radio = card.querySelector('input');
    const status = compatibility(spec.id);
    const installed = status.installed;
    radio.checked = spec.id === selected;
    radio.disabled = false;
    card.dataset.disabled = 'false';
    const info = modelInformation(spec.id, hardware);
    card.querySelector('[data-size]').textContent = info.modelSize + ' GB';
    card.querySelector('[data-vram]').textContent = '~' + info.gpuVramGiB + ' GB';
    const runtime = getModelStatus(spec.id, hardware, { device: $('#setting-device').value,
      deviceIndex: Number($('#setting-device-index').value || 0) }, { ignoreInstallation: true });
    card.querySelector('[data-ram]').textContent = (runtime.device === 'cpu' ? info.cpuRamGiB : info.gpuRamGiB) + ' GB';
    card.querySelector('[data-descriptor]').textContent = info.descriptor;
    const note = card.querySelector('.model-compatibility');
    note.hidden = status.status === 'ready' || status.pending === true;
    note.replaceChildren(...(note.hidden ? [] : [createUiIcon('warning'), document.createTextNode(displayWording(status.reason))]));
    const advisory = card.querySelector('[data-advisory]');
    advisory.hidden = !status.advisory; advisory.textContent = displayWording(status.advisory);
    const rendered = renderModelDownload(card, downloadSnapshot?.models?.[spec.id], {
      installed, busy: Boolean(downloadSnapshot?.activeId) || deletingModel, jobRunning: batchRunning,
      createIcon: createUiIcon, formatBytes,
      formatTime: seconds => seconds == null ? 'Estimating' : seconds < 60 ? '~' + Math.ceil(seconds) + ' s' : '~' + Math.ceil(seconds / 60) + ' min'
    });
    const announcement = rendered.state + ':' + Math.floor(rendered.percent / 10);
    if (downloadSnapshot && downloadAnnouncements.get(spec.id) !== announcement) {
      downloadAnnouncements.set(spec.id, announcement);
      if (rendered.state !== 'idle') $('#model-download-announcement').textContent = spec.label + ': ' + rendered.label;
    }
  }
  $('#model-selection-status').hidden = selected !== NO_MODEL;
  const model = environmentDiagnostics.models?.find(model => model.id === selected);
  $('#diag-model').textContent = modelLabel(selected) + (modelInstalled(selected, environmentDiagnostics, downloadSnapshot)
    ? ' - ' + (model?.path ?? 'models/' + selected) : ' - Not installed');
  const ram = environmentDiagnostics.memory?.totalBytes;
  const summary = $('#hardware-summary');
  if (ram) {
    const memory = document.createElement('span');
    const value = document.createElement('strong'); value.textContent = formatStorageSize(ram);
    memory.append(value, document.createTextNode(' RAM'));
    summary.replaceChildren(memory);
    for (const gpu of cudaDevices()) {
      const item = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = gpu.name;
      const vram = document.createElement('strong'); vram.textContent = formatStorageSize(gpu.totalMemoryBytes);
      item.append(name, document.createTextNode(' · '), vram, document.createTextNode(' GPU memory'));
      summary.append(item);
    }
  } else summary.textContent = 'Detecting hardware';
  const count = cudaDevices().length;
  const hardwareStatus = $('#hardware-device-status');
  hardwareStatus.dataset.state = count ? 'detected' : 'missing';
  hardwareStatus.replaceChildren(...(count ? [createUiIcon('check')] : []),
    document.createTextNode(count ? `${count} CUDA device${count === 1 ? '' : 's'} detected` : 'No CUDA device detected'));
  const recommendation = deviceRecommendation(hardware, { model: selected, device: $('#setting-device').value,
    deviceIndex: Number($('#setting-device-index').value || 0) });
  $('#device-recommendation').textContent = recommendation.title;
  const gpu = selectedCudaDevice();
  const detected = [ram ? formatStorageSize(ram) + ' RAM' : '', gpu ? formatStorageSize(gpu.totalMemoryBytes) + ' GPU memory' : ''].filter(Boolean).join(' · ');
  $('#device-recommendation-detail').textContent = (detected ? detected + '. ' : '') + displayWording(recommendation.detail);
  $('#use-automatic').hidden = !recommendation.offerAutomatic;
  updateSaveButton();
  updateGenerateButton();
}

modelCards = mountModelCards(AVAILABLE_MODELS, { host: $('#model-cards'), template: $('#model-card-template'),
  createIcon: createUiIcon, onInstall: requestModelInstall, onCancel: cancelModelInstall, onDelete: requestModelDelete });
$('#copy-diagnostics').addEventListener('click', async () => {
  try {
    await window.caps.copyText(($('#diagnostics').innerText + '\n' + $('#diag-downloads').textContent).slice(0, 32000));
    $('#copy-diagnostics-status').textContent = 'Copied';
  } catch { $('#copy-diagnostics-status').textContent = 'Could not copy diagnostics'; }
});
window.caps.onModelDownloads?.(applyDownloadSnapshot);
void window.caps.getModelDownloads?.().then(applyDownloadSnapshot).catch(() => {});

$('#select-input').addEventListener('click', (event) => { event.stopPropagation(); chooseInput(); });
$('#add-inputs').addEventListener('click', chooseInput);
$('#clear-inputs').addEventListener('click', resetReady);
for (const type of ['dragenter', 'dragover']) $('#drop-zone').addEventListener(type, (event) => { event.preventDefault(); $('#drop-zone').classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) $('#drop-zone').addEventListener(type, (event) => { event.preventDefault(); $('#drop-zone').classList.remove('dragging'); });
$('#drop-zone').addEventListener('drop', async (event) => {
  const paths = [...event.dataTransfer.files].map((file) => window.caps.pathForFile(file)).filter(Boolean);
  if (paths.length) await addPaths(paths);
});
$('#start-job').addEventListener('click', () => runJob());
for (const input of document.querySelectorAll('input[name="orientation"]')) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    settings.orientation = input.value;
    for (const file of selectedFiles) file.outputPath = captionOutputPath(file.path, settings.orientation);
    applyOrientation();
    renderFileSelection();
  });
}
$('#cancel-job').addEventListener('click', () => {
  if (batchRunning && !window.confirm('Cancel the current job? Completed caption files will be kept.')) return;
  void window.caps.cancelJob();
});
$('#copy-job-log').addEventListener('click', async () => {
  try { await window.caps.copyText($('#technical-log').textContent); $('#copy-log-status').textContent = 'Copied'; }
  catch { $('#copy-log-status').textContent = 'Could not copy'; }
});
$('#add-queue-files').addEventListener('click', () => addQueueFiles());
$('#processing-view').addEventListener('dragover', (event) => {
  if (!draggedQueueId && queueSnapshot?.accepting && event.dataTransfer.types.includes('Files')) {
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  }
});
$('#processing-view').addEventListener('drop', (event) => {
  if (draggedQueueId || !queueSnapshot?.accepting || !event.dataTransfer.files.length) return;
  event.preventDefault();
  const paths = [...event.dataTransfer.files].map((file) => window.caps.pathForFile(file)).filter(Boolean);
  if (paths.length) void addQueueFiles(paths);
});
window.caps.onQueueChanged?.(applyQueueSnapshot);
$('#retry-job').addEventListener('click', () => runJob());
$('#back-ready').addEventListener('click', resetReady);
$('#process-another').addEventListener('click', resetReady);
$('#open-folder').addEventListener('click', () => window.caps.openOutputFolder(lastResult.outputPath));
$('#copy-path').addEventListener('click', async () => { await window.caps.copyText(lastResult.outputPath); showToast('Output path copied.'); });
$('#preview-search').addEventListener('input', (event) => {
  clearTimeout(previewSearchTimer);
  previewSearchTimer = setTimeout(() => { previewOffset = 0; renderPreview(lastResult, event.target.value, 0); }, 150);
});
$('#open-model-settings').addEventListener('click', () => { openSettings(true); settingsNavigation.open('model', $('#open-model-settings')); });
for (const id of ['#timing-min', '#timing-bridge']) $(id).addEventListener('input', updateSaveButton);
$('#settings-toggle').addEventListener('click', () => openSettings($('#settings-panel').hidden));
$('#settings-close').addEventListener('click', () => openSettings(false));
$('#settings-scrim').addEventListener('click', () => openSettings(false));
$('#setting-device').addEventListener('change', updateDeviceControls);
for (const button of document.querySelectorAll('[data-device]')) button.addEventListener('click', () => {
  $('#setting-device').value = button.dataset.device;
  $('#setting-device').dispatchEvent(new Event('change', { bubbles: true }));
});
document.querySelector('.device-segments').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const options = [...document.querySelectorAll('[data-device]')].filter(button => !button.disabled);
  const current = options.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (['ArrowLeft','ArrowUp'].includes(event.key) ? options.length - 1 : 1)) % options.length;
  options[next].click(); options[next].focus();
});
$('#use-automatic').addEventListener('click', () => {
  $('#setting-device').value = 'auto'; $('#setting-device').dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('[data-device="auto"]').focus();
});
for (const button of document.querySelectorAll('.orientation-toggle')) button.addEventListener('click', () => {
  document.querySelector(`input[name="orientation"][value="${button.dataset.orientation}"]`).click();
});
$('#setting-model').addEventListener('change', updateModelControls);
$('#setting-device-index').addEventListener('change', updateModelControls);
for (const radio of document.querySelectorAll('input[name="transcription-model"]')) radio.addEventListener('change', () => { $('#setting-model').value = radio.value; updateModelControls(); });
$('#save-settings').addEventListener('click', saveSettings);
$('#restore-settings').addEventListener('click', () => { settingsFormBase = structuredClone(defaults); applySettingsToForm(); $('#settings-status').textContent = 'Defaults restored'; });
$('#refresh-diagnostics').addEventListener('click', () => refreshDiagnostics(true));
$('#open-setup').addEventListener('click', () => openSettings(true));
window.addEventListener('keydown', (event) => {
  const panel = $('#settings-panel');
  if (panel.hidden || $('#model-delete-dialog').open) return;
  if (event.key === 'Escape') { openSettings(false); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary')]
    .filter((element) => element.getClientRects().length > 0);
  const first = focusable[0]; const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

window.caps.onProgress((event) => {
  if (!batchRunning || !progressTracker) return;
  if (Number.isInteger(event.fileIndex) && activeBatchFiles.length) {
    currentBatchIndex = event.fileIndex;
    const end = Number.isInteger(event.fileEndIndex) ? event.fileEndIndex : event.fileIndex;
    const range = end > event.fileIndex ? `Files ${event.fileIndex + 1}–${end + 1}` : `File ${event.fileIndex + 1}`;
    const names = activeBatchFiles.slice(event.fileIndex, end + 1).map((file) => file.name).join(', ');
    $('#batch-progress-label').textContent = event.queueItemId ? `Now processing · ${names}` : `${range} of ${activeBatchFiles.length} · ${names}`;
  }
  $('#stage-label').textContent = progressStages[event.phase] ?? stageNames[event.stage] ?? 'Processing…';
  progressTracker.update(event);
  renderProgress();
});
window.caps.onLog((entry) => appendTechnicalLog(entry.message));

async function loadStartupDiagnostics(force = false) {
  try {
    const startupDiagnostics = await window.caps.getDiagnostics(force);
    environmentDiagnostics = startupDiagnostics;
    renderCudaDevices();
    updateModelControls();
    updateReadyStatus();
    const issues = [];
    if (!startupDiagnostics.whisperx.available) issues.push('WhisperX was not detected');
    if (!startupDiagnostics.model.valid) issues.push(`${modelLabel(settings.model)} is not installed`);
    $('#environment-banner').hidden = issues.length === 0;
    if (issues.length) {
      $('#environment-message').textContent = `${issues.join(' and ')}. SRT conversion remains available.`;
      $('#environment-banner').hidden = false;
    }
  } catch {
    $('#environment-message').textContent = 'Environment diagnostics could not be completed. SRT conversion remains available.';
    $('#environment-banner').hidden = false;
  }
}

async function initializeRenderer() {
  try {
    settings = { ...defaults, ...await window.caps.getSettings(), ...fixedRuntimeSettings };
  } catch {
    settings = structuredClone(defaults);
  }
  if (!isSupportedModel(settings.model) && settings.model !== NO_MODEL) settings.model = defaults.model;
  savedSettings = structuredClone(settings);
  settings.mode = 'social-media';
  updateEngineLabel();
  applyOrientation();
  applySettingsToForm();
  const scheduleDiagnostics = () => loadStartupDiagnostics();
  if ('requestIdleCallback' in window) window.requestIdleCallback(scheduleDiagnostics, { timeout: 2000 });
  else setTimeout(scheduleDiagnostics, 800);
}

void initializeRenderer();
