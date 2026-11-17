export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  UNSUPPORTED_MODE: 'UNSUPPORTED_MODE',
  WHISPERX_NOT_FOUND: 'WHISPERX_NOT_FOUND',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  CUDA_UNAVAILABLE: 'CUDA_UNAVAILABLE',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  INVALID_GENERATED_SRT: 'INVALID_GENERATED_SRT',
  OUTPUT_CONFLICT: 'OUTPUT_CONFLICT',
  OUTPUT_UNWRITABLE: 'OUTPUT_UNWRITABLE',
  CANCELLED: 'CANCELLED'
});

export class CaptionJobError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = code === ERROR_CODES.CANCELLED ? 'AbortError' : 'CaptionJobError';
    this.code = code;
  }
}

export function cancelledError(cause) {
  return new CaptionJobError(ERROR_CODES.CANCELLED, 'Caption generation was cancelled.', { cause });
}

export function jobError(error, fallbackCode, fallbackMessage) {
  if (error instanceof CaptionJobError) return error;
  if (error?.code && Object.values(ERROR_CODES).includes(error.code)) {
    return new CaptionJobError(error.code, error.message, { cause: error });
  }
  return new CaptionJobError(fallbackCode, fallbackMessage ?? error?.message ?? 'Caption generation failed.', { cause: error });
}
