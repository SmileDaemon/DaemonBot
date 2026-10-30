import { Events } from 'discord.js';
import { onShutdown } from '../utils/shutdown.js';
import { guildConfig, isOptedOut, levels } from '../utils/store.js';

// Defaults for what servers can change with /levels xp. A message earns a random amount between min and
// max, at most once per cooldown, so spamming doesn't pay. Voice earns per full minute with at least one
// other (undeafened) person; the AFK channel doesn't count.
export const XP_DEFAULTS = { messageMin: 15, messageMax: 25, cooldownSeconds: 60, voicePerMinute: 10 };
// Placeholders: {user} mentions them, {name} is their display name, {level}, {roles} (reward roles just
// given, with a leading space, or nothing), {server}.
export const DEFAULT_LEVEL_MESSAGE = '🎉 {user} reached **level {level}**!{roles}';
// XP changes far too often to rewrite the data file each time, so they're saved in batches.
const SAVE_MS = 30_000;

const dirty = new Set();

/** XP needed to go from `level` to the next one: 100, 155, 220, 295, ... */
const xpForNext = (level) => 5 * level ** 2 + 50 * level + 100;

/** Level reached with this much XP, plus progress towards the next: { level, into, needed }. */
export function levelFromXp(xp) {
  let level = 0;
  let rest = xp;
  while (rest >= xpForNext(level)) rest -= xpForNext(level++);
  return { level, into: rest, needed: xpForNext(level) };
}

/**
 * A server's level settings. On (guildConfig.levels, a boolean shared with the control panel's Settings)
 * unless turned off there or with /levels enable, or for the whole bot with ENABLE_LEVELS in .env.
 * The rest is in guildConfig.levelConfig: announce: 'here' (where they levelled up), 'off', or a channel ID.
 * rewards: { [level]: roleId }. xp: see XP_DEFAULTS. message: the level-up text, or null for DEFAULT_LEVEL_MESSAGE.
 */
export function levelSettings(guildId) {
  const config = guildConfig.get(guildId, {});
  const saved = config.levelConfig ?? {};
  return {
    announce: 'here',
    rewards: {},
    message: null,
    ...saved,
    enabled: process.env.ENABLE_LEVELS === 'true' && config.levels !== false,
    xp: { ...XP_DEFAULTS, ...saved.xp },
  };
}

/** Fills in a level-up message's placeholders. */
export const levelMessage = (template, { member, level, roles = [] }) =>
  (template ?? DEFAULT_LEVEL_MESSAGE)
    .replaceAll('{user}', `${member}`)
    .replaceAll('{name}', member.displayName)
    .replaceAll('{level}', String(level))
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{roles}', roles.length ? ` You now have ${roles.map((r) => `**${r.name}**`).join(', ')}.` : '');

export function saveLevelSettings(guildId, { enabled, ...changes }) {
  const config = guildConfig.get(guildId, {});
  const next = { ...config };
  if (enabled !== undefined) next.levels = enabled;
  if (Object.keys(changes).length) next.levelConfig = { ...config.levelConfig, ...changes };
  guildConfig.set(guildId, next);
}

/** A server's level records, the live object: { [userId]: { xp, lastMessageAt } }. */
export function levelsIn(guildId) {
  let data = levels.get(guildId);
  if (!data) levels.set(guildId, (data = {}));
  return data;
}

/** Members ranked by XP: [{ userId, xp, rank }]. */
export const ranking = (guildId) =>
  Object.entries(levelsIn(guildId))
    .filter(([, r]) => r.xp > 0)
    .sort(([, a], [, b]) => b.xp - a.xp)
    .map(([userId, r], i) => ({ userId, xp: r.xp, rank: i + 1 }));

function save() {
  for (const guildId of dirty) levels.set(guildId, levelsIn(guildId));
  dirty.clear();
}

/** Gives every reward role due at this level that the member doesn't have yet. Returns the roles given. */
export async function applyRewards(member, level) {
  const { rewards } = levelSettings(member.guild.id);
  const due = Object.entries(rewards)
    .filter(([at]) => Number(at) <= level)
    .map(([, roleId]) => member.guild.roles.cache.get(roleId))
    .filter((role) => role?.editable && !member.roles.cache.has(role.id));
  if (!due.length) return [];
  return member.roles.add(due, `Reached level ${level}`).then(() => due, () => []);
}

async function announce(member, level, roles, where) {
  const { announce: mode, message } = levelSettings(member.guild.id);
  if (mode === 'off') return;
  const channel = mode === 'here' ? where : member.guild.channels.cache.get(mode);
  if (!channel?.isTextBased() || !channel.permissionsFor(member.guild.members.me)?.has('SendMessages')) return;
  // Only the member who levelled up is pinged, whatever the server's message says.
  const content = levelMessage(message, { member, level, roles });
  await channel.send({ content, allowedMentions: { users: [member.id] } }).catch(() => {});
}

/** Sets someone's XP (used by /levels setxp too), giving reward roles and announcing if they went up a level. */
export async function setXp(member, xp, where) {
  const data = levelsIn(member.guild.id);
  const rec = (data[member.id] ??= { xp: 0, lastMessageAt: 0 });
  const before = levelFromXp(rec.xp).level;
  rec.xp = Math.max(0, Math.round(xp));
  dirty.add(member.guild.id);
  const after = levelFromXp(rec.xp).level;
  if (after > before) {
    const roles = await applyRewards(member, after);
    if (where !== null) await announce(member, after, roles, where);
  }
  return after;
}

/** Whether this member earns XP in their server right now. */
const earns = (member) => member && !member.user.bot && levelSettings(member.guild.id).enabled && !isOptedOut(member.guild.id, member.id);

/** Stops counting someone who opted out of this server's statistics, and deletes their level there. */
export function forgetLevels(guildId, userId) {
  const data = levelsIn(guildId);
  if (!(userId in data)) return;
  delete data[userId];
  dirty.add(guildId);
}

/** One minute of voice: XP for everyone sitting with at least one other listening person. */
async function voiceTick(client) {
  for (const guild of client.guilds.cache.values()) {
    const { enabled, xp } = levelSettings(guild.id);
    if (!enabled || !xp.voicePerMinute) continue;
    const byChannel = new Map();
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channel || state.channelId === guild.afkChannelId || state.deaf || !earns(state.member)) continue;
      byChannel.set(state.channelId, [...(byChannel.get(state.channelId) ?? []), state.member]);
    }
    for (const [, members] of byChannel) {
      if (members.length < 2) continue;
      for (const member of members) {
        const rec = levelsIn(guild.id)[member.id];
        await setXp(member, (rec?.xp ?? 0) + xp.voicePerMinute, member.voice.channel);
      }
    }
  }
}

export function registerLevels(client) {
  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || message.system || !earns(message.member)) return;
    const rec = levelsIn(message.guildId)[message.author.id];
    const now = Date.now();
    const { messageMin: min, messageMax: max, cooldownSeconds } = levelSettings(message.guildId).xp;
    if (rec && now - rec.lastMessageAt < cooldownSeconds * 1000) return;
    if (!max) return;
    try {
      await setXp(message.member, (rec?.xp ?? 0) + min + Math.floor(Math.random() * (max - min + 1)), message.channel);
      levelsIn(message.guildId)[message.author.id].lastMessageAt = now;
    } catch (err) {
      console.error('Levels:', err);
    }
  });

  setInterval(() => voiceTick(client).catch((err) => console.error('Levels (voice):', err)), 60_000).unref();
  setInterval(save, SAVE_MS).unref();
  onShutdown(save);
}
