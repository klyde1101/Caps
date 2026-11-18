import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UPDATE_API = 'https://api.github.com/repos/klyde1101/Caps/releases?per_page=100';
export const RUNTIME_REVISION = 1;
const MAX_ARCHIVE = 1024 ** 3;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function compareVersions(a, b) {
  const parse = value => {
    const match = typeof value === 'string' && value.match(versionPattern);
    if (!match || (match[4]?.split('.').some(v => /^\d+$/.test(v) && v.length > 1 && v[0] === '0'))) throw new Error('Invalid release version.');
    return [...match.slice(1, 4).map(Number), match[4]?.split('.')];
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  if (!left[3] || !right[3]) return left[3] === right[3] ? 0 : left[3] ? -1 : 1;
  for (let i = 0; i < Math.max(left[3].length, right[3].length); i++) {
    const x = left[3][i], y = right[3][i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return x.length !== y.length ? Math.sign(x.length - y.length) : x < y ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function selectRelease(releases, current) {
  if (!Array.isArray(releases)) throw new Error('GitHub returned invalid release information.');
  return releases.filter(release => {
    if (release.draft || (release.prerelease && !current.includes('-'))) return false;
    try { return compareVersions(release.tag_name?.replace(/^v/, ''), current) > 0; } catch { return false; }
  }).sort((a, b) => compareVersions(b.tag_name.replace(/^v/, ''), a.tag_name.replace(/^v/, '')))[0];
}

export function validateAssetUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    throw new Error('The update download address is not trusted.');
  }
  return url.href;
}

async function request(url, fetchImpl, signal) {
  for (let redirects = 0; redirects < 6; redirects++) {
    const response = await fetchImpl(validateAssetUrl(url), { redirect: 'manual', signal,
      headers: { 'User-Agent': 'Caps-Updater', Accept: 'application/vnd.github+json' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('The update redirect is missing its address.');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429
      ? 'GitHub is limiting update checks. Try again later.' : `Update request failed (${response.status}).`);
    return response;
  }
  throw new Error('The update download redirected too many times.');
}

async function bytes(response, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Update metadata is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function validateUpdateManifest(manifest, release) {
  const version = release.tag_name.replace(/^v/, '');
  const name = `Caps-${version}-Update-x64.zip`;
  const asset = release.assets?.find(asset => asset.name === name);
  if (manifest.schema !== 1 || manifest.version !== version || manifest.runtimeRevision !== RUNTIME_REVISION ||
      manifest.archive !== name || !/^dist\/app-[a-f0-9]{24}$/.test(manifest.runtimeDirectory) ||
      !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > MAX_ARCHIVE ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !asset || asset.size !== manifest.size ||
      asset.digest !== `sha256:${manifest.sha256}` ||
      asset.browser_download_url !== `https://github.com/klyde1101/Caps/releases/download/${release.tag_name}/${name}`) {
    throw new Error('This release needs the full installer or has invalid update data.');
  }
  return { ...manifest, url: validateAssetUrl(asset.browser_download_url) };
}

export class AppUpdates {
  constructor({ root, version, enabled = true, fetchImpl = globalThis.fetch, onChange = () => {}, spawnImpl = spawn, writeFileImpl = writeFile }) {
    Object.assign(this, { root, version, enabled, fetchImpl, onChange, spawnImpl, writeFileImpl });
    this.state = { state: 'idle', version, automatic: true, message: enabled ? 'Updates are checked automatically.' : 'Updates are available in the installed Windows app.' };
    this.preferenceOperation = Promise.resolve();
    this.preferencePending = 0;
  }
  snapshot() { return structuredClone(this.state); }
  publish(values) { Object.assign(this.state, values); this.onChange(this.snapshot()); }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'data/updates/preferences.json'), 'utf8'));
      this.state.automatic = saved.automatic !== false;
    } catch { /* Missing or invalid preferences use the documented default. */ }
    try {
      const result = JSON.parse((await readFile(join(this.root, 'data/updates/result.json'), 'utf8')).replace(/^\uFEFF/, ''));
      if (result.state === 'error') this.publish({ state: 'error', message: `The previous update could not finish: ${result.message}` });
    } catch { /* There may be no previous update result. */ }
    this.publish({ automatic: this.state.automatic });
    return this.snapshot();
  }
  async setAutomatic(automatic) {
    if (typeof automatic !== 'boolean') throw new Error('Choose whether to enable automatic updates.');
    if (this.stopping) throw new Error('Caps is closing. Open it again to change update settings.');
    const previous = this.state.automatic;
    const cancelled = !automatic && this.pending;
    const download = this.operation;
    // Revoke permission before any disk I/O, including on a failed preference save.
    if (!automatic) { this.abort?.abort(); this.pending = undefined; }
    this.publish({ automatic });
    if (!automatic) this.publish({ state: 'idle', message: 'Automatic updates are off. You can still check manually.' });
    this.preferencePending++;
    const saving = this.preferenceOperation.catch(() => {}).then(async () => {
      const folder = join(this.root, 'data/updates');
      const temporary = join(folder, `preferences-${randomUUID()}.tmp`);
      try {
        if (!automatic) {
          await download;
          if (cancelled) await rm(cancelled.record, { force: true });
        }
        await mkdir(folder, { recursive: true });
        await this.writeFileImpl(temporary, JSON.stringify({ automatic }));
        await rename(temporary, join(folder, 'preferences.json'));
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.preferenceOperation = saving;
    try { await saving; }
    catch (error) {
      if (this.preferenceOperation === saving) this.publish({ automatic: previous, state: 'error', message: `Could not save update settings: ${error.message}` });
      throw error;
    } finally { this.preferencePending--; }
    return this.snapshot();
  }
  check() {
    if (this.stopping) return Promise.resolve(this.snapshot());
    if (this.preferencePending) {
      return this.preferenceOperation.catch(() => {}).then(() => this.check());
    }
    if (this.operation) return this.operation;
    if (this.state.state === 'ready') return Promise.resolve(this.snapshot());
    this.operation = this.performCheck().finally(() => { this.operation = undefined; });
    return this.operation;
  }
  async performCheck() {
    if (!this.enabled) return this.snapshot();
    const controller = new AbortController(); this.abort = controller;
    const metadataSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    this.publish({ state: 'checking', message: 'Checking GitHub Releases…', percent: 0 });
    let part;
    try {
      const response = await request(UPDATE_API, this.fetchImpl, metadataSignal);
      const release = selectRelease(JSON.parse((await bytes(response, 4 * 1024 ** 2)).toString('utf8')), this.version);
      if (!release) { this.publish({ state: 'current', message: 'You have the latest version.' }); return this.snapshot(); }
      const version = release.tag_name.replace(/^v/, '');
      const asset = release.assets?.find(asset => asset.name === `Caps-${version}-Update.json`);
      if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || asset.size > 65536 ||
          asset.browser_download_url !== `https://github.com/klyde1101/Caps/releases/download/${release.tag_name}/${asset.name}`) {
        throw new Error(`Version ${version} is available. This release requires the full installer from GitHub Releases.`);
      }
      const metadata = await bytes(await request(asset.browser_download_url, this.fetchImpl, metadataSignal), 65536);
      if (createHash('sha256').update(metadata).digest('hex') !== asset.digest.slice(7)) throw new Error('The update manifest checksum did not match.');
      const manifest = validateUpdateManifest(JSON.parse(metadata), release);
      const folder = join(this.root, 'data/updates'); await mkdir(folder, { recursive: true });
      part = join(folder, `${randomUUID()}.part`);
      const downloadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
      const download = await request(manifest.url, this.fetchImpl, downloadSignal);
      this.publish({ state: 'downloading', availableVersion: version, message: `Downloading Caps ${version}…` });
      const output = await open(part, 'wx'); const hash = createHash('sha256'); let received = 0;
      try {
        for await (const chunk of download.body) {
          received += chunk.length;
          if (received > manifest.size) throw new Error('The update download is larger than expected.');
          hash.update(chunk); await output.writeFile(chunk);
          this.publish({ percent: Math.floor(received / manifest.size * 100) });
        }
        await output.sync();
      } finally { await output.close(); }
      if (received !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('The update download checksum did not match.');
      controller.signal.throwIfAborted();
      const archive = join(folder, manifest.archive); await rename(part, archive); part = undefined;
      const helper = join(folder, 'apply-update.ps1');
      await writeFile(helper, await readFile(fileURLToPath(new URL('./apply-update.ps1', import.meta.url))));
      const attemptId = randomUUID();
      const record = join(folder, `pending-${attemptId}.json`);
      await this.writeFileImpl(record, JSON.stringify({ ...manifest, attemptId, root: this.root, archive, parentPid: process.pid }));
      if (controller.signal.aborted) {
        await rm(record, { force: true });
        controller.signal.throwIfAborted();
      }
      this.pending = { helper, record };
      this.publish({ state: 'ready', percent: 100, message: `Caps ${version} is ready. It will install when you close Caps.` });
    } catch (error) {
      if (!controller.signal.aborted) this.publish({ state: 'error', message: error.message });
    } finally {
      if (part) await rm(part, { force: true }).catch(() => {});
      this.abort = undefined;
    }
    return this.snapshot();
  }
  async shutdown() {
    this.stopping = true;
    this.abort?.abort();
    await Promise.allSettled([this.operation, this.preferenceOperation]);
  }
  async applyOnExit() {
    await this.preferenceOperation.catch(() => {});
    if (!this.pending) return;
    if (this.launchOperation) return this.launchOperation;
    this.launchOperation = this.launchHelper().finally(() => { this.launchOperation = undefined; });
    return this.launchOperation;
  }
  async launchHelper() {
    try {
      await new Promise((resolve, reject) => {
        const child = this.spawnImpl(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.pending.helper, '-Record', this.pending.record],
          // Keep CREATE_NO_WINDOW effective: DETACHED_PROCESS can make Windows
          // PowerShell exit without running the script. unref still releases Caps.
          { windowsHide: true, stdio: 'ignore', shell: false });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      this.pending = undefined;
    } catch (error) {
      const message = `Could not start the update installer: ${error.message}. Open Settings > Updates and check again to retry.`;
      this.publish({ state: 'error', message });
      await writeFile(join(this.root, 'data/updates/result.json'), JSON.stringify({ state: 'error', message }));
    }
  }
}
