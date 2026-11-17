export function createPlaybackFollower(pane, { now = () => performance.now(), holdMs = 4000 } = {}) {
  let manualUntil = 0, automaticUntil = 0;
  const pause = () => { manualUntil = now() + holdMs; };
  for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown']) pane?.addEventListener(event, pause, { passive: true });
  pane?.addEventListener('scroll', () => { if (now() > automaticUntil) pause(); }, { passive: true });
  const allowed = () => now() >= manualUntil;
  return {
    pause, allowed,
    resume() { manualUntil = 0; },
    follow(row) {
      if (!pane || !row || !allowed()) return;
      const area = pane.getBoundingClientRect(), bounds = row.getBoundingClientRect();
      const header = pane.querySelector('thead')?.getBoundingClientRect().height ?? 0;
      if (bounds.top >= area.top + header && bounds.bottom <= area.bottom) return;
      automaticUntil = now() + 700;
      pane.scrollTo({ top: Math.max(0, pane.scrollTop + bounds.top - area.top - header - 8), behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
    }
  };
}
