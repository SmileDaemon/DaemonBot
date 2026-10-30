import { Events } from 'discord.js';
import { onShutdown } from '../utils/shutdown.js';
import { guildConfig, isOptedOut, voiceStats } from '../utils/store.js';

// Shorter visits (joining the wrong channel, a quick hop) don't count as a session.
const MIN_SESSION_MS = 60_000;
// Time in progress is saved this often, so a crash or restart loses at most this much.
const CHECKPOINT_MS = 10 * 60_000;

// Records are per user, keyed by channel, so each one says which server the channel is in.
// userId -> { guildId, channelId, guildName, channelName, segStart, ms, with: Map(userId -> ms), counted }
const stays = new Map();
// channelId -> Set of tracked userIds in it, for working out who is with whom
const occupants = new Map();

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const isTracking = (guildId) => guildConfig.get(guildId, {}).voiceTracking !== false;

/** A user's voice record: { [channelId]: { guildId, guildName, channelName, ms, sessions, days, lastDay, first, last, with: { [userId]: ms } } } */
export const voiceOf = (userId) => voiceStats.get(userId, {}).channels ?? {};

/** Where a user is right now and their time there not yet saved, or null. */
export function liveVoice(userId) {
  const stay = stays.get(userId);
  if (!stay) return null;
  const pending = Date.now() - stay.segStart;
  const withMs = new Map(stay.with);
  for (const other of occupants.get(stay.channelId) ?? []) if (other !== userId) withMs.set(other, (withMs.get(other) ?? 0) + pending);
  return { channelId: stay.channelId, ms: stay.ms + pending, with: withMs, since: stay.joinedAt };
}

/** Moves time since the last change into each occupant's stay, crediting everyone they were with. */
function flushChannel(channelId, now) {
  const ids = occupants.get(channelId);
  if (!ids) return;
  for (const id of ids) {
    const stay = stays.get(id);
    const elapsed = now - stay.segStart;
    stay.segStart = now;
    if (elapsed <= 0) continue;
    stay.ms += elapsed;
    for (const other of ids) if (other !== id) stay.with.set(other, (stay.with.get(other) ?? 0) + elapsed);
  }
}

/** Saves a stay's time to the user's record. A stay becomes a session once it passes MIN_SESSION_MS. */
function commit(userId, stay, now) {
  if (!stay.counted && stay.ms < MIN_SESSION_MS) return; // too short so far
  const data = voiceStats.get(userId, {});
  const channels = (data.channels ??= {});
  const rec = (channels[stay.channelId] ??= { guildId: stay.guildId, ms: 0, sessions: 0, days: 0, lastDay: null, first: stay.joinedAt, last: now, with: {} });
  rec.guildName = stay.guildName;
  rec.channelName = stay.channelName;
  rec.ms += stay.ms;
  rec.last = now;
  for (const [other, ms] of stay.with) rec.with[other] = (rec.with[other] ?? 0) + ms;
  if (!stay.counted) rec.sessions += 1;
  if (rec.lastDay !== dayOf(now)) {
    rec.days += 1;
    rec.lastDay = dayOf(now);
  }
  stay.counted = true;
  stay.ms = 0;
  stay.with.clear();
  voiceStats.set(userId, data);
}

function join(userId, channel, now) {
  if (stays.has(userId)) leave(userId, now); // a missed event; don't leave a stale stay behind
  flushChannel(channel.id, now); // close everyone's segment before the company changes
  if (!occupants.has(channel.id)) occupants.set(channel.id, new Set());
  occupants.get(channel.id).add(userId);
  stays.set(userId, {
    guildId: channel.guild.id,
    channelId: channel.id,
    guildName: channel.guild.name,
    channelName: channel.name,
    joinedAt: now,
    segStart: now,
    ms: 0,
    with: new Map(),
    counted: false,
  });
}

function leave(userId, now) {
  const stay = stays.get(userId);
  if (!stay) return;
  flushChannel(stay.channelId, now);
  const ids = occupants.get(stay.channelId);
  ids.delete(userId);
  if (!ids.size) occupants.delete(stay.channelId);
  stays.delete(userId);
  commit(userId, stay, now); // stays under a minute are dropped
}

function checkpoint() {
  const now = Date.now();
  for (const channelId of occupants.keys()) flushChannel(channelId, now);
  for (const [userId, stay] of stays) commit(userId, stay, now);
}

/** Tracking was turned off in a server: end the stays of everyone in its voice channels. Time so far is kept. */
export function endGuildVoice(guildId) {
  const now = Date.now();
  for (const [userId, stay] of [...stays]) if (stay.guildId === guildId) leave(userId, now);
}

/**
 * Someone opted out of this server: drop their stay there without saving it, and take them out of
 * the company of everyone in its channels, so nobody's record there says they were with them.
 */
export function forgetVoice(guildId, userId) {
  const stay = stays.get(userId);
  if (stay?.guildId === guildId) {
    flushChannel(stay.channelId, Date.now());
    const ids = occupants.get(stay.channelId);
    ids.delete(userId);
    if (!ids.size) occupants.delete(stay.channelId);
    stays.delete(userId);
  }
  for (const other of stays.values()) if (other.guildId === guildId) other.with.delete(userId);
}

/** Whether to track someone in this channel. The server's AFK channel and opted-out members aren't counted. */
const trackable = (channel, member) =>
  channel && member && !member.user.bot && !isOptedOut(channel.guild.id, member.id) && isTracking(channel.guild.id) && channel.id !== channel.guild.afkChannelId;

export function registerVoiceTracker(client) {
  client.on(Events.VoiceStateUpdate, (before, after) => {
    if (before.channelId === after.channelId) return; // mute, deafen, stream changes
    try {
      const now = Date.now();
      if (stays.get(after.id)?.channelId === before.channelId) leave(after.id, now);
      if (trackable(after.channel, after.member)) join(after.id, after.channel, now);
    } catch (err) {
      console.error('Voice tracker:', err);
    }
  });

  // Pick up people already in voice when the bot started (they count from now).
  client.once(Events.ClientReady, () => {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (trackable(state.channel, state.member) && !stays.has(state.id)) join(state.id, state.channel, now);
      }
    }
  });

  // Keep channel and server names current in records when they're renamed.
  client.on(Events.ChannelUpdate, (_, channel) => {
    for (const stay of stays.values()) if (stay.channelId === channel.id) stay.channelName = channel.name;
  });
  client.on(Events.GuildUpdate, (_, guild) => {
    for (const stay of stays.values()) if (stay.guildId === guild.id) stay.guildName = guild.name;
  });

  setInterval(checkpoint, CHECKPOINT_MS).unref();
  onShutdown(checkpoint);
}
