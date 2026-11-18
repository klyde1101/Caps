import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { convertWhisperxSrt } from '../src/pipeline.js';
import { generateCaptionBatchJob } from '../src/application/generate-caption-batch-job.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'caps-release-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function wordTimeline(words, gap = 80, duration = 220) {
  let cursor = 0;
  return words.map((word, index) => {
    const start = cursor;
    const end = start + duration;
    cursor = end + gap;
    const stamp = (value) => {
      const ms = value % 1000;
      const seconds = Math.floor(value / 1000) % 60;
      const minutes = Math.floor(value / 60000) % 60;
      const hours = Math.floor(value / 3600000);
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    return `${index + 1}\n${stamp(start)} --> ${stamp(end)}\n${word}\n`;
  }).join('\n');
}

test('desktop job output matches the deterministic pipeline byte-for-byte', async () => {
  await withTempDirectory(async (directory) => {
    const input = wordTimeline(['A', 'quick', 'release', 'comparison', 'works.']);
    const inputPath = join(directory, 'comparison.srt');
    await writeFile(inputPath, input, 'utf8');
    const expected = convertWhisperxSrt(input, 'social-media').srt;
    const result = await generateCaptionBatchJob({ inputPath, mode: 'social-media' });
    assert.equal(await readFile(result.outputPath, 'utf8'), expected);
  });
});

test('Social Media captions remain valid across fast and slow narration timelines', () => {
  const words = ['Fast', 'speech', 'still', 'needs', 'clear', 'captions,', 'while', 'pauses', 'need', 'space.'];
  for (const input of [wordTimeline(words, 25, 110), wordTimeline(words, 650, 260)]) {
    const result = convertWhisperxSrt(input, 'social-media');
    assert.equal(result.validation.valid, true);
    assert.ok(result.cues.length > 0);
    assert.ok(result.cues.every((cue) => cue.end > cue.start));
  }
});

test('release metadata configures one self-contained Windows build', async () => {
  const packageData = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageData.version, '1.0.0-beta.1');
  assert.deepEqual(packageData.build.electronLanguages, ['en-US']);
  assert.equal(packageData.build.win.target, 'portable');
  assert.equal(packageData.build.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(packageData.build.portable.requestExecutionLevel, 'user');
  assert.equal(packageData.build.portable.useZip, true);
  assert.equal(packageData.build.portable.splashImage, 'build/caps-launch-splash.bmp');
  assert.equal(packageData.build.win.artifactName, 'Caps-${version}.${ext}');
  assert.equal(packageData.build.nsis, undefined);
  assert.deepEqual(packageData.build.files, ['src/**/*', '!src/main.js', 'build/caps-icon.png', 'build/caps-icon.ico', 'package.json', 'LICENSE']);
  assert.equal(packageData.build.extraFiles, undefined);
  const icon = await readFile(join(projectRoot, 'build', 'caps-icon.ico'));
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0]);
  assert.ok(icon.length > 10000);
  const launchSplash = await readFile(join(projectRoot, 'build', 'caps-launch-splash.bmp'));
  assert.deepEqual([...launchSplash.subarray(0, 2)], [0x42, 0x4d]);
  assert.ok(launchSplash.length > 10000);
  assert.match(packageData.scripts['package:win'], /package-win\.ps1/);
  const cleanupScript = await readFile(join(projectRoot, 'scripts', 'clean-package-staging.ps1'), 'utf8');
  assert.match(cleanupScript, /win-unpacked/);
  assert.match(cleanupScript, /StartsWith\(\$distPrefix/);
});

test('first-run guidance and consolidated project documentation are present', async () => {
  const renderer = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'app.js'), 'utf8');
  const html = await readFile(join(projectRoot, 'src', 'desktop', 'renderer', 'index.html'), 'utf8');
  const readme = await readFile(join(projectRoot, 'README.md'), 'utf8');
  assert.match(html, /id="environment-banner"/);
  assert.match(renderer, /SRT conversion remains available/);
  for (const heading of ['Distribution layout', 'Development', 'Troubleshooting', 'Security', 'Release checklist', 'Version history']) {
    assert.match(readme, new RegExp(`## ${heading}`));
  }
});
