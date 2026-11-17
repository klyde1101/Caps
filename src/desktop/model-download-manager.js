import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { whisperxCandidates } from '../whisperx-runner.js';

const WORKER = readFileSync(new URL('../model-download-worker.py', import.meta.url), 'utf8');
const repositories = JSON.parse(readFileSync(new URL('../model-repositories.json', import.meta.url), 'utf8'));
const RUNTIME_FILES = /^(config\.json|model\.bin|tokenizer\.json|vocabulary\.(json|txt)|preprocessor_config\.json|README\.md|LICENSE[^/\\\0]*)$/;
const required = ['config.json', 'model.bin', 'tokenizer.json'];
const failure = (code, message) => Object.assign(new Error(message), { code });
const interrupted = () => failure('DOWNLOAD_INTERRUPTED', 'Download interrupted. Retry to resume.');
const aborted = (signal) => { if (signal?.aborted) throw interrupted(); };

export function redactDownloadLog(value) {
  return String(value).replace(/https?:\/\/[^\s'"<>]+/g, (url) => {
    const clean = url.replace(/(https?:\/\/)[^/@]+@/, '$1[redacted]@');
    return clean.split('?')[0] + (clean.includes('?') ? '?[redacted]' : '');
  }).replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, '$1[redacted]')
    .replace(/(bearer\s+|(?:access_)?token\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/hf_[A-Za-z0-9]+/g, '[redacted]');
}

export function parseHubManifest(id, data) {
  if (!Object.hasOwn(repositories, id)) throw failure('INVALID_REQUEST', 'Unknown model.');
  if (!/^[a-f0-9]{40}$/i.test(data.sha) || !Array.isArray(data.siblings)) throw failure('INVALID_MANIFEST', 'Invalid Hub manifest.');
  const files = data.siblings.filter((file) => RUNTIME_FILES.test(file.rfilename)).map((file) => ({
    name: file.rfilename, size: file.size ?? file.lfs?.size, sha256: file.lfs?.sha256
  }));
  if (files.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0
    || file.sha256 && !/^[a-f0-9]{64}$/i.test(file.sha256)) || new Set(files.map((file) => file.name)).size !== files.length
    || !required.every((name) => files.some((file) => file.name === name))
    || !files.some((file) => /^vocabulary\.(json|txt)$/.test(file.name))) throw failure('INVALID_MANIFEST', 'The Hub repository is missing required model files or sizes.');
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw failure('INVALID_MANIFEST', 'Invalid download size.');
  return { id, repoId: repositories[id].repoId, revision: data.sha, totalBytes, files };
}

