export const DEFAULT_MODEL = 'large-v3-turbo';
export const NO_MODEL = 'none';
// VRAM uses GiB everywhere (1 GiB = 1024^3 bytes). Unmeasured FP16 budgets
// include alignment; UI labels these recommendations, not verified requirements.
// Sizes are rounded from the installed CTranslate2 model directories. CPU uses INT8.
export const AVAILABLE_MODELS = Object.freeze([
  Object.freeze({ id: 'large-v3-turbo', label: 'Large v3 Turbo', descriptor: 'Accurate', modelSizeGB: 1.62,
    gpuVramGiB: 4, gpuRamGiB: 8, cpuRamGiB: 12, cudaComputeType: 'float16', cpuComputeType: 'int8', vramVerified: false }),
  Object.freeze({ id: 'small', label: 'Small', descriptor: 'Fast', modelSizeGB: .49,
    gpuVramGiB: 2, gpuRamGiB: 4, cpuRamGiB: 6, cudaComputeType: 'float16', cpuComputeType: 'int8', vramVerified: false })
]);

export function isSupportedModel(model) {
  return AVAILABLE_MODELS.some(({ id }) => id === model);
}

export function modelLabel(model) {
  return AVAILABLE_MODELS.find(({ id }) => id === model)?.label ?? (model === NO_MODEL ? 'None' : 'Selected model');
}

export function modelInstalled(id, hardware = {}) {
  const download = hardware.downloads?.models?.[id];
  if (download) return download.state === 'installed';
  return hardware.models?.some(model => model.id === id && model.installed) === true;
}

const gb = bytes => Number((bytes / 1024 ** 3).toFixed(2)).toString();
export function getModelStatus(model, hardware = {}, deviceSetting = 'auto', { ignoreInstallation = false } = {}) {
  const spec = AVAILABLE_MODELS.find(({ id }) => id === (typeof model === 'string' ? model : model?.id));
  const { device = 'auto', deviceIndex = 0 } = typeof deviceSetting === 'string' ? { device: deviceSetting } : deviceSetting;
  const result = (status, reason, extra = {}) => ({ status, reason, supported: status === 'ready',
    installed: Boolean(spec && modelInstalled(spec.id, hardware)), ...extra });
  if (!spec || !ignoreInstallation && !modelInstalled(spec.id, hardware)) {
    const known = Boolean(hardware.downloads) || Array.isArray(hardware.models);
    return result('not_installed', known || !spec ? 'Model not downloaded' : 'Checking models', { pending: !known && Boolean(spec) });
  }
  const cpuAvailable = hardware.runtimes?.cpu?.available !== false;
  const cpu = () => cpuAvailable
    ? result('ready', '', { device: 'cpu', advisory: `${spec.id === 'large-v3-turbo' ? 'Turbo may be slow on CPU. ' : ''}CPU INT8; ${spec.cpuRamGiB} GB RAM recommended.` })
    : result('runtime_unavailable', 'CPU runtime unavailable', { issue: 'cpu-runtime' });
  if (device === 'cpu') return cpu();
  const gpu = hardware.cuda?.devices?.find(gpu => gpu.index === Number(deviceIndex));
  const cudaAvailable = hardware.runtimes?.cuda?.available ?? (hardware.whisperx?.cudaSupport === 'supported');
  if (!gpu || !cudaAvailable) {
    if (device === 'auto') return cpu();
    return result('cuda_unavailable', !gpu
      ? hardware.cuda?.devices?.length ? 'Selected CUDA device unavailable' : 'No CUDA device detected'
      : 'CUDA runtime unavailable', { issue: 'cuda-runtime' });
  }
  const availableBytes = gpu.freeMemoryBytes ?? gpu.totalMemoryBytes;
  const requiredBytes = spec.gpuVramGiB * 1024 ** 3;
  if (!Number.isFinite(availableBytes)) return result('ready', 'Checking GPU memory', { device: 'cuda', pending: true });
  if (requiredBytes > availableBytes) {
    if (device === 'auto' && cpuAvailable) return cpu();
    const shown = Number(gb(availableBytes)) >= spec.gpuVramGiB ? `<${spec.gpuVramGiB}` : gb(availableBytes);
    return result('insufficient_vram', `Not enough VRAM: recommended ~${spec.gpuVramGiB} GiB, ${shown} GiB available`,
      { issue: 'vram', requiredGiB: spec.gpuVramGiB, requiredBytes, availableBytes });
  }
  return result('ready', '', { device: 'cuda', requiredBytes, availableBytes });
}

// Keep runtime admission on the same policy; the runner validates physical files.
export function modelCompatibility(model, hardware = {}, settings = {}) {
  const status = getModelStatus(model, hardware, settings, { ignoreInstallation: true });
  return { ...status, label: status.reason };
}

export function modelInformation(model, hardware = {}) {
  const spec = AVAILABLE_MODELS.find(({ id }) => id === model);
  if (!spec) return null;
  const bytes = hardware.models?.find(item => item.id === model)?.sizeBytes
    || hardware.downloads?.catalog?.[model]?.totalBytes;
  return { ...spec, modelSize: bytes ? (bytes / 1e9).toFixed(2) : spec.modelSizeGB.toFixed(2),
    sizeBytes: bytes || Math.round(spec.modelSizeGB * 1e9), sizeEstimated: !bytes };
}
