import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dataDir = new URL('../../data/', import.meta.url);

/** A tiny JSON-file key/value store. Fine for a handful of servers; swap for a database if you grow. */
function createStore(name) {
  const file = new URL(`${name}.json`, dataDir);
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

  return {
    get: (key, fallback) => data[key] ?? fallback,
    set(key, value) {
      data[key] = value;
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2));
    },
  };
}

/** Per-server settings, keyed by guild ID: { logChannelId, wordFilter, tickets: { channelId, staffRoleId, queueChannelId, pingStaff } } */
export const guildConfig = createStore('config');

/** Tickets, keyed by guild ID: { next, byThread: { [threadId]: ticket } } */
export const tickets = createStore('tickets');

/**
 * Game activity, keyed by guild ID:
 * { optedOut: { [userId]: true }, users: { [userId]: { [game]: { ms, sessions, days, lastDay, first, last } } } }
 */
export const gameStats = createStore('games');

/** Warnings, keyed by guild ID: { [userId]: [{ reason, moderatorId, at }] } */
export const warnings = createStore('warnings');
