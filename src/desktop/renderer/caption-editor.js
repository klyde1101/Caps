import { exportSrt } from '../../exporters/srt.js';
import { createPlaybackFollower } from './playback-follow.js';
import { reviewDecision } from './review-dialog.js';

export function createCaptionEditor(refresh, followPage = () => {}) {
  const $ = (selector) => document.querySelector(selector);
  const video = $('#caption-video');
  const overlay = $('#video-caption');
  const save = $('#save-captions');
  const status = $('#editor-status');
  const sessions = new Map();
  let active;
  let epoch = 0;
  let saving = false;
  let currentResult;
  let proxyAttempted = false;
  let selectedIndex;
  let savedTimer;
  const follower = createPlaybackFollower($('.preview .table-wrap'));
  let requestedPage;
  for (const id of ['#preview-prev', '#preview-next']) $(id)?.addEventListener('click', follower.pause);
  $('#reload-captions').addEventListener('click', async () => {
    if (!currentResult || saving) return;
    if (active.changes.size && await reviewDecision({ title: 'Discard your changes?', message: 'This restores the captions from the saved file.', choices: [['discard', 'Discard'], ['cancel', 'Keep editing']] }) !== 'discard') return;
    sessions.delete(currentResult.previewToken);
    await editor.open(currentResult);
    refresh();
  });

  function feedback() {
    save.disabled = saving || !active?.loaded || !active.changes.size;
    status.dataset.state = saving ? 'saving' : !active?.loaded ? 'loading' : active.changes.size ? 'unsaved' : 'saved';
    save.querySelector('[data-save-label]').textContent = saving ? 'Saving…' : 'Save changes';
    save.dataset.tooltip = save.disabled && !saving ? 'No changes to save' : 'Save changes (Ctrl+S)';
    $('#reload-captions').hidden = !active?.changes.size;
    status.textContent = saving ? 'Saving corrections…' : !active?.loaded ? 'Loading captions…'
      : active.changes.size ? `${active.changes.size} unsaved ${active.changes.size === 1 ? 'change' : 'changes'}` : active.saveWarning || 'All changes saved';
  }

  function selectRow(index, { seek = false, focus = false } = {}) {
    selectedIndex = index;
    for (const row of document.querySelectorAll('#preview-body tr[data-cue]')) {
      const selected = Number(row.dataset.cue) === index;
      row.classList.toggle('cue-selected', selected); row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
      const input = row.querySelector('textarea');
      if (input) { input.readOnly = !selected; input.tabIndex = selected ? 0 : -1; }
      if (selected && focus) row.focus({ preventScroll: true });
    }
    if (seek && currentResult?.mediaUrl) { const cue = active?.cues.find(cue => cue.index === index); if (cue) video.currentTime = cue.start / 1000; }
  }

  function playingCue() {
    const time = video.currentTime * 1000;
    const cues = active?.cues ?? [];
    // Binary search keeps playback responsive for long transcripts.
    let low = 0, high = cues.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (cues[mid].start <= time) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    const cue = cues[found];
    return cue && time < cue.end ? cue : null;
  }

  function sync() {
    const current = playingCue();
    overlay.textContent = current ? active.changes.get(current.index) ?? current.text : '';
    let currentRow;
    for (const row of document.querySelectorAll('#preview-body tr')) {
      const playing = Number(row.dataset.cue) === current?.index;
      row.classList.toggle('cue-playing', playing);
      if (playing) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
      if (Number(row.dataset.cue) === current?.index) currentRow = row;
    }
    const editing = document.activeElement?.closest?.('textarea, input, [contenteditable="true"]');
    if (current && !video.paused && !editing && follower.allowed()) {
      if (currentRow) { requestedPage = undefined; selectRow(current.index); follower.follow(currentRow); }
      else if (requestedPage !== current.index) { requestedPage = current.index; followPage(current.index); }
    }
  }

  video.addEventListener('timeupdate', sync);
  video.addEventListener('seeked', sync);
  video.addEventListener('play', sync);
  window.caps.onMediaPreviewProgress?.(progress => {
    if (progress.previewToken !== currentResult?.previewToken) return;
    $('#media-status').hidden = false;
    $('#media-status').textContent = `Creating compatible preview${Number.isFinite(progress.percent) ? ': ' + Math.floor(progress.percent) + '%' : '…'}`;
  });
  video.addEventListener('error', async () => {
    if (!currentResult?.mediaUrl || proxyAttempted) return;
    proxyAttempted = true;
    $('#media-status').hidden = false;
    const token = epoch, result = currentResult;
    $('#media-status').textContent = 'This codec cannot play here. Creating an H.264/AAC preview…';
    try {
      if (!window.caps.createMediaPreview) throw Error('Compatible preview is unavailable.');
      const url = await window.caps.createMediaPreview(result.previewToken);
      if (token !== epoch) return;
      video.src = url; video.load();
      $('#media-status').textContent = 'Compatible preview ready';
    } catch (error) { if (token === epoch) $('#media-status').textContent = `${error.message} Caption editing is still available.`; }
  });
  async function saveCorrections() {
    const session = active;
    if (!session?.loaded || saving || !session.changes.size) return;
    saving = true; feedback();
    const changes = [...session.changes].map(([index, text]) => ({ index, text }));
    try {
      const result = await window.caps.saveCaptions({ previewToken: session.token, original: session.original, changes });
      session.original = result.original;
      session.saveWarning = result.warning;
      for (const change of changes) {
        session.cues[change.index - 1].text = change.text.trim().replace(/\r\n?/g, '\n');
        // Edits made while saving remain unsaved.
        if (session.changes.get(change.index) === change.text) session.changes.delete(change.index);
      }
      if (active === session) { refresh(); sync(); }
    } catch (error) {
      if (active === session) { status.dataset.state = 'error'; status.textContent = `Could not save: ${error.message}`; }
      saving = false;
      save.querySelector('[data-save-label]').textContent = 'Retry save';
      save.disabled = false;
      return;
    }
    saving = false; feedback();
    if (!active?.changes.size && !active?.saveWarning) { status.textContent = 'Saved'; clearTimeout(savedTimer); savedTimer = setTimeout(feedback, 1800); }
  }
  save.addEventListener('click', saveCorrections);
  document.addEventListener('keydown', event => {
    if ($('#completed-view').hidden || document.body.classList.contains('settings-open') || document.querySelector('dialog[open]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveCorrections(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); $('#preview-search').focus(); }
  });

  window.addEventListener('beforeunload', (event) => {
    if (saving || [...sessions.values()].some((session) => session.changes.size)) {
      event.preventDefault(); event.returnValue = '';
    }
  });

  const editor = {
    async open(result) {
      currentResult = result;
      selectedIndex = undefined;
      const token = ++epoch;
      proxyAttempted = false;
      video.pause();
      follower.resume(); requestedPage = undefined;
      overlay.textContent = '';
      let session = sessions.get(result.previewToken);
      if (!session) {
        session = { token: result.previewToken, cues: [], changes: new Map(), loaded: false };
        sessions.set(result.previewToken, session);
      }
      active = session;
      video.removeAttribute('src');
      if (result.mediaUrl) video.src = result.mediaUrl;
      $('.playback-panel').classList.toggle('subtitle-only', !result.mediaUrl);
      const audio = result.mediaKind === 'audio';
      $('#caption-player').classList.toggle('audio-only', audio);
      $('#audio-placeholder').hidden = !audio;
      video.load();
      $('#media-status').textContent = '';
      $('#media-status').hidden = true;
      feedback();
      if (session.loaded) return;
      try {
        const cues = [];
        let page;
        do {
          page = await window.caps.getPreview({ previewToken: session.token, offset: cues.length, limit: 200 });
          if (token !== epoch) return;
          cues.push(...page.cues);
        } while (cues.length < page.total && page.cues.length);
        session.cues = cues;
        session.original = exportSrt(cues);
        session.loaded = true;
        feedback(); sync();
      } catch (error) {
        if (token === epoch) status.textContent = `Could not load editor: ${error.message}`;
      }
    },

    decorate(row, cue, result) {
      const session = sessions.get(result.previewToken);
      if (!session) return;
      row.dataset.cue = cue.index;
      for (const [column, field] of [[1, 'start'], [2, 'end']]) {
        const timeCell = row.children[column];
        const seek = document.createElement('button');
        seek.type = 'button'; seek.className = 'cue-seek';
        seek.textContent = `${Math.floor(cue[field] / 60000)}:${String(Math.floor(cue[field] / 1000) % 60).padStart(2, '0')}.${String(cue[field] % 1000).padStart(3, '0')}`;
        seek.setAttribute('aria-label', `Seek to ${field} of caption ${cue.index}: ${timeCell.textContent}`);
        seek.disabled = !result.mediaUrl;
        seek.addEventListener('click', () => { selectRow(cue.index); follower.resume(); video.currentTime = cue[field] / 1000; sync(); });
        timeCell.replaceChildren(seek);
      }
      const input = document.createElement('textarea');
      input.rows = 1; input.className = 'caption-text'; input.maxLength = 10000;
      input.setAttribute('aria-label', `Caption ${cue.index}`);
      input.value = session.changes.get(cue.index) ?? cue.text;
      input.readOnly = selectedIndex !== cue.index; input.tabIndex = selectedIndex === cue.index ? 0 : -1;
      row.classList.toggle('cue-selected', selectedIndex === cue.index);
      row.setAttribute('aria-selected', String(selectedIndex === cue.index)); row.tabIndex = selectedIndex === cue.index ? 0 : -1;
      row.addEventListener('click', event => { if (event.target.closest('.cue-seek')) return; selectRow(cue.index, { seek: true }); if (event.target === input) input.focus(); });
      row.addEventListener('keydown', event => {
        if (event.target === input && event.key !== 'Escape') return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); row.focus(); }
        if (event.key === 'Enter') { event.preventDefault(); input.focus(); }
        if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const rows = [...$('#preview-body').querySelectorAll('tr[data-cue]')];
          const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
          if (next) { selectRow(Number(next.dataset.cue), { seek: true, focus: true }); next.scrollIntoView({ block: 'nearest' }); }
        }
      });
      input.addEventListener('input', () => {
        input.style.height = '0px';
        const border = getComputedStyle(input);
        input.style.height = `${input.scrollHeight + parseFloat(border.borderTopWidth) + parseFloat(border.borderBottomWidth)}px`;
        const original = session.cues[cue.index - 1]?.text ?? cue.text;
        if (input.value === original) session.changes.delete(cue.index);
        else session.changes.set(cue.index, input.value);
        row.classList.toggle('cue-edited', session.changes.has(cue.index));
        feedback(); sync();
      });
      row.classList.toggle('cue-edited', session.changes.has(cue.index));
      row.lastElementChild.replaceChildren(input);
      row.classList.toggle('cue-playing', cue.index === playingCue()?.index);
    },

    syncPlayback: sync,
    async reset() {
      if (saving) { status.textContent = 'Wait for the save to finish.'; return false; }
      if ([...sessions.values()].some((session) => session.changes.size)) {
        const choice = await reviewDecision({ title: 'Save your changes?', message: 'Save your caption edits before adding another video.', choices: [['save', 'Save'], ['discard', "Don't save"], ['cancel', 'Cancel']] });
        if (choice === 'cancel') return false;
        if (choice === 'save') { await saveCorrections(); if ([...sessions.values()].some(session => session.changes.size)) return false; }
      }
      ++epoch; sessions.clear(); active = undefined;
      video.pause(); video.removeAttribute('src'); video.load(); overlay.textContent = '';
      return true;
    }
  };
  return editor;
}
