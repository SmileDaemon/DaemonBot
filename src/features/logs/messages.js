import { AuditLogEvent, Events, time } from 'discord.js';
import { COLORS, logEvent, transcriptFile, wasBotDeleted } from '../../utils/logging.js';
import { findAuditEntry, truncate } from './helpers.js';

// Discord merges repeated deletions (same moderator, author and channel) into one audit entry and bumps its
// count instead of adding a new entry, so remember each entry's last count to spot when it went up.
const deleteCounts = new Map();

/** Who deleted someone else's message, or null when the author (or nobody we can see) did. */
async function findDeleter(message) {
  if (!message.author) return null;
  const entry = await findAuditEntry(
    message.guild,
    AuditLogEvent.MessageDelete,
    (e) => e.targetId === message.author.id && e.extra?.channel?.id === message.channelId,
    { within: Infinity },
  );
  if (!entry) return null;
  const count = entry.extra.count ?? 1;
  const previous = deleteCounts.get(entry.id);
  deleteCounts.set(entry.id, count);
  const isNew = previous === undefined && Date.now() - entry.createdTimestamp < 15_000;
  return isNew || (previous !== undefined && count > previous) ? entry.executor : null;
}

export function registerMessageLogs(client, on) {
  on(Events.MessageUpdate, async (before, after) => {
    if (!after.guild || after.author?.bot || wasBotDeleted(after.id)) return;
    // Embeds loading in (link previews) also fire this event, without the text changing.
    if (!before.partial && before.content === after.content) return;
    if (after.partial) after = await after.fetch().catch(() => null);
    if (!after || after.author.bot) return;

    return logEvent(after.guild, {
      title: 'Message edited',
      color: COLORS.edit,
      user: after.author,
      description: `[Jump to message](${after.url})`,
      fields: [
        {
          name: 'Before',
          value: before.partial ? "*Sent before I started watching, so I don't have the original.*" : truncate(before.content || '*[no text]*'),
        },
        { name: 'After', value: truncate(after.content || '*[no text]*') },
        { name: 'Channel', value: `<#${after.channelId}>`, inline: true },
        { name: 'Sent', value: time(after.createdAt, 'R'), inline: true },
      ],
    });
  });

  on(Events.MessageDelete, async (message) => {
    if (!message.guild || wasBotDeleted(message.id) || message.author?.bot) return;
    // Messages sent before the bot started (or long ago) aren't cached, so their content is unknown.
    const content = message.partial
      ? "*Sent before I started watching, so I don't have its content.*"
      : truncate(message.content || '*[no text]*', 4000);
    const attachments = message.attachments?.map((a) => a.name) ?? [];
    const deleter = await findDeleter(message);
    return logEvent(message.guild, {
      title: 'Message deleted',
      color: COLORS.delete,
      user: message.author,
      description: content,
      fields: [
        { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
        { name: 'Sent', value: time(message.createdAt, 'R'), inline: true },
        { name: 'Deleted by', value: deleter ? `${deleter}` : message.author ? 'Probably the author' : 'Unknown', inline: true },
        ...(attachments.length ? [{ name: 'Attachments', value: truncate(attachments.join('\n')) }] : []),
      ],
    });
  });

  on(Events.MessageBulkDelete, (messages, channel) => {
    const logged = messages.filter((m) => !wasBotDeleted(m.id));
    if (!logged.size) return;
    return logEvent(channel.guild, {
      title: 'Messages bulk deleted',
      color: COLORS.delete,
      fields: [
        { name: 'Channel', value: `${channel}`, inline: true },
        { name: 'Count', value: String(logged.size), inline: true },
      ],
      files: [transcriptFile(logged)],
    });
  });
}
