import { ActivityType, Events } from 'discord.js';
import { gameStats, guildConfig } from '../utils/store.js';

// Shorter stretches (a game launcher flickering, a quick crash) don't count as a session.
const MIN_SESSION_MS = 60_000;
// Time in progress is saved this often, so a crash or restart loses at most this much.
const CHECKPOINT_MS = 10 * 60_000;

// `${guildId}:${userId}` -> Map(game -> { start, counted })
const active = new Map();

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export const isTracking = (guildId) => guildConfig.get(guildId, {}).gameTracking !== false;
export const hasOptedOut = (guildId, userId) => Boolean(gameStats.get(guildId, {}).optedOut?.[userId]);

/** Names of the games a presence shows the user playing. */
const gamesIn = (presence) =>
  new Set((presence?.activities ?? []).filter((a) => a.type === ActivityType.Playing && a.name).map((a) => a.name.slice(0, 100)));

/** Adds time played to a user's record. A session is counted once it passes MIN_SESSION_MS. */
function record(guildId, userId, game, session, now) {
  const elapsed = now - session.start;
  if (!session.counted && elapsed < MIN_SESSION_MS) return false; // too short so far; keep accumulating
  session.start = now;

  const data = gameStats.get(guildId, {});
  const users = (data.users ??= {});
  const games = (users[userId] ??= {});
  const stats = (games[game] ??= { ms: 0, sessions: 0, days: 0, lastDay: null, first: now - elapsed, last: now });
  stats.ms += elapsed;
  stats.last = now;
  if (!session.counted) stats.sessions += 1;
  if (stats.lastDay !== dayOf(now)) {
    stats.days += 1;
    stats.lastDay = dayOf(now);
  }
  session.counted = true;
  gameStats.set(guildId, data);
  return true;
}

function update(guildId, userId, presence) {
  const key = `${guildId}:${userId}`;
  const sessions = active.get(key) ?? new Map();
  const playing = isTracking(guildId) && !hasOptedOut(guildId, userId) ? gamesIn(presence) : new Set();
  const now = Date.now();

  for (const [game, session] of sessions) {
    if (playing.has(game)) continue;
    record(guildId, userId, game, session, now); // too-short sessions are simply dropped
    sessions.delete(game);
  }
  for (const game of playing) if (!sessions.has(game)) sessions.set(game, { start: now, counted: false });

  if (sessions.size) active.set(key, sessions);
  else active.delete(key);
}

/** Saves time in progress for everyone currently playing. */
function checkpoint() {
  const now = Date.now();
  for (const [key, sessions] of active) {
    const [guildId, userId] = key.split(':');
    for (const [game, session] of sessions) record(guildId, userId, game, session, now);
  }
}

/** Stops tracking someone in one server (opting out) and saves nothing more for them. */
export function forgetUser(guildId, userId) {
  active.delete(`${guildId}:${userId}`);
}

/** Ends every session in a server, e.g. when tracking is turned off there. Time so far is kept. */
export function endGuildSessions(guildId) {
  const now = Date.now();
  for (const [key, sessions] of active) {
    if (!key.startsWith(`${guildId}:`)) continue;
    const userId = key.split(':')[1];
    for (const [game, session] of sessions) record(guildId, userId, game, session, now);
    active.delete(key);
  }
}

/** Unsaved time (ms) of a session in progress, so /games can include it. */
export function liveMs(guildId, userId, game) {
  const session = active.get(`${guildId}:${userId}`)?.get(game);
  return session ? Date.now() - session.start : 0;
}

export function registerGameTracker(client) {
  client.on(Events.PresenceUpdate, (_, presence) => {
    if (!presence.guild || presence.user?.bot || presence.member?.user.bot) return;
    try {
      update(presence.guild.id, presence.userId, presence);
    } catch (err) {
      console.error('Game tracker:', err);
    }
  });

  // Pick up people who were already playing when the bot started (they count from now).
  client.once(Events.ClientReady, () => {
    for (const guild of client.guilds.cache.values()) {
      for (const presence of guild.presences.cache.values()) {
        if (!presence.user?.bot) update(guild.id, presence.userId, presence);
      }
    }
  });

  setInterval(checkpoint, CHECKPOINT_MS).unref();

  // Save sessions in progress when the bot is stopped (Ctrl+C, pm2 stop/restart).
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      checkpoint();
      process.exit(0);
    });
  }
}
