import { EmbedBuilder } from 'discord.js';
import { count, mirrorLog } from '../panel/analytics.js';
import { guildConfig } from './store.js';

export const COLORS = {
  ban: 0xd9534f,
  kick: 0xf0ad4e,
  timeout: 0xf7c948,
  warn: 0xfadb5f,
  filter: 0x9b59b6,
  undo: 0x5cb85c,
  info: 0x5865f2,
  join: 0x57f287,
  leave: 0x99aab5,
  delete: 0xed4245,
  edit: 0x3498db,
  ticket: 0x1abc9c,
  boost: 0xf47fff,
};

// Messages the bot deletes itself (word filter, /purge) already get their own log entry,
// so the generic "message deleted" log skips them.
const botDeleted = new Set();

export function markBotDeleted(ids) {
  for (const id of ids) {
    botDeleted.add(id);
    setTimeout(() => botDeleted.delete(id), 60_000).unref();
  }
}

export const wasBotDeleted = (id) => botDeleted.has(id);

/** Sends an embed to the server's log channel, if one is set with /config log. */
async function sendLog(guild, embed, files = []) {
  const channelId = guildConfig.get(guild.id, {}).logChannelId;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel
    .send({ embeds: [embed], files, allowedMentions: { parse: [] } })
    .catch((err) => console.warn(`Couldn't write to the log channel in ${guild.name}:`, err.message));
}

/** Logs a general event. `user` shows as the entry's author line with their avatar. */
export function logEvent(guild, { title, color = COLORS.info, description, fields = [], user, files, thumbnail }) {
  const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
  if (description) embed.setDescription(description);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (user) embed.setAuthor({ name: `${user.tag} (${user.id})`, iconURL: user.displayAvatarURL() });
  if (fields.length) embed.addFields(fields);
  toPanel(guild, { title, color, description, fields, user, files });
  return sendLog(guild, embed, files);
}

/** Replaces <@id>, <@&id> and <#id> with names, since the panel can't resolve mentions. */
function plainMentions(guild, text) {
  return text
    ?.replace(/<@!?(\d+)>/g, (m, id) => {
      const name = guild.members.cache.get(id)?.displayName ?? guild.client.users.cache.get(id)?.username;
      return name ? `@${name}` : m;
    })
    .replace(/<@&(\d+)>/g, (m, id) => (guild.roles.cache.get(id) ? `@${guild.roles.cache.get(id).name}` : m))
    .replace(/<#(\d+)>/g, (m, id) => (guild.channels.cache.get(id) ? `#${guild.channels.cache.get(id).name}` : m));
}

/** Copies the entry to the control panel's history and counts it for its analytics. */
function toPanel(guild, { title, color, description, fields, user, files }) {
  count(guild.id, 'events', title);
  const notes = files?.length ? [{ name: 'Attachments', value: `${files.map((f) => f.name).join(', ')} (in the Discord log channel)` }] : [];
  mirrorLog(guild.id, {
    title,
    color,
    user: user ? { id: user.id, tag: user.tag, avatar: user.displayAvatarURL({ size: 64 }) } : null,
    description: plainMentions(guild, description) ?? null,
    fields: [...fields, ...notes].map((f) => ({ name: f.name, value: plainMentions(guild, String(f.value)), inline: Boolean(f.inline) })),
  });
}

/** Turns a collection of messages into a .txt attachment, oldest first, for logging bulk deletions. */
export function transcriptFile(messages, name = 'deleted-messages.txt') {
  const lines = [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => {
      const attachments = m.attachments?.size ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]` : '';
      return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author?.tag ?? 'Unknown user'}: ${m.content || '(no text)'}${attachments}`;
    });
  return { attachment: Buffer.from(lines.join('\n'), 'utf8'), name };
}

/** Logs a moderation action against a user. */
export function logAction(guild, { action, color, target, moderator, reason, fields = [] }) {
  return logEvent(guild, {
    title: action,
    color,
    user: target,
    fields: [
      { name: 'User', value: `${target} (${target.id})`, inline: true },
      { name: 'Moderator', value: `${moderator}`, inline: true },
      { name: 'Reason', value: reason || 'No reason given' },
      ...fields,
    ],
  });
}
