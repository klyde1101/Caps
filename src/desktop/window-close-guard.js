// Resume normal close after cancellation so Electron still runs beforeunload.
export function protectWindowClose(window, { jobs, confirmCancel, onError }) {
  let cancelling = false;
  window.on('close', event => {
    if (cancelling) { event.preventDefault(); return; }
    if (!jobs.active) return;
    event.preventDefault();
    if (!confirmCancel()) return;
    cancelling = true;
    void jobs.cancelAndWait().then(() => {
      cancelling = false;
      if (!window.isDestroyed()) window.close();
    }, error => {
      cancelling = false;
      onError(error);
    });
  });
}
