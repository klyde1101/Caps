export function createSettingsPopups({ settings, scrim, panels, onDiagnostics = () => {} }) {
  let active = null; let opener = null;
  const visibleControls = (panel) => [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
  function close() {
    if (!active) return;
    active.hidden = true; scrim.hidden = true; active = null;
    settings.inert = false; settings.setAttribute('aria-modal', 'true');
    const target = opener?.isConnected ? opener : settings.querySelector('#settings-close');
    opener = null; target?.focus({ preventScroll: true });
  }
  function open(name, trigger) {
    if (active) close();
    const panel = panels[name]; if (!panel) return;
    opener = trigger; active = panel;
    settings.inert = true; settings.setAttribute('aria-modal', 'false');
    scrim.hidden = false; panel.hidden = false;
    panel.querySelector('.popup-close').focus({ preventScroll: true });
    if (name === 'diagnostics') onDiagnostics();
  }
  for (const panel of Object.values(panels)) {
    for (const button of panel.querySelectorAll('[data-popup-close]')) button.addEventListener('click', close);
  }
  scrim.addEventListener('click', close);
  // Capture prevents Settings' Escape handler from also dismissing its parent dialog.
  const onKey = (event) => {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    event.stopImmediatePropagation();
    const controls = visibleControls(active); const first = controls[0]; const last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (!active.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  window.addEventListener('keydown', onKey, true);
  return { open, close, get active() { return active; } };
}
