export function createSettingsNavigation(root, { onDiagnostics = () => {} } = {}) {
  const tabs = [...root.querySelectorAll('[data-settings-page]')];
  const panes = [...root.querySelectorAll('[data-settings-pane]')];
  let active = 'general';
  function open(name, trigger) {
    if (!panes.some(pane => pane.dataset.settingsPane === name)) return;
    active = name;
    for (const tab of tabs) {
      const selected = tab.dataset.settingsPage === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      tab.classList?.add('settings-nav-item');
      tab.classList?.toggle('active', selected);
      if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute?.('aria-current');
    }
    for (const pane of panes) pane.hidden = pane.dataset.settingsPane !== name;
    const pane = panes.find(item => !item.hidden); pane.scrollTop = 0;
    if (trigger && !tabs.includes(trigger)) pane.querySelector('h3')?.focus({ preventScroll: true });
    if (name === 'diagnostics') onDiagnostics();
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => open(tab.dataset.settingsPage));
    tab.addEventListener('keydown', event => {
      const offsets = { ArrowDown: 1, ArrowUp: -1, Home: -index, End: tabs.length - 1 - index };
      if (!(event.key in offsets)) return;
      event.preventDefault();
      const next = tabs[(index + offsets[event.key] + tabs.length) % tabs.length];
      next.focus(); open(next.dataset.settingsPage);
    });
  }
  open('general');
  return { open, close: () => open('general'), get active() { return active; } };
}
