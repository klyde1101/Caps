import { extname, isAbsolute } from 'node:path';
import { CAPTION_LAYOUTS, CAPTION_FONT_SIZES, CAPTION_FONTS } from '../captions/layout.js';
import { isSupportedModel, NO_MODEL } from '../model-catalog.js';

export const IPC_CHANNELS = Object.freeze({
  GET_MODEL_DOWNLOADS: 'caps:get-model-downloads', INSTALL_MODEL: 'caps:install-model',
  DELETE_MODEL: 'caps:delete-model',
  CREATE_MEDIA_PREVIEW: 'caps:create-media-preview', MEDIA_PREVIEW_PROGRESS: 'caps:media-preview-progress',
  CANCEL_MODEL_INSTALL: 'caps:cancel-model-install', MODEL_DOWNLOADS_CHANGED: 'caps:model-downloads-changed',
  SELECT_INPUT: 'caps:select-input', INSPECT_INPUT: 'caps:inspect-input', SUGGEST_OUTPUT: 'caps:suggest-output',
  START_JOB: 'caps:start-job', CHECK_BATCH: 'caps:check-batch', START_BATCH: 'caps:start-batch', CANCEL_JOB: 'caps:cancel-job', JOB_PROGRESS: 'caps:job-progress', JOB_LOG: 'caps:job-log',
  START_QUEUE: 'caps:start-queue', ADD_QUEUE: 'caps:add-queue', MOVE_QUEUE: 'caps:move-queue', QUEUE_CHANGED: 'caps:queue-changed',
  GET_PREVIEW: 'caps:get-preview',
  SAVE_CAPTIONS: 'caps:save-captions',
  GET_DIAGNOSTICS: 'caps:get-diagnostics', GET_SETTINGS: 'caps:get-settings', SAVE_SETTINGS: 'caps:save-settings',
  OPEN_OUTPUT_FOLDER: 'caps:open-output-folder', COPY_TEXT: 'caps:copy-text'
});

export const SUPPORTED_EXTENSIONS = Object.freeze([
  '.srt', '.mp4', '.mov', '.mkv', '.avi', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'
]);

const MODES = new Set(['social-media']);
const DEVICES = new Set(['auto', 'cpu', 'cuda', 'xpu', 'mps']);
const COMPUTE_TYPES = new Set(['default', 'float16', 'float32', 'int8']);
const OUTPUT_BEHAVIORS = new Set(['beside-input', 'choose']);
const START_FIELDS = new Set(['inputPath', 'outputPath', 'overwrite', 'mode', 'language', 'model', 'whisperxPath', 'device', 'deviceIndex', 'computeType', 'grouping']);
const SETTINGS_FIELDS = new Set(['mode', 'orientation', 'fontSize', 'fontFamily', 'language', 'model', 'whisperxPath', 'device', 'deviceIndex', 'computeType', 'outputBehavior', 'timing']);

function validateFontFamily(value) {
  if (value !== undefined && (typeof value !== 'string' || !Object.hasOwn(CAPTION_FONTS, value))) {
    throw new DesktopRequestError('INVALID_REQUEST', 'Choose a supported caption font.');
  }
}

function validateFontSize(value) {
  if (value !== undefined && !CAPTION_FONT_SIZES.includes(value)) {
    throw new DesktopRequestError('INVALID_REQUEST', 'Choose a Premiere caption size: 60, 65, or 70.');
  }
}

function validateOrientation(value) {
  if (value !== undefined && (typeof value !== 'string' || !Object.hasOwn(CAPTION_LAYOUTS, value))) {
    throw new DesktopRequestError('INVALID_REQUEST', 'Choose a video orientation: 9:16, 4:5, or 16:9.');
  }
}

export class DesktopRequestError extends Error {
  constructor(code, message) { super(message); this.name = 'DesktopRequestError'; this.code = code; }
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopRequestError('INVALID_REQUEST', `${label} must be an object.`);
}

function assertKnownFields(value, allowed) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new DesktopRequestError('INVALID_REQUEST', `Unknown field: ${unknown}`);
}

