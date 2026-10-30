import { EmbedBuilder, MessageFlags } from 'discord.js';
import { defaultColor } from './parse.js';

const TONES = { info: defaultColor, success: 0x57f287, warn: 0xfee75c, error: 0xed4245 };

/**
 * Wraps a bot reply or notice in an embed. `content` stays outside the embed, since only plain
 * content pings people. `private: true` makes an interaction reply visible only to its user.
 */
export function notice(text, { tone = 'info', title, content, private: isPrivate = false } = {}) {
  const embed = new EmbedBuilder().setColor(TONES[tone]).setDescription(text);
  if (title) embed.setTitle(title);
  return { content, embeds: [embed], ...(isPrivate && { flags: MessageFlags.Ephemeral }) };
}

/** A private reply, red by default since most are errors. With no text, just the flag (for deferReply). */
export const ephemeral = (text, tone = 'error') =>
  text === undefined ? { flags: MessageFlags.Ephemeral } : notice(text, { tone, private: true });

/** Reply text for actions that return `{ error }` on failure. */
export const outcome = (error, success) => (error ? notice(error, { tone: 'error' }) : notice(success, { tone: 'success' }));
