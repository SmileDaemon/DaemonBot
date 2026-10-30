import { notice } from './replies.js';

export { COLORS, logAction } from './logging.js';
export { ephemeral, notice } from './replies.js';

/**
 * Returns an error message if the invoking moderator (or the bot) can't act on `member`, otherwise null.
 * Enforces Discord's role hierarchy so moderators can't punish people above them.
 */
export function checkTarget(interaction, member, action) {
  if (!member) return 'That user is not in this server.';
  const { guild, member: moderator, client } = interaction;

  if (member.id === moderator.id) return `You can't ${action} yourself.`;
  if (member.id === guild.ownerId) return `You can't ${action} the server owner.`;
  if (member.id === client.user.id) return `I can't ${action} myself.`;
  if (moderator.id !== guild.ownerId && member.roles.highest.position >= moderator.roles.highest.position) {
    return `You can't ${action} someone whose highest role is equal to or above yours.`;
  }
  if (member.roles.highest.position >= guild.members.me.roles.highest.position) {
    return `My role is too low to ${action} that user. Move my role above theirs in Server Settings → Roles.`;
  }
  return null;
}

/** DMs a user about a moderation action. Silently ignores users with DMs closed. */
export async function notifyUser(user, message) {
  await user.send(notice(message, { tone: 'warn' })).catch(() => {});
}
