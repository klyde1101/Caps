export const SECURITY_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false
});

export const WINDOW_SIZE = Object.freeze({ width: 1180, height: 820 });
export const SPLASH_SIZE = Object.freeze({ width: 360, height: 220 });

export function createWindowOptions(preloadPath) {
  return {
    ...WINDOW_SIZE,
    minWidth: 1000,
    minHeight: 700,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    center: true,
    show: false,
    title: 'Caps',
    titleBarStyle: 'hidden',
    // Let each screen's title-bar surface continue behind the native controls.
    titleBarOverlay: { color: '#00000000', symbolColor: '#ECECEF', height: 64 },
    webPreferences: { preload: preloadPath, ...SECURITY_WEB_PREFERENCES }
  };
}

export function createSplashWindowOptions() {
  return {
    ...SPLASH_SIZE,
    minWidth: SPLASH_SIZE.width,
    minHeight: SPLASH_SIZE.height,
    maxWidth: SPLASH_SIZE.width,
    maxHeight: SPLASH_SIZE.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    webPreferences: { ...SECURITY_WEB_PREFERENCES }
  };
}
