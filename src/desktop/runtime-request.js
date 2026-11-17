import { extname } from 'node:path';
import { CaptionJobError, ERROR_CODES } from '../errors.js';
import { inspectLocalModel } from '../whisperx-runner.js';
import { DEFAULT_MODEL, modelLabel, modelCompatibility } from '../model-catalog.js';

export function resolveDesktopRuntimeRequest(request, dependencies = {}) {
  if (extname(request.inputPath).toLowerCase() === '.srt') return request;
  const capability = dependencies.diagnostics && modelCompatibility(request.model || DEFAULT_MODEL, dependencies.diagnostics, request);
  if (capability && !capability.supported) {
    throw new CaptionJobError(ERROR_CODES.INVALID_INPUT, `${modelLabel(request.model || DEFAULT_MODEL)}: ${capability.reason}`);
  }
  const status = inspectLocalModel(request.model, dependencies);
  if (!status.valid) {
    throw new CaptionJobError(
      ERROR_CODES.MODEL_NOT_FOUND,
      `${modelLabel(request.model || DEFAULT_MODEL)} is not installed locally: ${status.missingFiles.join(', ')}`
    );
  }
  return { ...request, processingPolicy: request.device ?? 'auto', cpuFallbackAllowed: !dependencies.diagnostics || modelCompatibility(request.model || DEFAULT_MODEL, dependencies.diagnostics, { device: 'cpu' }).supported, model: status.model, ...(request.device !== 'cuda' && request.device !== 'cpu' && capability?.device ? { device: capability.device } : {}) };
}
