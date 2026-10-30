const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parses durations like "10m", "1h30m", "2d" into milliseconds. Returns null if invalid. */
export function parseDuration(input) {
  const text = input.toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[smhdw])+$/.test(text)) return null;
  return [...text.matchAll(/(\d+)([smhdw])/g)].reduce((total, [, amount, unit]) => total + Number(amount) * UNITS[unit], 0);
}

/** Parses "#ff8800" / "ff8800" into a number. Returns null if invalid. */
export function parseColor(input) {
  if (!input) return null;
  const hex = input.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : null;
}

export const defaultColor = parseColor(process.env.DEFAULT_EMBED_COLOR) ?? 0x5865f2;

export function isHttpUrl(input) {
  try {
    return ['http:', 'https:'].includes(new URL(input).protocol);
  } catch {
    return false;
  }
}

/** Matches links like https://discord.com/channels/<guild>/<channel>/<message> */
export const MESSAGE_LINK = /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
