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

/** Game activity, keyed by user ID (one record per person across all servers): { games: { [game]: { ms, sessions, days, lastDay, first, last } } } */
export const gameStats = createStore('games');

/**
 * Voice channel time, keyed by user ID: { channels: { [channelId]: { guildId, guildName, channelName,
 * ms, sessions, days, lastDay, first, last, with: { [userId]: ms } } } }
 */
export const voiceStats = createStore('voice');

/**
 * Server activity, keyed by guild ID: { [userId]: { messages, reactions, days, lastDay, first, last,
 * channels: { [channelId]: messages }, daily: { [YYYY-MM-DD]: messages + reactions } } }
 */
export const activityStats = createStore('activity');

/**
 * Connections between members, keyed by guild ID: { ["lowerId-higherId"]: { replies, mentions, reactions,
 * chats, gameMs, games: { [game]: ms }, first, last } }. Voice time together comes from voiceStats.
 */
export const connectionStats = createStore('connections');

/** Warnings, keyed by guild ID: { [userId]: [{ reason, moderatorId, at }] } */
export const warnings = createStore('warnings');
