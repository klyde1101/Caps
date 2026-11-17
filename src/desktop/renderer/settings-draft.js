export function settingsChanged(saved, draft) {
  const values = settings => [settings.model, settings.device, Number(settings.deviceIndex ?? 0),
    settings.orientation, settings.fontSize, settings.fontFamily,
    Number(settings.timing?.minDurationMs ?? 100), Number(settings.timing?.bridgeGapMs ?? 80)];
  return JSON.stringify(values(saved)) !== JSON.stringify(values(draft));
}