export async function downloadBytes(directory, manifest) {
  let bytes = 0;
  for (const file of manifest.files) {
    try { const info = await stat(join(directory, file.name)); if (info.isFile()) bytes += Math.min(file.size, info.size); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const cache = join(directory, '.cache', 'huggingface', 'download');
  try {
    for (const entry of await readdir(cache, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.incomplete')) continue;
      // Hugging Face prefixes incomplete files with their original filename.
      const file = manifest.files.find((file) => entry.name.startsWith(file.name + '.'));
      if (file && !existsSync(join(directory, file.name))) bytes += Math.min(file.size, (await stat(join(cache, entry.name))).size);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Math.min(bytes, manifest.totalBytes);
}

async function complete(directory) {
  try {
    const names = [...required, (await stat(join(directory, 'vocabulary.json')).catch(() => null)) ? 'vocabulary.json' : 'vocabulary.txt'];
    for (const name of names) { const info = await stat(join(directory, name)); if (!info.isFile() || info.size === 0) return false; }
    return true;
  } catch { return false; }
}

export async function verifyDownload(directory, manifest, signal) {
  for (const file of manifest.files) {
    aborted(signal);
    const info = await stat(join(directory, file.name));
    if (!info.isFile() || info.size !== file.size) throw failure('INCOMPLETE_MODEL', 'Downloaded model verification failed. Retry to resume.');
    if (file.sha256) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(directory, file.name))) { aborted(signal); hash.update(chunk); }
      if (hash.digest('hex') !== file.sha256) {
        await rm(join(directory, file.name)); // Only the corrupt staged file; retry downloads it again.
        throw failure('INCOMPLETE_MODEL', 'Downloaded model verification failed. Retry to resume.');
      }
    }
  }
  if (!await complete(directory)) throw failure('INCOMPLETE_MODEL', 'Required model files are missing. Retry to resume.');
}

export class ModelDownloadManager {
  constructor({ root = process.env.PORTABLE_EXECUTABLE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    onChange = () => {}, fetchImpl = globalThis.fetch, spawnImpl = spawn,
    findPython = async () => whisperxCandidates({ device: 'cpu' }).find((path) => basename(path).toLowerCase() === 'python.exe' && existsSync(path)),
    freeBytes = async (directory) => { const info = await statfs(directory); return info.bavail * info.bsize; }, pollMs = 500,
    isModelInUse = () => false } = {}) {
    this.root = resolve(root); this.modelsRoot = join(this.root, 'models');
    this.stagingRoot = join(this.modelsRoot, '.downloads');
    this.onChange = onChange; this.fetchImpl = fetchImpl; this.spawnImpl = spawnImpl;
    this.findPython = findPython; this.freeBytes = freeBytes; this.pollMs = pollMs;
    this.isModelInUse = isModelInUse;
    this.states = Object.fromEntries(Object.keys(repositories).map((id) => [id, { id, state: 'idle' }]));
    this.catalog = {}; this.active = null; this.closing = false; this.deleting = null; this.deletionDone = null;
  }

  paths(id) {
    if (typeof id !== 'string' || !Object.hasOwn(repositories, id)) throw failure('INVALID_REQUEST', 'Choose a supported model.');
    const directory = resolve(this.stagingRoot, id);
    if (!directory.startsWith(this.stagingRoot + sep)) throw failure('INVALID_REQUEST', 'Invalid staging path.');
    return { directory, target: join(this.modelsRoot, id) };
  }

  snapshot() { return structuredClone({ models: this.states, catalog: this.catalog, activeId: this.active?.id ?? null }); }
  notify() { try { this.onChange(this.snapshot()); } catch { /* A renderer closing or reloading cannot cancel a download. */ } }
  publish(id, patch) { this.states[id] = { ...this.states[id], ...patch }; this.notify(); }

  async initialize() {
    await mkdir(this.stagingRoot, { recursive: true });
    for (const id of Object.keys(repositories)) {
      const { directory, target } = this.paths(id);
      if (await complete(target)) this.states[id] = { id, state: 'installed' };
      try {
        const cached = JSON.parse(await readFile(join(directory, 'caps-manifest.json'), 'utf8'));
        // Revalidate cached file names, sizes, revision and allowlisted repository.
        const manifest = parseHubManifest(id, { sha: cached.revision, siblings: cached.files.map((file) => ({ rfilename: file.name, size: file.size, lfs: file.sha256 ? { sha256: file.sha256 } : undefined })) });
        this.catalog[id] = manifest;
        if (this.states[id].state !== 'installed') this.states[id] = { id, state: 'failed', message: interrupted().message, bytes: await downloadBytes(directory, manifest) };
      } catch { /* A missing or invalid resume record is never an installed model. */ }
    }
    return this.snapshot();
  }

  async manifest(id, signal) {
    this.paths(id);
    const response = await this.fetchImpl(`https://huggingface.co/api/models/${repositories[id].repoId}?blobs=true`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw failure('HUB_UNAVAILABLE', 'Hugging Face is unavailable. Check your connection and retry.');
    const manifest = parseHubManifest(id, await response.json());
    this.catalog[id] = manifest;
    return manifest;
  }

  async refreshCatalog() {
    await Promise.all(Object.keys(repositories).map(async (id) => {
      try { await this.manifest(id); }
      catch { /* Offline mode keeps installed models and verified cached metadata usable. */ }
    }));
    this.notify();
    return this.snapshot();
  }

  start(id) {
    this.paths(id);
    if (this.closing) throw failure('DOWNLOAD_INTERRUPTED', 'Caps is closing.');
    if (this.active) throw failure('DOWNLOAD_BUSY', 'Another model is downloading. Wait or cancel it first.');
    if (this.deleting) throw failure('MODEL_BUSY', 'A model is being deleted.');
    const operation = { id, controller: new AbortController(), child: null, done: null, cancel: false };
    this.active = operation;
    this.publish(id, { state: 'preparing', message: '', percent: 0, speed: 0, eta: null });
    operation.done = this.run(operation).catch(async (error) => {
      try {
        const logs = join(this.root, 'data', 'logs'); await mkdir(logs, { recursive: true });
        await appendFile(join(logs, `model-download-${id}.log`), redactDownloadLog(`${new Date().toISOString()} ${error.stack || error.message}\n${error.cause?.stack || ''}\n`));
      } catch { /* A read-only disk must not prevent orderly cancellation or shutdown. */ }
      if (operation.cancel) {
        try { await rm(this.paths(id).directory, { recursive: true, force: true }); }
        catch { this.publish(id, { state: 'failed', message: 'Download stopped, but temporary files could not be removed. Retry or check folder permissions.' }); return; }
        this.publish(id, { state: 'idle', message: '', percent: 0, bytes: 0 });
      } else this.publish(id, { state: 'failed', message: this.closing ? interrupted().message
        : ['NO_SPACE', 'PYTHON_MISSING', 'INCOMPLETE_MODEL', 'HUB_UNAVAILABLE'].includes(error.code) ? error.message
          : 'Download failed. Check your connection and retry.' });
    }).finally(() => { this.active = null; this.notify(); });
    return this.snapshot();
  }

  async run(operation) {
    const { id, controller } = operation; const { signal } = controller;
    const { directory, target } = this.paths(id);
    if (await complete(target)) { this.publish(id, { state: 'installed', percent: 100 }); return; }
    await mkdir(directory, { recursive: true });
    // Resume the same pinned revision, even when upstream main has changed.
    let manifest;
    try { const cached = JSON.parse(await readFile(join(directory, 'caps-manifest.json'), 'utf8'));
      manifest = parseHubManifest(id, { sha: cached.revision, siblings: cached.files.map((file) => ({ rfilename: file.name, size: file.size, lfs: file.sha256 ? { sha256: file.sha256 } : undefined })) });
    } catch { manifest = await this.manifest(id, signal); }
    this.catalog[id] = manifest;
    await writeFile(join(directory, 'caps-manifest.json.tmp'), JSON.stringify(manifest));
    await rename(join(directory, 'caps-manifest.json.tmp'), join(directory, 'caps-manifest.json'));
    aborted(signal);
    const initialBytes = await downloadBytes(directory, manifest);
    const available = await this.freeBytes(this.modelsRoot);
    if (available < manifest.totalBytes - initialBytes + Math.max(128 * 1024 ** 2, manifest.totalBytes * .05)) {
      throw failure('NO_SPACE', 'Not enough free disk space. Free some space and retry.');
    }
    const python = await this.findPython();
    if (!python) throw failure('PYTHON_MISSING', 'The bundled Python runtime is missing. Restore the Caps runtime and retry.');
    const logDirectory = join(this.root, 'data', 'logs'); await mkdir(logDirectory, { recursive: true });
    const log = await open(join(logDirectory, `model-download-${id}.log`), 'a');
    let timer;
    try {
      aborted(signal);
      const env = { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1',
        HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_XET: '1', HF_ENDPOINT: 'https://huggingface.co', PYTHONUTF8: '1' };
      for (const key of ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_HUB_TOKEN', 'HF_TOKEN_PATH', 'HF_HUB_OFFLINE']) delete env[key];
      const child = this.spawnImpl(python, ['-u', '-c', WORKER, String(process.pid), manifest.repoId,
        manifest.revision, directory, JSON.stringify(manifest.files.map((file) => file.name))], {
        windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd], env
      });
      operation.child = child;
      const exited = new Promise((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('close', (code) => code === 0 ? resolveExit() : rejectExit(failure('DOWNLOAD_FAILED', 'Download process failed.')));
      });
      const kill = () => { if (child.exitCode === null || child.exitCode === undefined) child.kill(); };
      signal.addEventListener('abort', kill, { once: true });
      let previousBytes = initialBytes; let previousTime = Date.now(); let polling = false;
      this.publish(id, { state: 'downloading', bytes: initialBytes, totalBytes: manifest.totalBytes,
        percent: Math.min(99, Math.floor(initialBytes / manifest.totalBytes * 100)) });
      timer = setInterval(async () => {
        if (polling) return; polling = true;
        try {
          const bytes = await downloadBytes(directory, manifest); const now = Date.now();
          const speed = Math.max(0, (bytes - previousBytes) / Math.max(.001, (now - previousTime) / 1000));
          previousBytes = bytes; previousTime = now;
          if (this.states[id].state === 'downloading') this.publish(id, { bytes, totalBytes: manifest.totalBytes,
            percent: Math.min(99, Math.floor(bytes / manifest.totalBytes * 100)), speed,
            eta: speed > 0 ? Math.ceil((manifest.totalBytes - bytes) / speed) : null });
        } catch { /* A cache rename during polling is expected; the next tick catches up. */ }
        finally { polling = false; }
      }, this.pollMs);
      try { await exited; } finally { signal.removeEventListener('abort', kill); }
      aborted(signal);
      this.publish(id, { state: 'verifying', percent: 99, speed: 0, eta: null });
      await verifyDownload(directory, manifest, signal);
      aborted(signal);
      // Rename is on the same volume. The supported model name is never a partial download.
      if (!await complete(target)) {
        const backup = join(this.stagingRoot, id + '.previous');
        let moved = false;
        try { await rename(target, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { await rename(directory, target); }
        catch (error) { if (moved) await rename(backup, target); throw error; }
        if (moved) await rm(backup, { recursive: true, force: true }).catch(() => {});
      }
      this.publish(id, { state: 'installed', bytes: manifest.totalBytes, totalBytes: manifest.totalBytes, percent: 100, message: '' });
    } finally { if (timer) clearInterval(timer); operation.child = null; await log.close(); }
  }

  async cancel(id) {
    this.paths(id);
    if (!this.active || this.active.id !== id) return this.snapshot();
    this.active.cancel = true; this.active.controller.abort(); await this.active.done;
    return this.snapshot();
  }

  async deleteModel(id) {
    const { target } = this.paths(id);
    if (this.active || this.deleting || this.closing || this.isModelInUse(id)) throw failure('MODEL_BUSY', 'Finish the current job or model operation before deleting a model.');
    this.deleting = id;
    let finished;
    this.deletionDone = new Promise(resolve => { finished = resolve; });
    try {
      // Only supported model directories may be removed; never follow junctions
      // into a shared cache, user directory, or a different installation.
      for (const directory of [this.root, this.modelsRoot, target]) {
        const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (info?.isSymbolicLink()) throw failure('INVALID_MODEL_PATH', 'Linked model folders cannot be deleted from Settings.');
      }
      const inspect = async directory => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw failure('INVALID_MODEL_PATH', 'Linked model files cannot be deleted from Settings.');
          if (entry.isDirectory()) await inspect(join(directory, entry.name));
        }
      };
      if (await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) await inspect(target);
        if (process.platform === 'win32') {
          // Detect sharing violations before rm can partially remove a model.
          await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "$ErrorActionPreference='Stop'; if (Test-Path -LiteralPath $env:CAPS_MODEL_DELETE_TARGET) { foreach ($file in Get-ChildItem -LiteralPath $env:CAPS_MODEL_DELETE_TARGET -File -Recurse) { $handle=[System.IO.File]::Open($file.FullName,'Open','Read','None'); $handle.Dispose() } }"],
          { windowsHide: true, timeout: 15000, env: { ...process.env, CAPS_MODEL_DELETE_TARGET: target } })
            .catch(() => { throw failure('MODEL_LOCKED', 'Model files are in use or locked. Close other Caps instances and try again.'); });
        }
        await rm(target, { recursive: true, force: true });
      this.states[id] = { id, state: 'idle' };
      this.notify();
      return this.snapshot();
    } catch (error) {
      if (!await complete(target)) { this.states[id] = { id, state: 'idle' }; this.notify(); }
      throw error;
    } finally { this.deleting = null; finished(); this.deletionDone = null; }
  }

  async shutdown() {
    this.closing = true;
    if (this.active) { this.active.controller.abort(); await this.active.done; }
    if (this.deletionDone) await this.deletionDone;
  }
}
