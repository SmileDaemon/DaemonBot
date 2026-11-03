import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dataDir = new URL('../../data/', import.meta.url);

/** A tiny JSON-file key/value store. Fine for a handful of servers; swap for a database if you grow. */
function createStore(name) {
  const file = new URL(`${name}.json`, dataDir);
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

  return {
    get: (key, fallback) => data[key] ?? fallback,
    keys: () => Object.keys(data),
    set(key, value) {
      data[key] = value;
      save();
    },
    delete(key) {
      if (!(key in data)) return;
      delete data[key];
      save();
    },
  };

  function save() {
    mkdirSync(dataDir, { recursive: true });
    // No indentation: the files are about a third smaller. Open one in a JSON formatter to read it.
    writeFileSync(file, JSON.stringify(data));
  }
}

/** Per-server settings, keyed by guild ID: { logChannelId, wordFilter, tickets: { sectionId, channelId, panelMessageId, types, staffRoleId, queueChannelId, pingStaff, categoryId, archiveCategoryId } } */
export const guildConfig = createStore('config');

/** Tickets, keyed by guild ID: { next, byChannel: { [channelId]: ticket } } */
export const tickets = createStore('tickets');

/** Temporary voice channels in use, keyed by guild ID: { [channelId]: { ownerId, locked, private, messageId } } */
export const tempVoiceRooms = createStore('tempvoice');

/** Game activity, keyed by user ID, kept separately for each server: { guilds: { [guildId]: { [game]: { ms, sessions, days, lastDay, first, last } } } } */
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
 * Pairs with no interaction for 180 days are packed, losslessly, into `_cold: { [pairKey]: [replies, mentions,
 * reactions, chats, gameMs, first, last, games] }`, and unpacked when they interact again.
 */
export const connectionStats = createStore('connections');

/**
 * Members who asked (by email, see PRIVACY.md) not to be counted in a server's activity, voice, game or
 * connection statistics, keyed by guild ID: { [userId]: { at } }. Each server is requested separately.
 * Added from the control panel's Bot page.
 */
export const optOuts = createStore('optouts');

/** Whether this person has opted out of statistics in this server. */
export const isOptedOut = (guildId, userId) => Boolean(optOuts.get(guildId, {})[userId]);

/** Levels, keyed by guild ID: { [userId]: { xp, lastMessageAt } }. Settings are in guildConfig.levels (on/off) and guildConfig.levelConfig. */
export const levels = createStore('levels');

/** Warnings, keyed by guild ID: { [userId]: [{ reason, moderatorId, at }] } */
export const warnings = createStore('warnings');

/** Raid protection's running state, keyed by guild ID: { lockdown, raid, incidents } */
export const securityState = createStore('security');

/**
 * Backups of each server's channels and roles, newest first, keyed by guild ID: [{ at, reason, everyone, roles,
 * channels }]. Only the newest is saved whole; each older one is saved as its differences from the one after it.
 */
export const backups = createStore('backups');

/** Which bot update notes each server has had, and today's message: { seen, day, channelId, messageId, posted } */
export const updateNotes = createStore('updatenotes');

/** Closed tickets' conversations, keyed by guild ID then ticket number; each is deleted 30 days after closing. */
export const transcripts = createStore('transcripts');
