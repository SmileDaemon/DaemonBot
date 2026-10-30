import {
  AuditLogEvent,
  ChannelType,
  Events,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildVerificationLevel,
  StickerFormatType,
} from 'discord.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { isTicketChannel } from '../tickets.js';
import { byBot, byField, diffFields, findAuditEntry, overwriteChanges, permissionChanges, truncate } from './helpers.js';

const CHANNEL_AUDIT = new Set([
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete,
]);
const WEBHOOK_TITLES = {
  [AuditLogEvent.WebhookCreate]: 'Webhook created',
  [AuditLogEvent.WebhookUpdate]: 'Webhook updated',
  [AuditLogEvent.WebhookDelete]: 'Webhook deleted',
};

const channelType = (channel) => (ChannelType[channel.type] ?? 'Channel').replace(/^Guild/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
const seconds = (s) => (s ? `${s}s` : 'off');
const lines = (list) => truncate(list.join('\n'));

export function registerServerStructureLogs(client, on) {
  // Channels (threads have their own events and aren't logged here; tickets log their own opening and closing)
  on(Events.ChannelCreate, async (channel) => {
    if (!channel.guild) return;
    const entry = await findAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    if (byBot(entry, client) && isTicketChannel(channel)) return;
    return logEvent(channel.guild, {
      title: 'Channel created',
      color: COLORS.join,
      fields: [
        { name: 'Channel', value: `${channel} (${channel.name})`, inline: true },
        { name: 'Type', value: channelType(channel), inline: true },
        ...(channel.parent ? [{ name: 'Category', value: channel.parent.name, inline: true }] : []),
        ...byField(entry),
      ],
    });
  });

  on(Events.ChannelDelete, async (channel) => {
    if (!channel.guild) return;
    const entry = await findAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    return logEvent(channel.guild, {
      title: 'Channel deleted',
      color: COLORS.delete,
      fields: [
        { name: 'Channel', value: `#${channel.name}`, inline: true },
        { name: 'Type', value: channelType(channel), inline: true },
        ...(channel.parent ? [{ name: 'Category', value: channel.parent.name, inline: true }] : []),
        ...byField(entry),
      ],
    });
  });

  on(Events.ChannelUpdate, async (before, after) => {
    if (!after.guild || before.partial) return;
    const fields = diffFields([
      ['Name', before.name, after.name],
      ['Topic', before.topic, after.topic],
      ['Category', before.parent?.name, after.parent?.name],
      ['Age-restricted', before.nsfw, after.nsfw],
      ['Slowmode', seconds(before.rateLimitPerUser), seconds(after.rateLimitPerUser)],
      ['Bitrate', before.bitrate, after.bitrate],
      ['User limit', before.userLimit, after.userLimit],
    ]);
    const overwrites = overwriteChanges(before, after, after.guild);
    if (overwrites.length) fields.push({ name: 'Permissions (✅ allow · ❌ deny · ➖ inherit)', value: lines(overwrites) });
    if (!fields.length) return; // e.g. only its position in the list moved

    const entry = await findAuditEntry(after.guild, undefined, (e) => e.targetId === after.id && CHANNEL_AUDIT.has(e.action));
    if (byBot(entry, client)) return; // /channel lock/unlock/slowmode and /ticket setup log their own changes
    return logEvent(after.guild, {
      title: 'Channel updated',
      color: COLORS.edit,
      description: `${after}`,
      fields: [...fields, ...byField(entry)],
    });
  });

  // Roles
  on(Events.GuildRoleCreate, async (role) => {
    const entry = await findAuditEntry(role.guild, AuditLogEvent.RoleCreate, role.id);
    return logEvent(role.guild, {
      title: 'Role created',
      color: COLORS.join,
      fields: [
        { name: 'Role', value: `${role} (${role.name})`, inline: true },
        ...(role.managed ? [{ name: 'Managed by', value: 'An integration or bot', inline: true }] : []),
        ...byField(entry),
      ],
    });
  });

  on(Events.GuildRoleDelete, async (role) => {
    const entry = await findAuditEntry(role.guild, AuditLogEvent.RoleDelete, role.id);
    return logEvent(role.guild, {
      title: 'Role deleted',
      color: COLORS.delete,
      fields: [{ name: 'Role', value: `@${role.name}`, inline: true }, { name: 'Color', value: role.hexColor, inline: true }, ...byField(entry)],
    });
  });

  on(Events.GuildRoleUpdate, async (before, after) => {
    const fields = diffFields([
      ['Name', before.name, after.name],
      ['Color', before.hexColor, after.hexColor],
      ['Shown separately', before.hoist, after.hoist],
      ['Mentionable by anyone', before.mentionable, after.mentionable],
      ['Icon', before.icon ?? before.unicodeEmoji, after.icon ?? after.unicodeEmoji],
    ]);
    const perms = permissionChanges(before.permissions, after.permissions);
    if (perms.length) fields.push({ name: 'Permissions', value: lines(perms) });
    if (!fields.length) return; // e.g. only its position moved

    const entry = await findAuditEntry(after.guild, AuditLogEvent.RoleUpdate, after.id);
    return logEvent(after.guild, {
      title: 'Role updated',
      color: COLORS.edit,
      description: `${after}`,
      fields: [...fields, ...byField(entry)],
    });
  });

  // Server settings
  on(Events.GuildUpdate, async (before, after) => {
    const fields = diffFields([
      ['Name', before.name, after.name],
      ['Description', before.description, after.description],
      ['Owner', before.ownerId && `<@${before.ownerId}>`, after.ownerId && `<@${after.ownerId}>`],
      ['Verification level', GuildVerificationLevel[before.verificationLevel], GuildVerificationLevel[after.verificationLevel]],
      ['Explicit media filter', GuildExplicitContentFilter[before.explicitContentFilter], GuildExplicitContentFilter[after.explicitContentFilter]],
      ['Default notifications', GuildDefaultMessageNotifications[before.defaultMessageNotifications], GuildDefaultMessageNotifications[after.defaultMessageNotifications]],
      ['2FA for moderators', GuildMFALevel[before.mfaLevel], GuildMFALevel[after.mfaLevel]],
      ['System messages channel', before.systemChannelId && `<#${before.systemChannelId}>`, after.systemChannelId && `<#${after.systemChannelId}>`],
      ['Rules channel', before.rulesChannelId && `<#${before.rulesChannelId}>`, after.rulesChannelId && `<#${after.rulesChannelId}>`],
      ['AFK channel', before.afkChannelId && `<#${before.afkChannelId}>`, after.afkChannelId && `<#${after.afkChannelId}>`],
      ['AFK timeout', seconds(before.afkTimeout), seconds(after.afkTimeout)],
      ['Vanity URL', before.vanityURLCode, after.vanityURLCode],
      ['Language', before.preferredLocale, after.preferredLocale],
      ['Boost progress bar', before.premiumProgressBarEnabled, after.premiumProgressBarEnabled],
    ]);
    const images = [
      before.icon !== after.icon && 'Icon',
      before.banner !== after.banner && 'Banner',
      before.splash !== after.splash && 'Invite background',
    ].filter(Boolean);
    if (images.length) fields.push({ name: 'Images changed', value: images.join(', ') });
    if (!fields.length) return; // e.g. only the boost count changed

    const entry = await findAuditEntry(after, AuditLogEvent.GuildUpdate, after.id);
    return logEvent(after, {
      title: 'Server settings changed',
      color: COLORS.edit,
      thumbnail: before.icon !== after.icon ? after.iconURL() : undefined,
      fields: [...fields, ...byField(entry)],
    });
  });

  // Emojis and stickers
  const expression = (kind, created, color, auditType) => async (item) => {
    const entry = await findAuditEntry(item.guild, auditType, item.id);
    return logEvent(item.guild, {
      title: `${kind} ${created}`,
      color,
      thumbnail: item.url ?? item.imageURL?.(),
      fields: [{ name: 'Name', value: `:${item.name}:`, inline: true }, ...byField(entry)],
    });
  };
  on(Events.GuildEmojiCreate, expression('Emoji', 'added', COLORS.join, AuditLogEvent.EmojiCreate));
  on(Events.GuildEmojiDelete, expression('Emoji', 'deleted', COLORS.delete, AuditLogEvent.EmojiDelete));
  on(Events.GuildStickerCreate, expression('Sticker', 'added', COLORS.join, AuditLogEvent.StickerCreate));
  on(Events.GuildStickerDelete, expression('Sticker', 'deleted', COLORS.delete, AuditLogEvent.StickerDelete));

  on(Events.GuildEmojiUpdate, async (before, after) => {
    const fields = diffFields([
      ['Name', before.name, after.name],
      ['Roles allowed', before.roles.cache.map((r) => `${r}`).join(' '), after.roles.cache.map((r) => `${r}`).join(' ')],
    ]);
    if (!fields.length) return;
    const entry = await findAuditEntry(after.guild, AuditLogEvent.EmojiUpdate, after.id);
    return logEvent(after.guild, { title: 'Emoji updated', color: COLORS.edit, thumbnail: after.imageURL(), fields: [...fields, ...byField(entry)] });
  });

  on(Events.GuildStickerUpdate, async (before, after) => {
    if (before.partial) return;
    const fields = diffFields([
      ['Name', before.name, after.name],
      ['Description', before.description, after.description],
      ['Related emoji', before.tags, after.tags],
    ]);
    if (!fields.length) return;
    const entry = await findAuditEntry(after.guild, AuditLogEvent.StickerUpdate, after.id);
    return logEvent(after.guild, {
      title: 'Sticker updated',
      color: COLORS.edit,
      thumbnail: after.format === StickerFormatType.Lottie ? undefined : after.url,
      fields: [...fields, ...byField(entry)],
    });
  });

  // Webhooks: Discord only says "something changed in this channel", so the details come from the audit log.
  const loggedWebhookEntries = new Set();
  on(Events.WebhooksUpdate, async (channel) => {
    const logs = await new Promise((r) => setTimeout(r, 1500))
      .then(() => channel.guild.fetchAuditLogs({ limit: 10 }))
      .catch(() => null);
    const entries = logs?.entries.filter(
      (e) => e.targetType === 'Webhook' && Date.now() - e.createdTimestamp < 15_000 && !loggedWebhookEntries.has(e.id),
    );
    for (const entry of entries?.values() ?? []) {
      loggedWebhookEntries.add(entry.id);
      setTimeout(() => loggedWebhookEntries.delete(entry.id), 60_000).unref();
      const nameChange = entry.changes.find((c) => c.key === 'name');
      await logEvent(channel.guild, {
        title: WEBHOOK_TITLES[entry.action] ?? 'Webhook changed',
        color: entry.action === AuditLogEvent.WebhookDelete ? COLORS.delete : entry.action === AuditLogEvent.WebhookCreate ? COLORS.join : COLORS.edit,
        fields: [
          { name: 'Webhook', value: entry.target?.name ?? nameChange?.new ?? nameChange?.old ?? 'Unknown', inline: true },
          { name: 'Channel', value: `${channel}`, inline: true },
          ...byField(entry),
          ...(entry.action === AuditLogEvent.WebhookUpdate
            ? diffFields(entry.changes.map((c) => [c.key, c.key === 'channel_id' ? c.old && `<#${c.old}>` : c.old, c.key === 'channel_id' ? c.new && `<#${c.new}>` : c.new]))
            : []),
        ],
      });
    }
  });
}
