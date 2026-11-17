import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REQUIRED_RUNTIME_FILES, verifyWindowsPackage } from './verify-windows-package.mjs';

export async function launcherRuntime(file, root) {
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (bytes.subarray(0, 2).toString() !== 'MZ') return null;
  // The launcher embeds Caps.AppDirectory as a UTF-8 manifest resource.
  const names = [...new Set(bytes.toString('latin1').match(/dist[\\/]app-[a-f0-9]{24}|dist[\\/]win-unpacked/g) ?? [])];
  if (names.length > 1) throw Error(`Ambiguous launcher runtime: ${file}`);
  return names.length ? resolve(root, names[0].replaceAll('\\', '/')) : null;
}

async function portableExecutable(file) {
  const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return Boolean(bytes && bytes.subarray(0, 2).toString() === 'MZ' &&
    bytes.subarray(0, 1024 * 1024).includes(Buffer.from('NullsoftInst')));
}

async function inspectTree(path, root, recursive = true) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Error(`Unsafe cleanup path: ${path}`);
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return 0;
    if (info.isSymbolicLink()) throw Error(`Refusing linked cleanup path: ${cursor}`);
  }
  async function visit(directory) {
    let bytes = 0;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isSymbolicLink()) throw Error(`Refusing linked cleanup entry: ${file}`);
      if (item.isDirectory()) bytes += await visit(file);
      else bytes += (await stat(file)).size;
    }
    return bytes;
  }
  const info = await lstat(path);
  return info.isDirectory() ? recursive ? visit(path) : 0 : info.size;
}

async function completeRuntime(path, root) {
  await inspectTree(path, root, false);
  for (const name of ['Caps.exe', ...REQUIRED_RUNTIME_FILES, 'resources/app.asar']) {
    const file = join(path, name);
    await inspectTree(file, root, false);
    if (!(await stat(file).catch(() => null))?.isFile() || (await stat(file)).size === 0)
      throw Error(`Refusing cleanup: retained runtime is incomplete: ${file}`);
  }
}

export async function runtimeInUse(path) {
  if (process.platform !== 'win32') return false;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; foreach ($file in Get-ChildItem -LiteralPath $env:CAPS_CLEANUP_BUILD_PATH -File -Recurse) { try { $handle = [System.IO.File]::Open($file.FullName, 'Open', 'Read', 'None'); $handle.Dispose() } catch [System.IO.IOException] { Write-Output 'busy'; exit 0 } }; Write-Output 'idle'"],
  { windowsHide: true, timeout: 15000, env: { ...process.env, CAPS_CLEANUP_BUILD_PATH: path } });
  if (stdout.trim() === 'busy') return true;
  if (stdout.trim() !== 'idle') throw Error('Could not determine whether an older build is in use.');
  return false;
}

export async function cleanProject({ root, apply = false, stagingRoot, publishedRuntime,
  verify = verifyWindowsPackage, inUse = runtimeInUse, onProgress = () => {} }) {
  root = resolve(root);
  if ((await lstat(root)).isSymbolicLink()) throw Error('Refusing a linked project root.');
  const current = await launcherRuntime(join(root, 'Caps.exe'), root);
  const portable = !current && await portableExecutable(join(root, 'Caps.exe'));
  if (!current && !(portable && publishedRuntime)) throw Error('Cleanup requires a verified published Caps build.');
  const verifiedRuntime = current ?? resolve(publishedRuntime);
  await completeRuntime(verifiedRuntime, root);
  await verify({ unpackedRoot: verifiedRuntime, electronRoot: join(root, 'node_modules/electron/dist'), projectRoot: root,
    ...(portable ? { artifactPath: join(root, 'Caps.exe') } : {}) });

  const keep = new Set([current, verifiedRuntime].filter(Boolean));
  // Windows can lock only some files in a running build. Preserve its entire
  // directory before deletion begins, rather than discovering the lock midway.
  const retainedRunning = [];
  const dist = join(root, 'dist');
  await inspectTree(dist, root, false);
  const unusedBuilds = (await readdir(dist, { withFileTypes: true }))
    .filter(item => item.isDirectory() && /^(app-[a-f0-9]{24}|win-unpacked|\.previous-[a-f0-9]{32})$/.test(item.name))
    .map(item => join(dist, item.name)).filter(path => !keep.has(path));
  const oldBuilds = [];
  for (const path of unusedBuilds) {
    if (await inUse(path)) { retainedRunning.push(path); onProgress(`Preserving in-use build ${relative(root, path)}`); }
    else oldBuilds.push(path);
  }
  const candidates = [...oldBuilds, join(root, 'Caps-rollback.exe'),
    ...['runtime-verification', 'uv-cache', 'electron-probe-runtime'].map(name => join(root, 'data', name))];
  const targets = [];
  for (const path of candidates) {
    if (path === stagingRoot) continue;
    onProgress(`Checking ${relative(root, path)}`);
    const bytes = await inspectTree(path, root);
    if (await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) targets.push({ path, bytes });
  }
  // Validate the complete plan before the first deletion. Never follow junctions.
  const report = { applied: apply, current: current ?? join(root, 'Caps.exe'), retainedRunning, targets,
    removedBytes: targets.reduce((sum, target) => sum + target.bytes, 0) };
  if (apply) {
    for (const { path } of targets) {
      onProgress(`Removing ${relative(root, path)}`);
      await rm(path, { recursive: true, force: true });
    }
    const logs = join(root, 'data/logs');
    await inspectTree(logs, root, false);
    await mkdir(logs, { recursive: true });
    const reportPath = join(logs, 'project-cleanup.json');
    await inspectTree(reportPath, root, false);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  try {
    const report = await cleanProject({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      apply: args.includes('--apply'), stagingRoot: value('--staging-root'),
      publishedRuntime: value('--published-runtime'),
      onProgress: message => console.log(message) });
    console.log(`${report.applied ? 'Removed' : 'Can remove'} ${(report.removedBytes / 1024 ** 3).toFixed(2)} GiB; retained current build and any in-use builds.`);
  } catch (error) { console.error(`Project cleanup stopped: ${error.message}`); process.exitCode = 1; }
}
