import { getModelStatus, modelInstalled as installed } from '../../model-catalog.js';
export const modelInstalled = (id, diagnostics, downloads) => installed(id, { ...diagnostics, downloads });

export function generationAvailability({ files, settings, diagnostics, downloads, running = false }) {
  if (!files.length) return { enabled: false, reason: 'Add media to get started', openSettings: false };
  if (running) return { enabled: false, reason: 'Processing captions', openSettings: false };
  const subtitleOnly = files.every(file => /\.srt$/i.test(file.path ?? file.inputPath ?? file.name ?? ''));
  const status = getModelStatus(settings.model, { ...diagnostics, downloads }, settings);
  if (!subtitleOnly && (status.status !== 'ready' || status.pending))
    return { enabled: false, reason: status.reason, openSettings: !status.pending, status: status.status };
  return { enabled: true, reason: `${files.length} ${files.length === 1 ? 'file' : 'files'} ready \u00b7 SRT saved beside each source file`, openSettings: false };
}
