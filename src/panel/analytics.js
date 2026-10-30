/**
 * What the bot has counted and logged since the last sync with the control panel.
 * Nothing is kept unless the panel is set up (PANEL_URL and PANEL_SECRET in .env).
 */
let enabled = false;
const counters = new Map(); // "guild|day|metric|key|op" -> value
const activeUsers = new Map(); // "guild|day" -> Set of user IDs
let logs = [];

const MAX_LOGS = 2_000; // if the panel is unreachable for a long time, keep the newest

const dayOf = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export function enableAnalytics() {
  enabled = true;
}

function bump(guildId, metric, key, value, op) {
  if (!enabled || !guildId) return;
  const id = [guildId, dayOf(), metric, key, op].join('|');
  const old = counters.get(id) ?? 0;
  counters.set(id, op === 'add' ? old + value : op === 'max' ? Math.max(old, value) : value);
}

/** Adds to today's count of `metric` (optionally broken down by `key`, e.g. a channel or command name). */
export const count = (guildId, metric, key = '', n = 1) => bump(guildId, metric, key, n, 'add');

/** Records today's value of a level, like the member count. */
export const gauge = (guildId, metric, value) => bump(guildId, metric, '', value, 'set');

/** Counts someone as active today; the panel sees how many different people were. */
export function markActive(guildId, userId) {
  if (!enabled || !guildId) return;
  const id = `${guildId}|${dayOf()}`;
  if (!activeUsers.has(id)) activeUsers.set(id, new Set());
  activeUsers.get(id).add(userId);
}

/** Copies a log entry to the panel's searchable history. */
export function mirrorLog(guildId, entry) {
  if (!enabled || !guildId) return;
  logs.push({ guildId, at: Date.now(), ...entry });
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
}

/** Takes everything waiting to be sent. Hand it back with `restore` if the sync fails. */
export function drain() {
  const stats = [...counters].map(([id, value]) => {
    const [guildId, day, metric, key, op] = id.split('|');
    return { guildId, day, metric, key, value, op };
  });
  const today = dayOf();
  for (const [id, users] of activeUsers) {
    const [guildId, day] = id.split('|');
    stats.push({ guildId, day, metric: 'active_users', key: '', value: users.size, op: 'max' });
    if (day !== today) activeUsers.delete(id); // yesterday's set is final once sent
  }
  const out = { stats, logs };
  counters.clear();
  logs = [];
  return out;
}

export function restore({ stats, logs: unsent }) {
  for (const s of stats) {
    if (s.metric === 'active_users') continue; // still in activeUsers, or final already
    const id = [s.guildId, s.day, s.metric, s.key, s.op].join('|');
    const old = counters.get(id);
    counters.set(id, old === undefined ? s.value : s.op === 'add' ? old + s.value : s.op === 'max' ? Math.max(old, s.value) : old);
  }
  logs = [...unsent, ...logs].slice(-MAX_LOGS);
}
