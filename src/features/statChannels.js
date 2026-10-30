import { ChannelType, Events, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { guildConfig } from '../utils/store.js';

const CATEGORY_NAME = 'Server Statistics';
export const MAX_STATS = 10;
export const MAX_NAME = 80;

const CHECK_MS = 30_000;
// Discord allows 2 renames per channel every 10 minutes, so a count can lag by up to this long.
const RENAME_EVERY_MS = 5 * 60_000 + 5_000;

const humans = (guild) => guild.members.cache.filter((m) => !m.user.bot);

/** What a stat channel can count. Listed in this order in the control panel. */
export const STAT_TYPES = {
  members: { label: 'All members', name: 'Members: {count}', count: (guild) => guild.memberCount },
  humans: { label: 'Members without bots', name: 'Humans: {count}', count: (guild) => humans(guild).size },
  bots: { label: 'Bots', name: 'Bots: {count}', count: (guild) => guild.members.cache.filter((m) => m.user.bot).size },
  role: { label: 'Members with a role', name: '{role}: {count}', role: true, count: (guild, roleId) => guild.roles.cache.get(roleId)?.members.size ?? 0 },
  online: {
    label: 'Members online',
    name: 'Online: {count}',
    available: () => process.env.ENABLE_GAME_TRACKING === 'true', // the only feature that requests presence
    count: (guild) => guild.presences.cache.filter((p) => p.status !== 'offline' && !p.member?.user.bot).size,
  },
  voice: { label: 'Members in voice', name: 'In voice: {count}', count: (guild) => guild.voiceStates.cache.filter((v) => v.channelId && !v.member?.user.bot).size },
  boosts: { label: 'Server boosts', name: 'Boosts: {count}', count: (guild) => guild.premiumSubscriptionCount ?? 0 },
  channels: { label: 'Channels', name: 'Channels: {count}', count: (guild) => guild.channels.cache.filter((c) => !c.isThread() && c.type !== ChannelType.GuildCategory).size },
  roles: { label: 'Roles', name: 'Roles: {count}', count: (guild) => guild.roles.cache.size - 1 }, // not @everyone
};

const typeOffered = ([, t]) => t.available?.() ?? true;
export const statTypeOffered = (type) => Boolean(STAT_TYPES[type]) && typeOffered([type, STAT_TYPES[type]]);

const configOf = (guildId) => guildConfig.get(guildId, {}).statChannels ?? { categoryId: null, stats: [] };

function saveConfig(guildId, statChannels) {
  guildConfig.set(guildId, { ...guildConfig.get(guildId, {}), statChannels });
}

/** The channel name a stat should have right now. */
function statName(guild, stat) {
  const count = STAT_TYPES[stat.type].count(guild, stat.roleId).toLocaleString('en-US');
  const role = guild.roles.cache.get(stat.roleId)?.name ?? '';
  return stat.name.replaceAll('{count}', count).replaceAll('{role}', role).slice(0, 100);
}

/** Everyone sees the channels; nobody can join them. */
const lockedChannel = (guild) => [
  { id: guild.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
  { id: guild.members.me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] },
];

/** A server's stat channels and what can be added, for the control panel. */
export function statSettings(guild) {
  return {
    stats: configOf(guild.id).stats.map((s) => ({ ...s, current: guild.channels.cache.get(s.channelId)?.name ?? null })),
    types: Object.entries(STAT_TYPES)
      .filter(typeOffered)
      .map(([type, t]) => ({ type, label: t.label, name: t.name, role: Boolean(t.role) })),
  };
}

const saving = new Set(); // guilds whose channels are being changed; the regular check waits for them
const membersLoaded = new Set();
const lastRename = new Map(); // channel ID -> when it was last renamed

/**
 * Makes a server's stat channels match `wanted`: [{ type, roleId, name, channelId }], where channelId
 * is an existing stat channel to keep. Creates the category on first use and removes it with the last stat.
 */
export async function saveStatChannels(guild, wanted) {
  saving.add(guild.id);
  try {
    await guild.members.fetch().catch(() => {});
    const saved = configOf(guild.id);
    const existing = new Set(saved.stats.map((s) => s.channelId));
    const keep = new Set(wanted.map((s) => s.channelId).filter((id) => existing.has(id)));
    const removed = saved.stats.filter((s) => !keep.has(s.channelId));
    for (const stat of removed) await guild.channels.cache.get(stat.channelId)?.delete('Removed in the control panel');

    let category = guild.channels.cache.get(saved.categoryId);
    if (!wanted.length) {
      // Only if it's empty: someone may have moved their own channels into it.
      if (category && !guild.channels.cache.some((c) => c.parentId === category.id)) await category.delete('No stat channels left');
      saveConfig(guild.id, { categoryId: null, stats: [] });
      return { added: 0, removed: removed.length };
    }
    category ??= await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      position: 0,
      permissionOverwrites: lockedChannel(guild),
      reason: 'Stat channels set up in the control panel',
    });

    const stats = [];
    let added = 0;
    for (const { type, roleId, name, channelId } of wanted) {
      const stat = { type, roleId: roleId ?? null, name };
      let channel = keep.has(channelId) ? guild.channels.cache.get(channelId) : null;
      if (!channel) {
        channel = await guild.channels.create({
          name: statName(guild, stat),
          type: ChannelType.GuildVoice,
          parent: category.id,
          permissionOverwrites: lockedChannel(guild),
          reason: 'Stat channels set up in the control panel',
        });
        lastRename.set(channel.id, Date.now());
        added += 1;
      } else if (channel.parentId !== category.id) {
        await channel.setParent(category.id, { lockPermissions: false }); // the category was deleted and made again
      }
      stats.push({ ...stat, channelId: channel.id });
    }
    saveConfig(guild.id, { categoryId: category.id, stats });
    return { added, removed: removed.length };
  } finally {
    saving.delete(guild.id);
  }
}

