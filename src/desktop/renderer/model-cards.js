export function mountModelCards(models, { host, template, createIcon, onInstall, onCancel, onDelete }) {
  const cards = new Map();
  for (const model of models) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.model = model.id;
    card.setAttribute('aria-label', model.label);
    const radio = card.querySelector('input'); radio.value = model.id; radio.id = `model-${model.id}`;
    card.querySelector('label').htmlFor = radio.id;
    card.querySelector('[data-name]').textContent = model.label;
    card.querySelector('[data-use]').addEventListener('click', () => radio.click());
    card.addEventListener('click', event => {
      if (!event.target.closest('button, input, label')) radio.click();
    });
    card.querySelector('[data-delete]').addEventListener('click', () => onDelete(model.id));
    card.querySelector('[data-delete]').setAttribute('aria-label', 'Delete model');
    card.querySelector('[data-delete]').title = `Delete ${model.label}… Opens confirmation`;
    card.querySelector('[data-install]').addEventListener('click', () => onInstall(model.id));
    card.querySelector('[data-retry]').addEventListener('click', () => onInstall(model.id));
    card.querySelector('[data-cancel]').addEventListener('click', () => onCancel(model.id));
    card.querySelector('[role="progressbar"]').setAttribute('aria-label', `${model.label} download progress`);
    cards.set(model.id, card); host.append(card);
  }
  return cards;
}

export function renderModelDownload(card, download, { installed, busy, jobRunning, createIcon, formatBytes, formatTime }) {
  const state = installed ? 'installed' : download?.state ?? 'idle';
  const active = ['preparing', 'downloading', 'verifying'].includes(state);
  const percent = Math.max(0, Math.min(100, download?.percent ?? 0));
  const status = card.querySelector('.model-choice-status');
  status.dataset.state = installed ? 'installed' : active ? 'downloading' : 'missing';
  const label = installed ? 'Installed' : active ? `${Math.round(percent)}%` : state === 'failed' ? 'Failed' : 'Download';
  card.dataset.downloadState = active ? 'downloading' : state;
  status.hidden = !installed && !active;
  status.replaceChildren(...(installed ? [createIcon('check')] : []), document.createTextNode(label));
  card.querySelector('[data-delete]').hidden = !installed;
  card.querySelector('[data-delete]').disabled = busy || jobRunning;
  card.querySelector('[data-use]').hidden = !installed || card.querySelector('input').checked;
  for (const [selector, visible] of [['[data-install]', !installed && !active && state !== 'failed'],
    ['[data-retry]', state === 'failed'], ['[data-transfer]', active], ['[data-error]', state === 'failed']]) {
    card.querySelector(selector).hidden = !visible;
  }
  card.querySelector('[data-install]').disabled = busy;
  card.querySelector('[data-retry]').disabled = busy;
  const progress = card.querySelector('[role="progressbar"]');
  progress.setAttribute('aria-valuenow', String(percent));
  // A native progress element draws deterministically without animation/shimmer.
  progress.value = percent;
  const count = download?.totalBytes ? `${formatBytes(download.bytes ?? 0)} of ${formatBytes(download.totalBytes)}` : 'Checking download size';
  const timing = download?.speed > 0 ? `${formatBytes(download.speed)}/s \u00b7 ${formatTime(download.eta)}` : state === 'verifying' ? 'Verifying'
    : state === 'downloading' && download.totalBytes > 0 && download.bytes >= download.totalBytes ? 'Finishing speech setup'
    : state === 'downloading' ? 'Waiting for data' : 'Preparing';
  card.querySelector('[data-bytes]').textContent = count;
  card.querySelector('[data-rate]').textContent = timing;
  progress.setAttribute('aria-valuetext', `${percent}%, ${count}, ${timing}`);
  const error = card.querySelector('[data-error]');
  error.replaceChildren(createIcon('warning'), document.createTextNode('Download failed'));
  // Keep focus usable when the just-pressed Install/Retry control becomes hidden.
  if (card.contains(document.activeElement) && document.activeElement.closest('[hidden]')) {
    const next = active ? card.querySelector('[data-cancel]') : state === 'failed' ? card.querySelector('[data-retry]') : card.querySelector('input');
    next.focus({ preventScroll: true });
  }
  return { state, label, percent };
}
