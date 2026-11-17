// Window long transcripts while keeping one scrolling table and variable row heights.
export function createCueList(body, pane, makeRow) {
  let cues = [], heights = [], tops = [0], first = -1, last = -1;
  const rebuild = () => { tops = [0]; for (const height of heights) tops.push(tops.at(-1) + height); };
  function locate(y) { let lo = 0, hi = cues.length; while (lo < hi) { const mid = lo + hi >>> 1; if (tops[mid + 1] < y) lo = mid + 1; else hi = mid; } return lo; }
  function render(force = false) {
    if (!force && body.contains(body.ownerDocument.activeElement)) return;
    const start = cues.length > 200 ? Math.max(0, locate(pane.scrollTop) - 12) : 0;
    const end = cues.length > 200 ? Math.min(cues.length, locate(pane.scrollTop + pane.clientHeight) + 20) : cues.length;
    if (!force && start === first && end === last) return;
    first = start; last = end;
    const fragment = body.ownerDocument.createDocumentFragment();
    const spacer = height => { const tr = body.ownerDocument.createElement('tr'), td = body.ownerDocument.createElement('td'); td.colSpan = 3; td.style.cssText = `height:${height}px;padding:0;border:0`; tr.setAttribute('aria-hidden', 'true'); tr.append(td); return tr; };
    if (start) fragment.append(spacer(tops[start]));
    const rows = cues.slice(start, end).map(makeRow); fragment.append(...rows);
    if (end < cues.length) fragment.append(spacer(tops.at(-1) - tops[end]));
    body.replaceChildren(fragment);
    requestAnimationFrame(() => {
      if (first !== start) return;
      rows.forEach((row, n) => { const input = row.querySelector('textarea'); if (input) { input.style.height = '0px'; const border = getComputedStyle(input); input.style.height = `${input.scrollHeight + parseFloat(border.borderTopWidth) + parseFloat(border.borderBottomWidth)}px`; } heights[start + n] = row.getBoundingClientRect().height || 56; }); rebuild();
    });
  }
  pane.addEventListener('scroll', () => render(), { passive: true });
  body.addEventListener('focusout', () => setTimeout(() => render(), 0));
  return {
    set(next) { cues = next; heights = cues.map(() => 56); rebuild(); first = last = -1; pane.scrollTop = 0; render(true); },
    ensureCue(index) { const n = cues.findIndex(cue => cue.index === index); if (n < 0 || n >= first && n < last) return; pane.scrollTop = tops[n]; render(); }
  };
}