function rename(channel, name) {
  lastRename.set(channel.id, Date.now());
  channel.setName(name, 'Stat channel update').catch((err) => console.error(`Stat channel ${channel.id} in ${channel.guild.id}:`, err.message));
}

/** Brings one server's stat channels up to date, as far as Discord's limit on renames allows. */
async function refresh(guild) {
  const saved = configOf(guild.id);
  if (!saved.stats.length || !guild.available || saving.has(guild.id)) return;

  // Counts by member or role need the full member list; after that, Discord keeps it current.
  if (!membersLoaded.has(guild.id)) {
    await guild.members.fetch();
    membersLoaded.add(guild.id);
  }

  // A channel deleted in Discord stays deleted: that stat is simply gone.
  const stats = saved.stats.filter((s) => guild.channels.cache.has(s.channelId));
  // So is a stat counting a role that no longer exists.
  const live = stats.filter((s) => !STAT_TYPES[s.type].role || guild.roles.cache.has(s.roleId));
  for (const stat of stats) {
    if (!live.includes(stat)) await guild.channels.cache.get(stat.channelId)?.delete('The role it counted was deleted').catch(() => {});
  }
  if (live.length !== saved.stats.length) saveConfig(guild.id, { ...saved, stats: live });

  for (const stat of live) {
    const channel = guild.channels.cache.get(stat.channelId);
    const name = statName(guild, stat);
    if (channel.name !== name && Date.now() - (lastRename.get(channel.id) ?? 0) >= RENAME_EVERY_MS) rename(channel, name);
  }
}

export function registerStatChannels(client) {
  const check = () => {
    for (const guild of client.guilds.cache.values()) refresh(guild).catch((err) => console.error(`Stat channels in ${guild.id}:`, err.message));
  };
  client.once(Events.ClientReady, () => {
    check();
    setInterval(check, CHECK_MS).unref();
  });
}
