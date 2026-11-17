import { cpus, freemem, totalmem } from 'node:os';

export const SMART_VERSION = 1;
export const cpuThreads = () => Math.max(1, Math.min(4, Math.floor(cpus().length / 4)));

// Estimates are seconds per audio second. An absent/stale profile is never a licence to speculate.
export class SmartScheduler {
  constructor(profile, { now = () => performance.now(), resources, onStatus = () => {} } = {}) {
    this.profile = profile;
    this.now = now;
    this.resources = resources ?? (() => ({ freeRam: freemem(), totalRam: totalmem(), threads: cpus().length }));
    this.onStatus = onStatus;
    this.state = 'idle';
    this.changed = -Infinity;
    this.observed = 0;
    this.samples = 0;
    this.slow = 0;
  }
  status(state, reason, estimates = {}) {
    if (this.state !== state || this.reason !== reason) {
      this.state = state; this.reason = reason; this.changed = this.now();
      this.onStatus({ state, reason, threads: cpuThreads(), ...estimates });
    }
    return state === 'active';
  }
  observe({ duration, seconds, overlap, model }) {
    const p = this.profile;
    if (!duration || !seconds || !p || model !== p.model) return;
    if (!overlap) { this.observed += seconds; this.samples++;
      if (this.samples > 1 && seconds / duration > p.transcriptionRtf * 1.25) this.status('disabled', 'GPU throughput differs from calibration.');
    }
    else {
      this.slow = seconds / duration > p.transcriptionRtf * 1.15 ? this.slow + 1 : 0;
      if (this.slow >= 2) this.status('disabled', 'GPU transcription slowed during CPU assistance.');
    }
  }
  decide({ duration, remaining, pendingAlignment, model, cuda, recovery = false, cpuBusy = false, gpuFreeBytes, overheadSeconds = 0 }) {
    if (this.state === 'disabled') return false;
    const p = this.profile;
    if (!cuda) return this.status('paused', 'GPU transcription is unavailable; using Normal Mode.');
    if (Number.isFinite(gpuFreeBytes) && gpuFreeBytes < 512 * 1024 ** 2) return this.status('paused', 'GPU memory pressure; prioritizing transcription.');
    if (recovery) return this.status('paused', 'This file needs GPU speech recovery.');
    if (!p || p.version !== SMART_VERSION || p.model !== model || p.threads !== cpuThreads()
      || (p.cpuModel && p.cpuModel !== cpus()[0]?.model) || (p.logicalThreads && p.logicalThreads !== cpus().length)
      || Date.now() - p.created > 7 * 86400000 || p.validated !== true
      || !['cpuRtf', 'gpuRtf', 'transcriptionRtf', 'startupSeconds', 'ramBytes', 'minDuration', 'maxDuration', 'created', 'samples'].every(k => Number.isFinite(p[k]) && p[k] >= 0)
      || p.cpuRtf <= 0 || p.gpuRtf <= 0 || p.transcriptionRtf <= 0 || p.samples < 3) {
      return this.status('paused', 'Reliable local calibration is required; using Normal Mode.');
    }
    if (duration < p.minDuration || duration > p.maxDuration) return this.status('paused', 'File duration is outside the calibrated range.');
    if (this.samples < 2 || this.observed < 10) return this.status('paused', 'Observing GPU transcription before enabling CPU assistance.');
    if (cpuBusy) return false;
    if (remaining <= 0) return this.status('paused', 'No reliably measured transcription work remains to overlap.');
    const r = this.resources();
    if (r.threads < 4 || r.cpuLoad > .8 || r.freeRam < Math.max(2 * 1024 ** 3, p.ramBytes * 1.5) || r.freeRam / r.totalRam < .2) {
      return this.status('paused', 'CPU or memory pressure; waiting for Normal Mode alignment.');
    }
    if (this.state === 'paused' && this.now() - this.changed < 5000) return false;
    // Include outstanding CPU work, initialization and a 15% transcription contention allowance.
    const baseline = remaining + pendingAlignment * p.gpuRtf;
    const assisted = overheadSeconds + Math.max(remaining * 1.15, duration * p.cpuRtf + (this.started ? 0 : p.startupSeconds))
      + Math.max(0, pendingAlignment - duration) * p.gpuRtf;
    if (assisted > baseline * .95) return this.status('paused', 'Predicted total time would not improve by at least 5%.', { baseline, assisted });
    this.started = true;
    return this.status('active', 'CPU alignment overlaps GPU transcription.', { baseline, assisted });
  }
}
