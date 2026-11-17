export function timestampToMs(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  const [, hours, minutes, seconds, millis] = match.map(Number);
  if (minutes > 59 || seconds > 59) throw new Error(`Invalid SRT timestamp: ${value}`);
  return (((hours * 60 + minutes) * 60) + seconds) * 1000 + millis;
}

export function msToTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid time in milliseconds: ${ms}`);
  const total = Math.round(ms);
  const millis = total % 1000;
  const secondsTotal = Math.floor(total / 1000);
  const seconds = secondsTotal % 60;
  const minutesTotal = Math.floor(secondsTotal / 60);
  const minutes = minutesTotal % 60;
  const hours = Math.floor(minutesTotal / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export function stripTags(value) {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
