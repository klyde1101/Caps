// One dialog, one settled promise. Native <dialog> owns focus above Settings.
export function createModelDeleteDialog(dialog) {
  let pending;
  const close = accepted => {
    if (!pending) return;
    const { resolve, opener } = pending; pending = undefined;
    dialog.close(); resolve(accepted);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  dialog.querySelector('[data-confirm]').addEventListener('click', () => close(true));
  dialog.querySelector('[data-dismiss]').addEventListener('click', () => close(false));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(false); });
  // A native close (including a parent teardown) must also release admission.
  dialog.addEventListener('close', () => { if (!dialog.open) close(false); });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close(false);
  });
  return (name, size) => {
    if (pending) return Promise.resolve(false);
    dialog.querySelector('[data-model-name]').textContent = `Delete ${name}?`;
    dialog.querySelector('[data-model-size]').textContent = `Size freed: ${size} GB`;
    return new Promise(resolve => {
      pending = { resolve, opener: dialog.ownerDocument.activeElement };
      try { dialog.showModal(); dialog.querySelector('[data-dismiss]').focus(); }
      catch { close(false); }
    });
  };
}
