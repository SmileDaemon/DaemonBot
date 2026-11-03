import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { backups } from '../utils/store.js';
import { isTempVoiceChannel } from './tempVoice.js';

// Copies of each server's channels, roles and their permissions, so ones a raid or nuke deleted can be made
// again. Messages aren't kept, so they can't come back.

const KEEP = 10;
export const BACKUP_EVERY_MS = 24 * 60 * 60_000;

const listOf = (guildId) => backups.get(guildId, []);

/** A copy of the server's structure now. Temporary voice channels come and go, so they're left out. */
function snapshot(guild, reason) {
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed)
    .map((r) => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.position }));
  const channels = guild.channels.cache
    .filter((c) => !c.isThread() && !isTempVoiceChannel(c))
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      parentId: c.parentId ?? null,
      position: c.rawPosition ?? c.position ?? 0,
      topic: c.topic ?? null,
      nsfw: Boolean(c.nsfw),
      rateLimitPerUser: c.rateLimitPerUser ?? 0,
      bitrate: c.bitrate ?? null,
      userLimit: c.userLimit ?? null,
      overwrites: c.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })),
    }));
  return { at: Date.now(), reason, everyone: guild.roles.everyone.permissions.bitfield.toString(), roles, channels };
}

/** Saves a backup now, keeping the newest ten. `reason`: 'scheduled', 'raid', 'nuke' or 'manual'. */
export function takeBackup(guild, reason) {
  const backup = snapshot(guild, reason);
  backups.set(guild.id, [backup, ...listOf(guild.id)].slice(0, KEEP));
  return backup;
}

export const latestBackup = (guildId) => listOf(guildId)[0] ?? null;

/** Roles and channels in the latest backup that the server no longer has. */
function missing(guild, backup) {
  if (!backup) return { roles: [], channels: [] };
  return {
    roles: backup.roles.filter((r) => !guild.roles.cache.has(r.id)),
    channels: backup.channels.filter((c) => !guild.channels.cache.has(c.id)),
  };
}

/** For the control panel. */
export function backupStats(guild) {
  const list = listOf(guild.id);
  const gone = missing(guild, list[0]);
  return {
    count: list.length,
    list: list.map((b) => ({ at: b.at, reason: b.reason, roles: b.roles.length, channels: b.channels.length })),
    missing: { roles: gone.roles.map((r) => r.name), channels: gone.channels.map((c) => c.name) },
  };
}

/** The bot can only hand out permissions it has itself, unless it's an administrator. */
function grantable(guild, bits) {
  const me = guild.members.me.permissions;
  const wanted = new PermissionsBitField(BigInt(bits));
  return me.has(PermissionFlagsBits.Administrator) ? wanted : new PermissionsBitField(wanted.bitfield & me.bitfield);
}

const RESTORABLE = new Set([ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum]);

/**
 * Makes again the roles and channels from the latest backup that are gone, with their permissions. Categories
 * come first so channels go back into them. Returns { roles, channels, failed } counts.
 */
export async function restoreBackup(guild) {
  const backup = latestBackup(guild.id);
  if (!backup) return null;
  const gone = missing(guild, backup);
  const newIds = new Map(); // backed-up ID -> the ID of what was made in its place
  const id = (old) => newIds.get(old) ?? old;
  const result = { roles: 0, channels: 0, failed: 0 };
  const reason = 'Restored from backup';

  for (const r of gone.roles.sort((a, b) => b.position - a.position)) {
    try {
      const role = await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: grantable(guild, r.permissions), reason });
      newIds.set(r.id, role.id);
      result.roles += 1;
    } catch {
      result.failed += 1;
    }
  }

  const channels = gone.channels.filter((c) => RESTORABLE.has(c.type));
  const ordered = [...channels.filter((c) => c.type === ChannelType.GuildCategory), ...channels.filter((c) => c.type !== ChannelType.GuildCategory)];
  for (const c of ordered) {
    const overwrites = (allowMembers) =>
      c.overwrites
        .filter((o) => allowMembers || o.type === 0)
        .map((o) => ({ id: id(o.id), type: o.type, allow: grantable(guild, o.allow), deny: grantable(guild, o.deny) }))
        .filter((o) => o.type === 1 || guild.roles.cache.has(o.id));
    const options = {
      name: c.name,
      type: c.type,
      parent: c.parentId && guild.channels.cache.has(id(c.parentId)) ? id(c.parentId) : null,
      topic: c.topic ?? undefined,
      nsfw: c.nsfw,
      rateLimitPerUser: c.rateLimitPerUser || undefined,
      bitrate: c.bitrate ?? undefined,
      userLimit: c.userLimit ?? undefined,
      position: c.position,
      reason,
    };
    try {
      // Members who have left can't have permissions set, so try again without them.
      const made = await guild.channels.create({ ...options, permissionOverwrites: overwrites(true) }).catch(() =>
        guild.channels.create({ ...options, permissionOverwrites: overwrites(false) }),
      );
      newIds.set(c.id, made.id);
      result.channels += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
