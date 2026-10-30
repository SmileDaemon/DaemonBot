import { ActivityType, Events } from 'discord.js';
import { onShutdown } from '../utils/shutdown.js';
import { gameStats, guildConfig, isOptedOut } from '../utils/store.js';

// Shorter stretches (a game launcher flickering, a quick crash) don't count as a session.
const MIN_SESSION_MS = 60_000;
// Time in progress is saved this often, so a crash or restart loses at most this much.
const CHECKPOINT_MS = 10 * 60_000;

// Records are kept per server: someone in three servers with the bot gets a record in each server
// that tracks games, and each server's panel sees only its own. Discord sends a presence change once
// per shared server, so each server's copy of it updates that server's sessions.
// "guildId:userId" -> Map(game -> { start, counted })
const active = new Map();

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = (guildId, userId) => `${guildId}:${userId}`;

// Stats are only shown in the control panel; there are no Discord commands for them.
const isTracking = (guildId) => guildConfig.get(guildId, {}).gameTracking !== false;

/** A user's games in one server: { [game]: { ms, sessions, days, lastDay, first, last } } */
export const gamesOf = (guildId, userId) => gameStats.get(userId, {}).guilds?.[guildId] ?? {};

/** Names of the games a presence shows the user playing. */
const gamesIn = (presence) =>
  new Set((presence?.activities ?? []).filter((a) => a.type === ActivityType.Playing && a.name).map((a) => a.name.slice(0, 100)));

/** Adds time played to a user's record in a server. A session is counted once it passes MIN_SESSION_MS. */
function record(guildId, userId, game, session, now) {
  const elapsed = now - session.start;
  if (!session.counted && elapsed < MIN_SESSION_MS) return; // too short so far; keep accumulating
  session.start = now;

  const data = gameStats.get(userId, {});
  const games = ((data.guilds ??= {})[guildId] ??= {});
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

/** Ends a user's sessions in a server. Time so far is kept; too-short sessions are dropped. */
function endSessions(guildId, userId, now = Date.now()) {
  const key = sessionKey(guildId, userId);
  for (const [game, session] of active.get(key) ?? []) record(guildId, userId, game, session, now);
  active.delete(key);
}

function update(guildId, userId, presence) {
  const key = sessionKey(guildId, userId);
  const sessions = active.get(key) ?? new Map();
  const playing = gamesIn(presence);
  const now = Date.now();

  for (const [game, session] of sessions) {
    if (playing.has(game)) continue;
    record(guildId, userId, game, session, now);
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

/** Tracking was turned off in a server: end the sessions counted there. Time so far is kept. */
export function endGuildSessions(guildId) {
  const now = Date.now();
  for (const key of [...active.keys()]) {
    const [g, userId] = key.split(':');
    if (g === guildId) endSessions(guildId, userId, now);
  }
}

/** Someone opted out of this server: drop their sessions in progress and their game record there. */
export function forgetGames(guildId, userId) {
  active.delete(sessionKey(guildId, userId));
  const data = gameStats.get(userId, {});
  if (!data.guilds?.[guildId]) return;
  delete data.guilds[guildId];
  if (Object.keys(data.guilds).length) gameStats.set(userId, data);
  else gameStats.delete(userId);
}

/** Unsaved time (ms) of a session in progress, so the panel can include it. */
export function liveMs(guildId, userId, game) {
  const session = active.get(sessionKey(guildId, userId))?.get(game);
  return session ? Date.now() - session.start : 0;
}

/** Everyone playing in a server right now: [userId, [game]] pairs, for spotting people playing together. */
export const currentPlayers = (guildId) =>
  [...active].filter(([key]) => key.startsWith(`${guildId}:`)).map(([key, sessions]) => [key.split(':')[1], [...sessions.keys()]]);

/**
 * Records used to be one per user across every server ({ games }). Each moves to the one server the
 * user shares with the bot; when they share several it can't be split fairly, so it's dropped rather
 * than shown to servers whose time it doesn't reflect.
 */
function migrateSharedRecords(client) {
  for (const userId of gameStats.keys()) {
    const data = gameStats.get(userId, {});
    if (!data.games) continue;
    const shared = client.guilds.cache.filter((g) => g.members.cache.has(userId) && !isOptedOut(g.id, userId));
    if (shared.size === 1) gameStats.set(userId, { guilds: { ...data.guilds, [shared.first().id]: data.games } });
    else if (data.guilds && Object.keys(data.guilds).length) gameStats.set(userId, { guilds: data.guilds });
    else gameStats.delete(userId);
  }
}

export function registerGameTracker(client) {
  client.on(Events.PresenceUpdate, (_, presence) => {
    if (!presence.guild || !isTracking(presence.guild.id) || presence.user?.bot || presence.member?.user.bot) return;
    if (isOptedOut(presence.guild.id, presence.userId)) return;
    try {
      update(presence.guild.id, presence.userId, presence);
    } catch (err) {
      console.error('Game tracker:', err);
    }
  });

  client.once(Events.ClientReady, async () => {
    // Member lists are needed to show a server's own members in the control panel.
    await Promise.all(client.guilds.cache.map((g) => g.members.fetch().catch(() => {})));
    migrateSharedRecords(client);
    // Pick up people who were already playing when the bot started (they count from now).
    for (const guild of client.guilds.cache.values()) {
      if (!isTracking(guild.id)) continue;
      for (const presence of guild.presences.cache.values()) {
        if (!presence.user?.bot && !isOptedOut(guild.id, presence.userId)) update(guild.id, presence.userId, presence);
      }
    }
  });

  setInterval(checkpoint, CHECKPOINT_MS).unref();

  // Save sessions in progress when the bot is stopped (Ctrl+C, pm2 stop/restart).
  onShutdown(checkpoint);
}