function optionalString(value, label, allowEmpty = false) {
  if (value !== undefined && (typeof value !== 'string' || (!allowEmpty && !value.trim()))) throw new DesktopRequestError('INVALID_REQUEST', `${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
}

function numberInRange(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new DesktopRequestError('INVALID_REQUEST', `${label} must be between ${min} and ${max}.`);
}

function validateTiming(value) {
  assertRecord(value, 'timing');
  assertKnownFields(value, new Set(['minDurationMs', 'bridgeGapMs']));
  if (value.minDurationMs !== undefined) numberInRange(value.minDurationMs, 'timing.minDurationMs', 1, 10000);
  if (value.bridgeGapMs !== undefined) numberInRange(value.bridgeGapMs, 'timing.bridgeGapMs', 0, 5000);
}

function validateCommon(value, allowEmptyPaths = false) {
  if (value.mode !== undefined && !MODES.has(value.mode)) throw new DesktopRequestError('INVALID_REQUEST', 'Unsupported caption mode.');
  optionalString(value.language, 'language');
  optionalString(value.model, 'model', allowEmptyPaths);
  optionalString(value.whisperxPath, 'whisperxPath', allowEmptyPaths);
  if (value.device !== undefined && !DEVICES.has(value.device)) throw new DesktopRequestError('INVALID_REQUEST', 'Unsupported device.');
  if (value.deviceIndex !== undefined && (!Number.isInteger(value.deviceIndex) || value.deviceIndex < 0 || value.deviceIndex > 15)) throw new DesktopRequestError('INVALID_REQUEST', 'deviceIndex must be an integer between 0 and 15.');
  if (value.computeType !== undefined && !COMPUTE_TYPES.has(value.computeType)) throw new DesktopRequestError('INVALID_REQUEST', 'Unsupported compute type.');
}

export function validateStartRequest(value) {
  assertRecord(value, 'Job request');
  assertKnownFields(value, START_FIELDS);
  if (typeof value.inputPath !== 'string' || !isAbsolute(value.inputPath)) throw new DesktopRequestError('INVALID_REQUEST', 'inputPath must be an absolute path.');
  if (!SUPPORTED_EXTENSIONS.includes(extname(value.inputPath).toLowerCase())) throw new DesktopRequestError('INVALID_REQUEST', 'Unsupported input file type.');
  if (value.outputPath !== undefined && (typeof value.outputPath !== 'string' || !isAbsolute(value.outputPath))) throw new DesktopRequestError('INVALID_REQUEST', 'outputPath must be an absolute path.');
  if (value.overwrite !== undefined && typeof value.overwrite !== 'boolean') throw new DesktopRequestError('INVALID_REQUEST', 'overwrite must be a boolean.');
  if (value.grouping !== undefined) {
    assertRecord(value.grouping, 'grouping');
    assertKnownFields(value.grouping, new Set(['timing', 'orientation', 'fontSize', 'fontFamily']));
    validateOrientation(value.grouping.orientation);
    validateFontSize(value.grouping.fontSize);
    validateFontFamily(value.grouping.fontFamily);
    if (value.grouping.timing !== undefined) validateTiming(value.grouping.timing);
  }
  validateCommon(value);
  if (value.model !== undefined && !isSupportedModel(value.model)
    && !(value.model === NO_MODEL && extname(value.inputPath).toLowerCase() === '.srt')) throw new DesktopRequestError('INVALID_REQUEST', 'Choose Large v3 Turbo or Small.');
  return structuredClone(value);
}

export function validateBatchRequests(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new DesktopRequestError('INVALID_REQUEST', 'A batch must contain between 1 and 100 files.');
  const requests = value.map(validateStartRequest);
  const outputs = new Set();
  for (const request of requests) {
    if (!request.outputPath) throw new DesktopRequestError('INVALID_REQUEST', 'Every batch item requires an output path.');
    const key = request.outputPath.toLowerCase();
    if (outputs.has(key)) throw new DesktopRequestError('INVALID_REQUEST', 'Each batch item must use a different output path.');
    outputs.add(key);
  }
  return requests;
}

export function validateSettings(value) {
  assertRecord(value, 'Settings');
  assertKnownFields(value, SETTINGS_FIELDS);
  validateOrientation(value.orientation);
  validateFontSize(value.fontSize);
  validateFontFamily(value.fontFamily);
  validateCommon(value, true);
  if (value.outputBehavior !== undefined && !OUTPUT_BEHAVIORS.has(value.outputBehavior)) throw new DesktopRequestError('INVALID_REQUEST', 'Unsupported output behavior.');
  if (value.timing !== undefined) validateTiming(value.timing);
  return structuredClone(value);
}

export function validateQueueChange(value, moving = false) {
  assertRecord(value, 'Queue change');
  assertKnownFields(value, new Set(moving ? ['queueId', 'itemId', 'beforeId'] : ['queueId', 'requests']));
  const validId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
  if (!validId(value.queueId)) throw new DesktopRequestError('INVALID_REQUEST', 'Invalid queue.');
  if (moving) {
    if (!validId(value.itemId) || (value.beforeId !== null && !validId(value.beforeId))) throw new DesktopRequestError('INVALID_REQUEST', 'Invalid queue item.');
    return structuredClone(value);
  }
  return { queueId: value.queueId, requests: validateBatchRequests(value.requests) };
}

export function validateOutputPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new DesktopRequestError('INVALID_REQUEST', 'Output path must be absolute.');
  if (extname(value).toLowerCase() !== '.srt') throw new DesktopRequestError('INVALID_REQUEST', 'Output path must use the .srt extension.');
  if (value.length > 32000) throw new DesktopRequestError('PATH_TOO_LONG', 'The selected output path is too long.');
  return value;
}

export function serializeError(error) {
  return { name: error?.name ?? 'Error', code: error?.code ?? 'UNKNOWN', message: error?.message ?? 'An unknown error occurred.' };
}
