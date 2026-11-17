export function parsePlayerTime(value) {
  const match = /^(\d+(?::\d{1,2}){0,2})(?:[,.](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const parts = match[1].split(':').map(Number);
  if (parts.length > 1 && parts.at(-1) >= 60 || parts.length === 3 && parts[1] >= 60) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0) + Number('0.' + (match[2] ?? '0'));
  return Number.isFinite(seconds) ? seconds : null;
}

export function formatPlayerTime(seconds, milliseconds = false) {
  let value = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const ms = value % 1000; value = Math.floor(value / 1000);
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}${milliseconds ? ',' + String(ms).padStart(3, '0') : ''}`;
}

export function formatReviewTime(seconds) {
  const tenths = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 10));
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

export function playerShortcutAllowed(target, root, document) {
  const control = target?.closest('button, a, summary');
  return !root.closest('[hidden]') && !document.body.classList.contains('settings-open')
    && !document.querySelector('dialog[open], [role="dialog"]:not(dialog):not([hidden])')
    && !document.querySelector('#player-shortcuts:popover-open')
    && !target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
    && (!control || root.contains?.(control));
}

const paths = {
  play: 'm9 5 11 7-11 7Z', pause: 'M8 5v14M16 5v14', back: 'M5 8a9 9 0 1 1-1 8M5 3v5h5',
  forward: 'M19 8a9 9 0 1 0 1 8M19 3v5h-5', volume: 'M11 4 6 8H2v8h4l5 4ZM15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16',
  muted: 'M11 4 6 8H2v8h4l5 4ZM16 9l6 6m-6 0 6-6', fullscreen: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',
  exit: 'M9 3v6H3M21 9h-6V3M15 21v-6h6M3 15h6v6', speed: 'M4 19a10 10 0 1 1 16 0M12 13l5-5M5 13h2m10 0h2M12 3v3'
};

export function mountPlayerControls(root) {
  const document = root.ownerDocument;
  const $ = selector => root.querySelector(selector);
  const video = $('video'), seek = $('#player-seek'), current = $('#player-current');
  const volume = $('#player-volume'), speed = $('#player-speed-button'), menu = $('#player-speed-menu');
  const preview = $('#player-seek-preview'), feedback = $('#player-feedback');
  const shortcuts = $('#player-shortcuts'), shortcutsButton = $('#player-shortcuts-button');
  shortcuts?.addEventListener('toggle', () => {
    if (!shortcuts.matches(':popover-open')) return;
    const button = shortcutsButton.getBoundingClientRect(), panel = shortcuts.getBoundingClientRect();
    shortcuts.style.left = `${Math.max(16, Math.min(document.defaultView.innerWidth - panel.width - 16, button.right + 8))}px`;
    shortcuts.style.top = `${Math.max(16, button.top - panel.height - 8)}px`;
    shortcuts.style.right = 'auto'; shortcuts.style.bottom = 'auto';
  });
  const buttons = Object.fromEntries([...root.querySelectorAll('[data-player]')].map(button => [button.dataset.player, button]));
  let editing = false, errorTimer;
  function icon(button, name) {
    let svg = button.querySelector('svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'path')); button.append(svg);
    }
    svg.firstElementChild.setAttribute('d', paths[name]);
  }
  const ready = () => Number.isFinite(video.duration) && video.duration > 0 && !video.error;
  const clamp = seconds => Math.max(0, Math.min(video.duration, seconds));
  function update() {
    const available = ready();
    for (const element of root.querySelectorAll('button, input, select')) if (element.id !== 'player-shortcuts-button') element.disabled = !available;
    buttons.fullscreen.disabled = !available || typeof root.requestFullscreen !== 'function';
    seek.max = available ? String(video.duration) : '0';
    seek.value = String(available ? clamp(video.currentTime) : 0);
    seek.setAttribute('aria-valuetext', `${formatPlayerTime(video.currentTime)} of ${formatPlayerTime(video.duration)}`);
    if (!editing) current.value = formatReviewTime(video.currentTime);
    $('#player-duration').textContent = formatReviewTime(video.duration);
    volume.value = String(video.muted ? 0 : video.volume);
    speed.dataset.tooltip = 'Playback speed: ' + video.playbackRate + '×';
    speed.setAttribute('aria-label', 'Playback speed: ' + video.playbackRate + '×');
    root.style.setProperty('--seek-fill', `${available ? video.currentTime / video.duration * 100 : 0}%`);
    for (const option of menu.querySelectorAll('[data-speed]')) option.setAttribute('aria-checked', String(Number(option.dataset.speed) === video.playbackRate));
    buttons.play.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    buttons.mute.setAttribute('aria-label', 'Volume');
    buttons.mute.setAttribute('aria-pressed', String(video.muted || video.volume === 0));
    const fullscreen = document.fullscreenElement === root;
    buttons.fullscreen.setAttribute('aria-label', fullscreen ? 'Exit full screen' : 'Full screen');
    icon(buttons.play, video.paused ? 'play' : 'pause');
    icon(buttons.mute, video.muted || video.volume === 0 ? 'muted' : 'volume');
    icon(buttons.fullscreen, fullscreen ? 'exit' : 'fullscreen');
    buttons.play.dataset.tooltip = (video.paused ? 'Play' : 'Pause') + ' (Space)';
    buttons.back.dataset.tooltip = 'Back 5 seconds (←)'; buttons.forward.dataset.tooltip = 'Forward 5 seconds (→)';
    buttons.mute.dataset.tooltip = 'Volume (M to mute)'; buttons.fullscreen.dataset.tooltip = 'Full screen (F)';
    for (const [name, label, key] of [['play', 'Space', 'Space'], ['back', '←', 'ArrowLeft'], ['forward', '→', 'ArrowRight'], ['mute', 'M', 'm'], ['fullscreen', 'F', 'f']]) {
      buttons[name].dataset.shortcut = label; buttons[name].setAttribute('aria-keyshortcuts', key);
    }
  }
  const move = seconds => { if (ready()) { video.currentTime = clamp(seconds); update(); } };
  async function toggle() {
    if (!ready()) return;
    try { if (video.paused) await video.play(); else video.pause(); }
    catch { feedback.textContent = 'Playback unavailable. Caption editing is still available.'; }
    update();
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else if (ready()) await root.requestFullscreen();
    } catch { feedback.textContent = 'Fullscreen is unavailable.'; }
  }
  icon(buttons.back, 'back'); icon(buttons.forward, 'forward');
  speed.textContent = ''; icon(speed, 'speed');
  for (const button of [buttons.back, buttons.forward]) { const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', '12'); label.setAttribute('y', '17'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('stroke', 'none'); label.setAttribute('fill', 'currentColor'); label.textContent = '5'; button.querySelector('svg').append(label); }
  buttons.play.addEventListener('click', toggle);
  video.addEventListener('click', () => { root.focus({ preventScroll: true }); void toggle(); });
  buttons.back.addEventListener('click', () => move(video.currentTime - 5));
  buttons.forward.addEventListener('click', () => move(video.currentTime + 5));
  buttons.fullscreen.addEventListener('click', fullscreen);
  const mute = () => { if (video.volume === 0) { video.volume = 1; video.muted = false; } else video.muted = !video.muted; update(); };
  buttons.mute.addEventListener('click', mute);
  seek.addEventListener('input', () => move(Number(seek.value)));
  seek.addEventListener('pointermove', event => {
    if (!ready()) return;
    const rect = seek.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    preview.textContent = formatReviewTime(fraction * video.duration);
    preview.hidden = false;
    const half = preview.getBoundingClientRect().width / 2;
    preview.style.left = `${Math.max(half, Math.min(rect.width - half, fraction * rect.width))}px`;
  });
  seek.addEventListener('pointerleave', () => { preview.hidden = true; });
  volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; update(); });
  const closeSpeed = () => { menu.hidden = true; speed.setAttribute('aria-expanded', 'false'); };
  speed.addEventListener('click', () => { menu.hidden = !menu.hidden; speed.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('[aria-checked="true"]').focus(); });
  for (const option of menu.querySelectorAll('[data-speed]')) option.addEventListener('click', () => { video.playbackRate = Number(option.dataset.speed); closeSpeed(); speed.focus(); update(); });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSpeed(); speed.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const options = [...menu.querySelectorAll('button')], n = options.indexOf(document.activeElement); options[(n + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus(); }
  });
  document.addEventListener('pointerdown', event => { if (!speed.contains(event.target) && !menu.contains(event.target)) closeSpeed(); });
  let idleTimer;
  const wake = () => { root.classList.remove('controls-idle'); clearTimeout(idleTimer); if (document.fullscreenElement === root && !video.paused) idleTimer = setTimeout(() => { if (!root.querySelector('.player-controls:focus-within')) root.classList.add('controls-idle'); }, 2500); };
  for (const name of ['pointermove', 'pointerdown', 'keydown', 'focusin']) root.addEventListener(name, wake);
  video.addEventListener('play', wake); video.addEventListener('pause', wake); document.addEventListener('fullscreenchange', wake);
  current.addEventListener('focus', () => { editing = true; current.select(); });
  current.addEventListener('blur', () => { editing = false; update(); });
  current.addEventListener('input', () => { current.removeAttribute('aria-invalid'); });
  current.addEventListener('keydown', event => {
    if (!['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') {
      const seconds = parsePlayerTime(current.value);
      if (seconds === null) {
        current.setAttribute('aria-invalid', 'true');
        feedback.textContent = 'Invalid time. Use seconds, MM:SS or HH:MM:SS,mmm.';
        clearTimeout(errorTimer); errorTimer = setTimeout(() => current.removeAttribute('aria-invalid'), 2200);
      } else { current.removeAttribute('aria-invalid'); move(seconds); feedback.textContent = `Seeked to ${formatPlayerTime(video.currentTime, true)}`; }
    }
    editing = false; current.blur(); update(); root.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('#player-shortcuts:popover-open')) return;
    if (!event.defaultPrevented && event.key === 'Escape' && document.fullscreenElement === root) {
      event.preventDefault(); void document.exitFullscreen(); return;
    }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !ready()
      || !playerShortcutAllowed(event.target, root, document)) return;
    const key = event.key.toLowerCase();
    // Let a focused toolbar button handle Space as a normal button activation.
    if (key === ' ' && event.target?.closest('button')) return;
    if (![' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f', 'home', 'end'].includes(key)) return;
    event.preventDefault();
    if (key === ' ') { if (!event.repeat) void toggle(); }
    else if (key === 'arrowleft' || key === 'arrowright') move(video.currentTime + (key === 'arrowleft' ? -5 : 5));
    else if (key === 'm') mute();
    else if (key === 'f') void fullscreen();
    else if (key === 'home' || key === 'end') move(key === 'home' ? 0 : video.duration);
    else { video.volume = Math.max(0, Math.min(1, video.volume + (key === 'arrowup' ? .05 : -.05))); video.muted = false; update(); }
  });
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'volumechange', 'ratechange', 'emptied', 'error'])
    video.addEventListener(event, update);
  document.addEventListener('fullscreenchange', update);
  update();
  return { update, seek: move };
}
