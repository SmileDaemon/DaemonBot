import { AuditLogEvent, Events, time } from 'discord.js';
import { COLORS, logAction, logEvent } from '../../utils/logging.js';
import { byBot, findAuditEntry, truncate } from './helpers.js';
import { inviteField } from './invites.js';

const roleList = (member) => member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => `${r}`);

export function registerMemberLogs(client, on) {
  // Members who were in the server before the bot started aren't cached, so their updates would arrive
  // without a "before" to compare against. Fetching everyone once at startup fixes that.
  client.once(Events.ClientReady, () =>
    Promise.all(client.guilds.cache.map((g) => g.members.fetch().catch((err) => console.warn(`Couldn't fetch members of ${g.name}:`, err.message)))),
  );

  on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) {
      const entry = await findAuditEntry(member.guild, AuditLogEvent.BotAdd, member.id);
      return logEvent(member.guild, {
        title: 'Bot added',
        color: COLORS.join,
        user: member.user,
        fields: [{ name: 'Added by', value: entry ? `${entry.executor}` : 'Unknown', inline: true }],
      });
    }
    return logEvent(member.guild, {
      title: 'Member joined',
      color: COLORS.join,
      user: member.user,
      fields: [
        { name: 'Account created', value: `${time(member.user.createdAt, 'D')} (${time(member.user.createdAt, 'R')})`, inline: true },
        { name: 'Member count', value: String(member.guild.memberCount), inline: true },
        await inviteField(member.guild),
      ],
    });
  });

  on(Events.GuildMemberRemove, async (member) => {
    const { guild } = member;
    const roles = member.partial ? [] : roleList(member);
    const details = [
      { name: 'Joined', value: member.joinedAt ? time(member.joinedAt, 'R') : 'Unknown', inline: true },
      { name: 'Member count', value: String(guild.memberCount), inline: true },
      ...(roles.length ? [{ name: 'Roles', value: truncate(roles.join(' ')) }] : []),
    ];

    const [kick, ban] = await Promise.all([
      findAuditEntry(guild, AuditLogEvent.MemberKick, member.id),
      findAuditEntry(guild, AuditLogEvent.MemberBanAdd, member.id),
    ]);
    if (ban) return; // the ban log covers it
    if (kick) {
      if (byBot(kick, client)) return; // /kick already logged it
      return logAction(guild, {
        action: 'Member kicked',
        color: COLORS.kick,
        target: member.user,
        moderator: kick.executor,
        reason: kick.reason,
        fields: details,
      });
    }
    return logEvent(guild, { title: 'Member left', color: COLORS.leave, user: member.user, fields: details });
  });

  on(Events.GuildMemberUpdate, async (before, after) => {
    if (before.partial) return;
    const { guild, user } = after;

    if (before.nickname !== after.nickname) {
      await logEvent(guild, {
        title: 'Nickname changed',
        color: COLORS.edit,
        user,
        fields: [
          { name: 'Before', value: before.nickname ?? '*none*', inline: true },
          { name: 'After', value: after.nickname ?? '*none*', inline: true },
        ],
      });
    }

    const wasTimedOut = before.communicationDisabledUntilTimestamp > Date.now();
    const untilChanged = before.communicationDisabledUntilTimestamp !== after.communicationDisabledUntilTimestamp;
    if (untilChanged && (after.isCommunicationDisabled() || wasTimedOut)) {
      const entry = await findAuditEntry(guild, AuditLogEvent.MemberUpdate, (e) =>
        e.targetId === user.id && e.changes.some((c) => c.key === 'communication_disabled_until'),
      );
      if (!byBot(entry, client)) {
        const applied = after.isCommunicationDisabled();
        await logAction(guild, {
          action: applied ? 'Member timed out' : 'Timeout removed',
          color: applied ? COLORS.timeout : COLORS.undo,
          target: user,
          moderator: entry?.executor ?? 'Unknown',
          reason: entry?.reason,
          fields: applied ? [{ name: 'Until', value: `${time(after.communicationDisabledUntil, 'f')} (${time(after.communicationDisabledUntil, 'R')})` }] : [],
        });
      }
    }

    const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
    const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
    if (added.size || removed.size) {
      const entry = await findAuditEntry(guild, AuditLogEvent.MemberRoleUpdate, user.id);
      await logEvent(guild, {
        title: 'Roles changed',
        color: COLORS.edit,
        user,
        fields: [
          ...(added.size ? [{ name: 'Added', value: truncate(added.map((r) => `${r}`).join(' ')), inline: true }] : []),
          ...(removed.size ? [{ name: 'Removed', value: truncate(removed.map((r) => `${r}`).join(' ')), inline: true }] : []),
          { name: 'By', value: entry ? `${entry.executor}` : 'Unknown', inline: true },
        ],
      });
    }

    if (!before.premiumSince !== !after.premiumSince) {
      const started = Boolean(after.premiumSince);
      await logEvent(guild, {
        title: started ? 'Started boosting' : 'Stopped boosting',
        color: started ? COLORS.boost : COLORS.leave,
        user,
        fields: [
          { name: 'Server boosts', value: String(guild.premiumSubscriptionCount ?? 'Unknown'), inline: true },
          ...(started ? [] : [{ name: 'Boosting since', value: time(before.premiumSince, 'R'), inline: true }]),
        ],
      });
    }
  });

  // Username and display name are account-wide, so log the change in every server the user shares with the bot.
  on(Events.UserUpdate, async (before, after) => {
    if (before.partial) return;
    const changes = [
      before.username !== after.username && ['Username changed', before.username, after.username],
      before.globalName !== after.globalName && ['Display name changed', before.globalName, after.globalName],
    ].filter(Boolean);
    if (!changes.length) return;

    for (const guild of client.guilds.cache.values()) {
      if (!guild.members.cache.has(after.id)) continue;
      for (const [title, old, now] of changes) {
        await logEvent(guild, {
          title,
          color: COLORS.edit,
          user: after,
          fields: [
            { name: 'Before', value: old ?? '*none*', inline: true },
            { name: 'After', value: now ?? '*none*', inline: true },
          ],
        });
      }
    }
  });

  on(Events.GuildBanAdd, async (ban) => {
    const entry = await findAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (byBot(entry, client)) return; // /ban already logged it with full details
    return logAction(ban.guild, {
      action: 'Member banned',
      color: COLORS.ban,
      target: ban.user,
      moderator: entry?.executor ?? 'Unknown (I need View Audit Log to see who)',
      reason: entry?.reason ?? ban.reason,
    });
  });

  on(Events.GuildBanRemove, async (ban) => {
    const entry = await findAuditEntry(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    if (byBot(entry, client)) return; // /unban already logged it
    return logAction(ban.guild, {
      action: 'Member unbanned',
      color: COLORS.undo,
      target: ban.user,
      moderator: entry?.executor ?? 'Unknown (I need View Audit Log to see who)',
      reason: entry?.reason,
    });
  });
}
