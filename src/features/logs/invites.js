import { AuditLogEvent, Events, PermissionFlagsBits, time } from 'discord.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { byField, findAuditEntry } from './helpers.js';

// guildId -> Map(code -> { code, uses, maxUses, inviterId, channelId })
const cache = new Map();

const snapshot = (invite) => ({
  code: invite.code,
  uses: invite.uses ?? 0,
  maxUses: invite.maxUses ?? 0,
  inviterId: invite.inviterId ?? invite.inviter?.id ?? null,
  channelId: invite.channelId ?? invite.channel?.id ?? null,
});

/** Fetching invites (and so knowing use counts) needs Manage Server. Returns null without it. */
async function fetchInvites(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const invites = await guild.invites.fetch({ cache: false }).catch(() => null);
  return invites && new Map(invites.map((i) => [i.code, snapshot(i)]));
}

async function refresh(guild) {
  const invites = await fetchInvites(guild);
  if (invites) cache.set(guild.id, invites);
  return invites;
}

/**
 * Works out which invite a new member used by comparing use counts with the cached ones.
 * Returns { invite, uses } or { vanity: true } or null when it can't tell.
 */
async function findUsedInvite(guild) {
  const before = cache.get(guild.id);
  const after = await refresh(guild);
  if (!before || !after) return null;

  const increased = [...after.values()].filter((i) => i.uses > (before.get(i.code)?.uses ?? 0));
  if (increased.length === 1) return { invite: increased[0], uses: increased[0].uses };

  // Invites with a use limit are deleted the moment they're used up, so the used one may have vanished.
  const usedUp = [...before.values()].filter((i) => !after.has(i.code) && i.maxUses && i.uses + 1 >= i.maxUses);
  if (increased.length === 0 && usedUp.length === 1) return { invite: usedUp[0], uses: usedUp[0].uses + 1 };

  if (increased.length === 0 && usedUp.length === 0 && guild.vanityURLCode) return { vanity: true };
  return null;
}

/** Embed field describing how a member joined, for the "Member joined" log. */
export async function inviteField(guild) {
  const used = await findUsedInvite(guild);
  let value;
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) value = 'Unknown (I need Manage Server to track invites)';
  else if (!used) value = 'Unknown';
  else if (used.vanity) value = `Vanity URL (discord.gg/${guild.vanityURLCode})`;
  else {
    const { invite, uses } = used;
    value =
      `\`${invite.code}\` by ${invite.inviterId ? `<@${invite.inviterId}>` : 'unknown'}` +
      (invite.channelId ? ` in <#${invite.channelId}>` : '') +
      ` · ${uses}${invite.maxUses ? `/${invite.maxUses}` : ''} use${uses === 1 ? '' : 's'}`;
  }
  return { name: 'Invite used', value };
}

export function registerInviteLogs(client, on) {
  client.once(Events.ClientReady, () => Promise.all(client.guilds.cache.map(refresh)));
  on(Events.GuildCreate, refresh);
  on(Events.GuildDelete, (guild) => cache.delete(guild.id));

  on(Events.InviteCreate, async (invite) => {
    if (!invite.guild) return;
    cache.get(invite.guild.id)?.set(invite.code, snapshot(invite));
    const inviter = invite.inviter;
    return logEvent(invite.guild, {
      title: 'Invite created',
      color: COLORS.join,
      user: inviter,
      fields: [
        { name: 'Code', value: `\`${invite.code}\``, inline: true },
        { name: 'Created by', value: inviter ? `${inviter}` : 'Unknown', inline: true },
        { name: 'Channel', value: invite.channelId ? `<#${invite.channelId}>` : 'Unknown', inline: true },
        { name: 'Max uses', value: invite.maxUses ? String(invite.maxUses) : 'Unlimited', inline: true },
        { name: 'Expires', value: invite.expiresAt ? time(invite.expiresAt, 'R') : 'Never', inline: true },
        ...(invite.temporary ? [{ name: 'Temporary', value: 'Members are kicked when they go offline unless given a role', inline: true }] : []),
      ],
    });
  });

  on(Events.InviteDelete, async (invite) => {
    if (!invite.guild) return;
    const guild = client.guilds.cache.get(invite.guild.id) ?? invite.guild;
    const known = cache.get(guild.id)?.get(invite.code);
    // Keep it cached briefly: a used-up invite is deleted around the same time its last member joins.
    setTimeout(() => cache.get(guild.id)?.delete(invite.code), 10_000).unref();

    const entry = await findAuditEntry(guild, AuditLogEvent.InviteDelete, (e) => e.target?.code === invite.code);
    const usedUp = !entry && known?.maxUses && known.uses + 1 >= known.maxUses;
    return logEvent(guild, {
      title: 'Invite deleted',
      color: COLORS.delete,
      fields: [
        { name: 'Code', value: `\`${invite.code}\``, inline: true },
        { name: 'Created by', value: known?.inviterId ? `<@${known.inviterId}>` : 'Unknown', inline: true },
        { name: 'Channel', value: invite.channelId ? `<#${invite.channelId}>` : 'Unknown', inline: true },
        {
          name: 'Times used',
          value: known ? `${usedUp ? known.maxUses : known.uses}${known.maxUses ? `/${known.maxUses}` : ''}` : 'Unknown',
          inline: true,
        },
        ...(entry ? byField(entry) : [{ name: 'Why', value: usedUp ? 'Reached its use limit' : 'Expired, or deleted by someone I couldn\'t see', inline: true }]),
      ],
    });
  });
}
