import { DEFAULT_MODEL, getModelStatus, modelLabel } from '../../model-catalog.js';

export function deviceRecommendation(hardware, { model, device = 'auto', deviceIndex = 0 }) {
  const selected = !model || model === 'none' ? DEFAULT_MODEL : model;
  const gpu = hardware.cuda?.devices?.find(item => item.index === Number(deviceIndex));
  const status = getModelStatus(selected, hardware, { device: 'cuda', deviceIndex }, { ignoreInstallation: true });
  if (gpu && status.supported && !status.pending) {
    const name = (gpu.name || 'NVIDIA GPU').replace(/^NVIDIA\s+(?:GeForce\s+)?/i, '');
    const turbo = getModelStatus(DEFAULT_MODEL, hardware, { device: 'cuda', deviceIndex }, { ignoreInstallation: true });
    const capableModel = turbo.supported && !turbo.pending ? DEFAULT_MODEL : selected;
    return { title: `Your ${name} can run ${modelLabel(capableModel)}.`,
      detail: model === 'none' ? 'Choose a speech model in Model to start creating captions.'
        : device === 'cpu' ? `CPU is currently selected. Use Auto to run ${modelLabel(selected)} on your GPU.`
        : device === 'auto' ? `Automatic will run ${modelLabel(selected)} on your GPU, with CPU fallback if needed.`
          : `GPU is selected. Your GPU will run ${modelLabel(selected)}.`,
      offerAutomatic: device !== 'auto', device: 'cuda' };
  }
  return { title: gpu ? 'Automatic can use the CPU while your GPU is unavailable.' : 'Automatic will use your CPU.',
    detail: status.status === 'insufficient_vram' ? device === 'cuda'
      ? 'GPU is selected, but GPU memory is currently limited. Use Auto to fall back to CPU.'
      : 'GPU memory is currently limited. Free some GPU memory to enable GPU transcription.'
      : gpu ? 'The CUDA runtime or GPU memory is not ready. Check Diagnostics for details.'
        : 'No compatible NVIDIA GPU was detected. You can still create captions on CPU.',
    offerAutomatic: device !== 'auto', device: 'cpu' };
}
