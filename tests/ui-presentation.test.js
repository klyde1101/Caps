import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { captionLayout, CAPTION_FONTS } from '../src/captions/layout.js';
import { AVAILABLE_MODELS, modelCompatibility, modelLabel } from '../src/model-catalog.js';
import { modelInstalled } from '../src/desktop/renderer/generation-availability.js';

const root = new URL('../src/desktop/renderer/', import.meta.url);
const [source, html, css, tokens] = await Promise.all(
  ['app.js', 'index.html', 'workspace.css', 'tokens.css'].map((file) => readFile(new URL(file, root), 'utf8'))
);
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
function element(values = {}) {
  return { dataset: {}, attributes: {}, style: { setProperty(name, value) { this[name] = value; } },
    setAttribute(name, value) { this.attributes[name] = value; }, ...values };
}

test('orientation choices update without font controls', () => {
  assert.doesNotMatch(html, /id="caption-font-(family|size)"/);
  const radios = ['9:16', '4:5', '16:9'].map(value => element({ value }));
  const buttons = radios.map(({ value }) => element({ dataset: { orientation: value } }));
  const settings = { orientation: '9:16', fontSize: 60, fontFamily: 'proxima-nova-semibold' };
  const context = vm.createContext({ settings, captionLayout,
    document: { querySelectorAll: selector => selector.includes('input') ? radios : buttons } });
  vm.runInContext(functionSource('applyOrientation'), context);
  for (const orientation of ['9:16', '4:5', '16:9']) {
    settings.orientation = orientation;
    context.applyOrientation();
    assert.deepEqual(radios.filter(radio => radio.checked).map(radio => radio.value), [orientation]);
    assert.deepEqual(buttons.filter(button => button.attributes['aria-pressed'] === 'true').map(button => button.dataset.orientation), [orientation]);
  }
});

test('device segments mirror Automatic, CPU, CUDA and existing disabled options without changing compatibility', () => {
  const options = ['auto', 'cpu', 'cuda'].map((value) => ({ value, disabled: false }));
  const select = element({ value: 'auto', options });
  const gpu = element();
  const label = element();
  const buttons = options.map(({ value }) => element({ dataset: { device: value } }));
  let compatibilityUpdates = 0;
  const context = vm.createContext({
    $: (selector) => ({ '#setting-device': select, '#device-index-field': gpu, '#device-index-label': label, '#device-help': element({ textContent: 'Detected' }) })[selector],
    indexedDevices: new Set(['cuda']), document: { querySelectorAll: () => buttons },
    cudaDevices: () => [{ index: 0 }], environmentDiagnostics: { runtimes: { cuda: { available: true } } },
    updateModelControls: () => { compatibilityUpdates += 1; }
  });
  vm.runInContext(functionSource('updateDeviceControls'), context);
  for (const device of ['auto', 'cpu', 'cuda']) {
    select.value = device;
    context.updateDeviceControls();
    assert.equal(select.value, device);
    assert.equal(gpu.hidden, device !== 'cuda');
    assert.deepEqual(buttons.filter((button) => button.attributes['aria-pressed'] === 'true')
      .map((button) => button.dataset.device), [device]);
  }
  options[2].disabled = true;
  context.updateDeviceControls();
  assert.equal(buttons[2].disabled, true);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, false);
  assert.equal(compatibilityUpdates, 4);
});

test('Home delegates to the single Generate/footer status renderer', () => {
 let updates = 0;
 const context = vm.createContext({ updateGenerateButton: () => { updates++; } });
 vm.runInContext(functionSource('updateReadyStatus'), context);
 context.updateReadyStatus(); assert.equal(updates, 1);
});

test('restyled screens retain form controls, vector branding, unique IDs and semantic preview data', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of ['setting-device', 'setting-cuda-option', 'setting-device-index', 'setting-model',
    'select-input', 'drop-zone', 'start-job', 'restore-settings', 'save-settings']) assert.ok(ids.includes(id), id);
  assert.match(html, /src="\.\.\/\.\.\/assets\/caps-logo\.svg" alt="Caps logo"/);
  assert.doesNotMatch(html, /class="layout-preview"|class="layout-details"|You can add several files at once|>Add media<|>Caption format</);
  assert.match(html, /<button[^>]+data-device="auto"/);
  assert.equal((html.match(/class="orientation-toggle"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /id="model-status"|Install Small<\/button>/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|gradient\(|backdrop-filter:\s*blur/i);
});

test('shared text and status colors meet 4.5:1 contrast on their rendered surfaces', () => {
  const palette = Object.fromEntries([...tokens.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)]
    .map((match) => [match[1], match[2]]));
  const luminance = (hex) => {
    const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const [foreground, background] of [['text', 'bg'], ['muted', 'bg'], ['muted', 'surface'],
    ['muted', 'bar'], ['muted', 'segment-active'], ['on-accent', 'accent'],
    ['success', 'accent-tint'], ['warning', 'bg']]) {
    const a = luminance(palette[foreground]); const b = luminance(palette[background]);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}`);
  }
});

test('deleting the selected model chooses an installed fallback and persists only the resulting settings', async () => {
  const selected = { value: 'large-v3-turbo' }, status = {};
  const snapshot = { models: { 'large-v3-turbo': { state: 'idle' }, small: { state: 'installed' } } };
  let saved, applied, updates = 0;
  const context = vm.createContext({ AVAILABLE_MODELS, modelCompatibility, modelLabel, modelInstalled,
    modelInformation: () => ({modelSize:"1.62"}), confirmModelDelete: async () => true,
    NO_MODEL: 'none', savedSettings: { model: 'large-v3-turbo', device: 'cpu', fontSize: 65 }, settingsFormBase: undefined, batchRunning: false, deletingModel: false, settings: { model: 'large-v3-turbo', device: 'cpu', fontSize: 65 },
    environmentDiagnostics: { memory: { totalBytes: 32 * 1024 ** 3 }, runtimes: { cpu: { available: true } } },
    $: selector => selector === '#setting-model' ? selected : status,
    window: { caps: { deleteModel: async () => snapshot, saveSettings: async value => { saved = value; } } },
    applyDownloadSnapshot: value => { applied = value; }, updateEngineLabel() {}, showToast() {}, loadStartupDiagnostics() {},
    updateModelControls() { updates++; }, updateGenerateButton() {}, updateReadyStatus() {} });
  vm.runInContext(functionSource('requestModelDelete'), context);
  await context.requestModelDelete('large-v3-turbo');
  assert.equal(applied, snapshot); assert.equal(saved.model, 'small'); assert.equal(saved.fontSize, 65);
  assert.equal(context.settings.model, 'small'); assert.equal(selected.value, 'small');
  assert.equal(context.deletingModel, false); assert.equal(updates, 2);
});
