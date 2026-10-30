import { ActivityType, Events } from 'discord.js';
import { onShutdown } from '../utils/shutdown.js';
import { gameStats, guildConfig, isOptedOut } from '../utils/store.js';

// Shorter stretches (a game launcher flickering, a quick crash) don't count as a session.
const MIN_SESSION_MS = 60_000;
// Time in progress is saved this often, so a crash or restart loses at most this much.
const CHECKPOINT_MS = 10 * 60_000;

// Records follow the user, not the server: someone in three servers with the bot gets one record,
// and the same presence change arriving from each of those servers is only counted once.
// userId -> Map(game -> { start, counted })
const active = new Map();

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Stats are only shown in the control panel; there are no Discord commands for them.
const isTracking = (guildId) => guildConfig.get(guildId, {}).gameTracking !== false;

/** A user's games: { [game]: { ms, sessions, days, lastDay, first, last } } */
export const gamesOf = (userId) => gameStats.get(userId, {}).games ?? {};

/** Names of the games a presence shows the user playing. */
const gamesIn = (presence) =>
  new Set((presence?.activities ?? []).filter((a) => a.type === ActivityType.Playing && a.name).map((a) => a.name.slice(0, 100)));

/** Adds time played to a user's record. A session is counted once it passes MIN_SESSION_MS. */
function record(userId, game, session, now) {
  const elapsed = now - session.start;
  if (!session.counted && elapsed < MIN_SESSION_MS) return; // too short so far; keep accumulating
  session.start = now;

  const data = gameStats.get(userId, {});
  const games = (data.games ??= {});
  const stats = (games[game] ??= { ms: 0, sessions: 0, days: 0, lastDay: null, first: now - elapsed, last: now });
  stats.ms += elapsed;
  stats.last = now;
  if (!session.counted) stats.sessions += 1;
  if (stats.lastDay !== dayOf(now)) {
    stats.days += 1;
    stats.lastDay = dayOf(now);
  }
  session.counted = true;
  gameStats.set(userId, data);
}

/** Ends a user's sessions. Time so far is kept; too-short sessions are dropped. */
function endSessions(userId, now = Date.now()) {
  for (const [game, session] of active.get(userId) ?? []) record(userId, game, session, now);
  active.delete(userId);
}

function update(userId, presence) {
  const sessions = active.get(userId) ?? new Map();
  const playing = gamesIn(presence);
  const now = Date.now();

  for (const [game, session] of sessions) {
    if (playing.has(game)) continue;
    record(userId, game, session, now);
    sessions.delete(game);
  }
  for (const game of playing) if (!sessions.has(game)) sessions.set(game, { start: now, counted: false });

  if (sessions.size) active.set(userId, sessions);
  else active.delete(userId);
}

/** Saves time in progress for everyone currently playing. */
function checkpoint() {
  const now = Date.now();
  for (const [userId, sessions] of active) {
    for (const [game, session] of sessions) record(userId, game, session, now);
  }
}

/**
 * Tracking was turned off in a server: end sessions for its members who aren't in another
 * server that still tracks (those keep going there). Time so far is kept.
 */
export function endGuildSessions(client, guildId) {
  const now = Date.now();
  for (const userId of [...active.keys()]) {
    if (!trackedElsewhere(client, guildId, userId)) endSessions(userId, now);
  }
}

/** Whether a server other than this one still counts this person's games. */
const trackedElsewhere = (client, guildId, userId) =>
  client.guilds.cache.some((g) => g.id !== guildId && isTracking(g.id) && !isOptedOut(g.id, userId) && g.members.cache.has(userId));

/**
 * Someone opted out of this server. Their game record is shared by every server, so it's kept while
 * another server still counts their games (this server's panel just stops showing it). Otherwise their
 * sessions in progress and their record are dropped. Returns whether the record was deleted.
 */
export function forgetGames(client, guildId, userId) {
  if (trackedElsewhere(client, guildId, userId)) return false;
  active.delete(userId);
  gameStats.delete(userId);
  return true;
}

/** Unsaved time (ms) of a session in progress, so /games can include it. */
export function liveMs(userId, game) {
  const session = active.get(userId)?.get(game);
  return session ? Date.now() - session.start : 0;
}

/** Everyone playing right now: [userId, [game]] pairs, for spotting people playing together. */
export const currentPlayers = () => [...active].map(([userId, sessions]) => [userId, [...sessions.keys()]]);

export function registerGameTracker(client) {
  client.on(Events.PresenceUpdate, (_, presence) => {
    // Servers that turned tracking off are ignored; the user is still tracked through any other server.
    if (!presence.guild || !isTracking(presence.guild.id) || presence.user?.bot || presence.member?.user.bot) return;
    if (isOptedOut(presence.guild.id, presence.userId)) return;
    try {
      update(presence.userId, presence);
    } catch (err) {
      console.error('Game tracker:', err);
    }
  });

  client.once(Events.ClientReady, async () => {
    // Member lists are needed to show a server's own members in the control panel.
    await Promise.all(client.guilds.cache.map((g) => g.members.fetch().catch(() => {})));
    // Pick up people who were already playing when the bot started (they count from now).
    for (const guild of client.guilds.cache.values()) {
      if (!isTracking(guild.id)) continue;
      for (const presence of guild.presences.cache.values()) {
        if (!presence.user?.bot && !active.has(presence.userId) && !isOptedOut(guild.id, presence.userId)) update(presence.userId, presence);
      }
    }
  });

  setInterval(checkpoint, CHECKPOINT_MS).unref();

  // Save sessions in progress when the bot is stopped (Ctrl+C, pm2 stop/restart).
  onShutdown(checkpoint);
}
