import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { totalmem, freemem } from 'node:os';

const execFileAsync = promisify(execFile);

export function detectSystemMemory() {
  return { totalBytes: totalmem(), freeBytes: freemem() };
}

export function parseNvidiaSmiOutput(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length < 4) return undefined;
      const [indexText, name, totalText, freeText] = parts;
      const index = Number(indexText);
      const totalMemoryMiB = Number(totalText);
      const freeMemoryMiB = Number(freeText);
      if (!Number.isInteger(index) || !name || !Number.isFinite(totalMemoryMiB) || !Number.isFinite(freeMemoryMiB)) return undefined;
      return {
        index,
        name,
        totalMemoryMiB,
        freeMemoryMiB,
        totalMemoryBytes: Math.round(totalMemoryMiB * 1024 * 1024),
        freeMemoryBytes: Math.round(freeMemoryMiB * 1024 * 1024)
      };
    })
    .filter(Boolean);
}

export async function detectCudaDevices({ run = execFileAsync } = {}) {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.free',
      '--format=csv,noheader,nounits'
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const devices = parseNvidiaSmiOutput(stdout);
    return { available: devices.length > 0, devices };
  } catch (error) {
    return { available: false, devices: [], error: error.code || error.message || 'CUDA detection failed.' };
  }
}
