// Renderer-only decisions; callers keep the existing save/reload/reset handlers.
export function reviewDecision({ title, message, choices }) {
  const dialog = document.querySelector('#review-confirm');
  if (dialog.open) return Promise.resolve('cancel');
  const previous = document.activeElement;
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('p').textContent = message;
  const actions = dialog.querySelector('.review-dialog-actions'); actions.replaceChildren();
  return new Promise(resolve => {
    let answer = 'cancel';
    for (const [value, label] of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.dataset.choice = value;
      button.addEventListener('click', () => { answer = value; dialog.close(); });
      actions.append(button);
    }
    dialog.addEventListener('close', () => { previous?.focus({ preventScroll: true }); resolve(answer); }, { once: true });
    dialog.showModal(); actions.lastElementChild.focus();
  });
}
