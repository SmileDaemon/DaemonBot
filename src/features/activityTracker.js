import { Events } from 'discord.js';
import { onShutdown } from '../utils/shutdown.js';
import { activityStats, guildConfig, isOptedOut } from '../utils/store.js';

// Messages arrive far too often to rewrite the data file for each one, so counts are batched.
const FLUSH_MS = 60_000;
// Per-day counts are kept this long, for the panel's "recent activity" view.
const DAILY_DAYS = 30;

// guildId -> Map(userId -> { messages, reactions, channels: Map(channelId -> n), at })
const pending = new Map();

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const isTracking = (guildId) => guildConfig.get(guildId, {}).activityTracking !== false;

/** A server's activity records: { [userId]: { messages, reactions, days, lastDay, first, last, channels: { [channelId]: n }, daily: { [day]: n } } } */
export const activityIn = (guildId) => activityStats.get(guildId, {});

function note(guildId, userId, kind, channelId) {
  if (isOptedOut(guildId, userId)) return;
  if (!pending.has(guildId)) pending.set(guildId, new Map());
  const users = pending.get(guildId);
  const p = users.get(userId) ?? { messages: 0, reactions: 0, channels: new Map(), at: 0 };
  p[kind] += 1;
  if (kind === 'messages') p.channels.set(channelId, (p.channels.get(channelId) ?? 0) + 1);
  p.at = Date.now();
  users.set(userId, p);
}

function flush() {
  const now = Date.now();
  const today = dayOf(now);
  const oldest = dayOf(now - DAILY_DAYS * 24 * 60 * 60_000);
  for (const [guildId, users] of pending) {
    const data = activityStats.get(guildId, {});
    for (const [userId, p] of users) {
      const rec = (data[userId] ??= { messages: 0, reactions: 0, days: 0, lastDay: null, first: p.at, last: p.at, channels: {}, daily: {} });
      rec.messages += p.messages;
      rec.reactions += p.reactions;
      rec.last = p.at;
      for (const [channelId, n] of p.channels) rec.channels[channelId] = (rec.channels[channelId] ?? 0) + n;
      rec.daily[today] = (rec.daily[today] ?? 0) + p.messages + p.reactions;
      for (const day of Object.keys(rec.daily)) if (day < oldest) delete rec.daily[day];
      if (rec.lastDay !== today) {
        rec.days += 1;
        rec.lastDay = today;
      }
    }
    activityStats.set(guildId, data);
  }
  pending.clear();
}

/** Drops counts not yet saved for someone who opted out of this server. */
export function forgetActivity(guildId, userId) {
  pending.get(guildId)?.delete(userId);
}

export function registerActivityTracker(client) {
  client.on(Events.MessageCreate, (message) => {
    if (!message.guild || message.author.bot || message.system || !isTracking(message.guild.id)) return;
    note(message.guild.id, message.author.id, 'messages', message.channelId);
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    const { guildId } = reaction.message;
    if (!guildId || user.bot || !isTracking(guildId)) return;
    note(guildId, user.id, 'reactions');
  });

  setInterval(flush, FLUSH_MS).unref();
  onShutdown(flush);
}
