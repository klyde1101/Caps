import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { validateSettings } from './ipc-contract.js';
import { DEFAULT_ORIENTATION, DEFAULT_FONT_SIZE, DEFAULT_CAPTION_FONT } from '../captions/layout.js';
import { DEFAULT_MODEL, NO_MODEL, isSupportedModel } from '../model-catalog.js';

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'social-media',
  orientation: DEFAULT_ORIENTATION,
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_CAPTION_FONT,
  language: 'en',
  model: DEFAULT_MODEL,
  whisperxPath: '',
  device: 'auto',
  deviceIndex: 0,
  computeType: 'default',
  outputBehavior: 'beside-input',
  timing: { minDurationMs: 100, bridgeGapMs: 80 }
});

function normalizeSettings(value) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...value,
    timing: { ...DEFAULT_SETTINGS.timing, ...value.timing },
    fontSize: DEFAULT_FONT_SIZE,
    fontFamily: DEFAULT_CAPTION_FONT,
    language: DEFAULT_SETTINGS.language,
    whisperxPath: DEFAULT_SETTINGS.whisperxPath,
    computeType: DEFAULT_SETTINGS.computeType,
    outputBehavior: DEFAULT_SETTINGS.outputBehavior
  };
  if (settings.model === 'large-v3') settings.model = 'large-v3-turbo';
  settings.model = isSupportedModel(settings.model) || settings.model === NO_MODEL ? settings.model : DEFAULT_SETTINGS.model;
  settings.mode = 'social-media';
  return settings;
}

export function createSettingsStore(userDataPath) {
  const settingsPath = join(userDataPath, 'settings.json');
  return {
    async read() {
      try {
        const stored = JSON.parse(await readFile(settingsPath, 'utf8'));
        const { dynamic, standard, smartMode, ...migrated } = stored;
        if (['dynamic', 'words', 'standard'].includes(migrated.mode)) migrated.mode = 'social-media';
        return structuredClone(normalizeSettings(validateSettings(migrated)));
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError || error.code === 'INVALID_REQUEST') return structuredClone(DEFAULT_SETTINGS);
        throw error;
      }
    },
    async save(value) {
      const settings = normalizeSettings(validateSettings(value));
      await mkdir(dirname(settingsPath), { recursive: true });
      const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        await rename(temporaryPath, settingsPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
      return settings;
    }
  };
}
