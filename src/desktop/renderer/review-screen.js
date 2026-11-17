export function mountReviewScreen() {
  const root = document.querySelector('#completed-view');
  const batch = root.querySelector('#batch-results');
  const revealSelectedFile = () => {
    const selected = batch.querySelector('[aria-pressed="true"]');
    if (!selected || root.hidden || batch.hidden) return;
    // Scroll only the file strip; never move the editor or the window.
    const left = selected.offsetLeft - batch.offsetLeft;
    if (left < batch.scrollLeft) batch.scrollLeft = left;
    else if (left + selected.offsetWidth > batch.scrollLeft + batch.clientWidth)
      batch.scrollLeft = left + selected.offsetWidth - batch.clientWidth;
  };
  new MutationObserver(revealSelectedFile).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(revealSelectedFile).observe(batch, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  new ResizeObserver(revealSelectedFile).observe(batch);
  const search = root.querySelector('#preview-search'), clear = root.querySelector('#clear-caption-search');
  search.addEventListener('input', () => { clear.hidden = !search.value; });
  clear.addEventListener('click', () => { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); search.focus(); });
  const list = root.querySelector('.table-wrap');
  list.addEventListener('keydown', event => {
    if (event.target !== list || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    const rows = [...list.querySelectorAll('tr[data-cue]')];
    if (!rows.length) return;
    event.preventDefault(); event.stopPropagation();
    const selected = rows.findIndex(row => row.classList.contains('cue-selected'));
    const offset = event.key === 'Enter' ? 0 : event.key === 'ArrowDown' ? 1 : -1;
    const index = selected < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, selected + offset));
    const row = rows[index];
    row.click();
    if (event.key === 'Enter') row.querySelector('textarea')?.focus();
    else { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); }
  });
  // Measure the real available line, retaining both filename ends and its full title.
  const filename = root.querySelector('#result-filename');
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  function fitFilename() {
    const full = filename.dataset.fullName; if (!full || !filename.clientWidth) return;
    context.font = getComputedStyle(filename).font;
    const line = filename.parentElement;
    const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
    const available = line.clientWidth - [...line.children].filter(child => child !== filename).reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) - gap * (line.children.length - 1);
    let text = full, keep = full.length;
    while (keep > 8 && context.measureText(text).width > available) {
      keep--; const first = Math.ceil(keep / 2), last = Math.floor(keep / 2);
      text = full.slice(0, first) + '…' + full.slice(-last);
    }
    if (filename.textContent !== text) filename.textContent = text;
  }
  new ResizeObserver(fitFilename).observe(filename);
  new MutationObserver(fitFilename).observe(filename, { attributes: true, attributeFilter: ['data-full-name'] });

  const tip = document.createElement('div'); tip.className = 'review-tooltip'; tip.id = 'review-tooltip';
  tip.setAttribute('role', 'tooltip'); tip.setAttribute('popover', 'manual'); document.body.append(tip);
  let timer, owner;
  const hide = () => { clearTimeout(timer); if (tip.matches(':popover-open')) tip.hidePopover(); owner?.removeAttribute('aria-describedby'); owner = undefined; };
  function show(button) {
    if (!button.dataset.tooltip || root.hidden) return;
    owner = button; tip.textContent = button.dataset.tooltip; button.setAttribute('aria-describedby', tip.id);
    if (!tip.matches(':popover-open')) tip.showPopover();
    const rect = button.getBoundingClientRect(), box = tip.getBoundingClientRect();
    const tokens = getComputedStyle(document.body), gap = parseFloat(tokens.getPropertyValue('--r-tip-gap')), edge = parseFloat(tokens.getPropertyValue('--r-2'));
    tip.style.inset = 'auto';
    tip.style.left = `${Math.max(edge, Math.min(innerWidth - box.width - edge, rect.left + (rect.width - box.width) / 2))}px`;
    tip.style.top = `${Math.max(edge, rect.top - box.height - gap)}px`;
  }
  for (const button of root.querySelectorAll('.player-toolbar button, #save-captions')) {
    button.addEventListener('pointerenter', () => { clearTimeout(timer); timer = setTimeout(() => show(button), 400); });
    button.addEventListener('pointerleave', hide);
    button.addEventListener('focus', () => { hide(); show(button); });
    button.addEventListener('blur', hide);
    button.addEventListener('click', () => { if (owner === button) show(button); });
  }
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  // Speed-menu Escape restores focus to its button; hide that focus tooltip too.
  document.addEventListener('keyup', event => { if (event.key === 'Escape') hide(); });
  new MutationObserver(() => { if (owner) { if (root.hidden) hide(); else show(owner); } }).observe(root, { subtree: true, attributes: true, attributeFilter: ['data-tooltip', 'hidden'] });
}
