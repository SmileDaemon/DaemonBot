/** Escapes text for HTML. Everything from Discord or the bot goes through this. */
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const num = (n) => Number(n ?? 0).toLocaleString();

export function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, size] of units) {
    if (s >= size) {
      const n = Math.round(s / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return `${s} seconds ago`;
}

export const dateTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function duration(ms) {
  if (ms == null) return 'Live';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function hours(ms) {
  const h = ms / 3_600_000;
  return h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(ms / 60_000)} min`;
}

/** The last `n` days as YYYY-MM-DD (UTC, as the bot records them), oldest first. */
export function lastDays(n) {
  const out = [];
  const today = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(today - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export const initials = (name) =>
  String(name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();

export function toast(message, bad = false) {
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.textContent = message;
  if (bad) el.className = 'bad';
  box.append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 4000);
}

/** Color int from a log entry -> CSS hex. */
export const hex = (color) => (color == null ? 'var(--border)' : `#${Number(color).toString(16).padStart(6, '0')}`);
