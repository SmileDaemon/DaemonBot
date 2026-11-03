import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { COLORS, logEvent } from '../utils/logging.js';
import { refuse, Refused } from '../utils/refused.js';
import { guildConfig } from '../utils/store.js';
import { saveLevelSettings, XP_DEFAULTS } from './levels.js';
import { addStats, saveStatChannels, statSettings } from './statChannels.js';
import { BOT_NEEDS as TEMP_VOICE_NEEDS, removeTempVoice, setupTempVoice, tempVoiceSettings } from './tempVoice.js';
import { allTickets, setupTicketSection, ticketSettings, ticketTypes } from './tickets.js';

// Each part of a server's setup, shared by /setup and the control panel. A full setup (/setup full or the
// panel's Full Setup) can run once per server; after that it's locked until a Full Reset.

const P = PermissionFlagsBits;
// To make the ticket section and each ticket's channel. The bot can only hand out permissions it has itself.
const BOT_NEEDS_FOR_TICKETS = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.ManageChannels, P.ManageRoles, P.ManageMessages];
const BOT_NEEDS_FOR_STATS = [P.ViewChannel, P.ManageChannels, P.Connect];
const BOT_NEEDS_IN_LOG_CHANNEL = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles];
const LOG_CHANNEL_NAME = 'bot-logs';

const off = (flag) => process.env[flag] !== 'true';

// ---------------------------------------------------------------------------
//   The parts
// ---------------------------------------------------------------------------

export function checkTickets(guild) {
  if (!guild.members.me.permissions.has(BOT_NEEDS_FOR_TICKETS)) {
    refuse('For tickets I need: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages, Manage Channels, and Manage Roles.');
  }
}

export async function setUpTickets(guild, user, options) {
  checkTickets(guild);
  const { section, channel, fresh } = await setupTicketSection(guild, options);
  await logEvent(guild, {
    title: fresh ? 'Ticket system set up' : 'Ticket system updated',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Staff role', value: options.staffRoleId ? `<@&${options.staffRoleId}>` : 'Admins only', inline: true },
      { name: 'Types', value: options.types.join(', ').slice(0, 1024) },
    ],
  });
  return { section, channel };
}

/** The ticket options a server has, or the defaults: for /setup full, and to fill the panel's forms. */
const ticketDefaults = (guild) => {
  const saved = ticketSettings(guild.id);
  return { staffRoleId: saved?.staffRoleId ?? null, queueChannelId: saved?.queueChannelId ?? null, pingStaff: saved?.pingStaff ?? false, types: ticketTypes(saved) };
};

export async function setUpStats(guild, user, picks) {
  if (off('ENABLE_STAT_CHANNELS')) refuse("Server stats are turned off in the bot's .env.");
  if (!guild.members.me.permissions.has(BOT_NEEDS_FOR_STATS)) refuse('For server stats I need: View Channels, Manage Channels, and Connect.');
  const { added, skipped } = await addStats(guild, picks);
  await logEvent(guild, { title: 'Server stats set up', color: COLORS.info, user, fields: [{ name: 'Added', value: String(added), inline: true }] });
  return { added, skipped };
}

export async function setUpTempVoice(guild, user) {
  if (off('ENABLE_TEMP_VOICE')) refuse("Temporary voice channels are turned off in the bot's .env.");
  if (!guild.members.me.permissions.has(TEMP_VOICE_NEEDS)) {
    refuse('For temporary voice channels I need: View Channels, Connect, Send Messages, Embed Links, Manage Channels, Manage Roles, and Move Members.');
  }
  const result = await setupTempVoice(guild);
  await logEvent(guild, { title: 'Temporary voice channels set up', color: COLORS.info, user, fields: [{ name: 'Join channel', value: `${result.hub}`, inline: true }] });
  return result;
}

/** Sets the log channel, or turns logging off. Logged before turning off and after turning on, so either way it's recorded. */
export async function setLogChannel(guild, user, channel) {
  if (channel && !channel.permissionsFor(guild.members.me).has(BOT_NEEDS_IN_LOG_CHANNEL)) {
    refuse(`I need View Channel, Send Messages, Embed Links, and Attach Files in ${channel} first.`);
  }
  const entry = { title: `Log channel ${channel ? `set to #${channel.name}` : 'turned off'}`, color: COLORS.info, user };
  if (!channel) await logEvent(guild, entry);
  guildConfig.set(guild.id, { ...guildConfig.get(guild.id, {}), logChannelId: channel?.id ?? null });
  if (channel) await logEvent(guild, entry);
}

/** The log channel there is, or a new staff-only one. */
async function defaultLogChannel(guild, user) {
  const current = guild.channels.cache.get(guildConfig.get(guild.id, {}).logChannelId);
  if (current) return { channel: current, made: false };
  if (!guild.members.me.permissions.has([P.ManageChannels, P.ManageRoles, ...BOT_NEEDS_IN_LOG_CHANNEL])) refuse('For a log channel I need Manage Channels and Manage Roles.');
  const channel = await guild.channels.create({
    name: LOG_CHANNEL_NAME,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: guild.members.me.id, type: OverwriteType.Member, allow: BOT_NEEDS_IN_LOG_CHANNEL },
    ],
    reason: 'Log channel made by full setup',
  });
  await setLogChannel(guild, user, channel);
  return { channel, made: true };
}

// ---------------------------------------------------------------------------
//   Full setup, its lock, and Full Reset
// ---------------------------------------------------------------------------

/** When this server's full setup ran, by whom and from where ('discord' or 'panel'), or null. */
export const fullSetupDone = (guildId) => guildConfig.get(guildId, {}).fullSetup ?? null;

/** Refuses when a full setup already ran here. */
function checkFullSetupUnlocked(guild) {
  const done = fullSetupDone(guild.id);
  if (!done) return;
  const when = new Date(done.at).toISOString().slice(0, 10);
  refuse(`Full setup already ran in this server (${when}, ${done.via === 'panel' ? 'from the control panel' : 'with /setup full'}). ` +
    "Change each part on its own, or use Full Reset in the control panel's Danger Zone to run it again.");
}

/** /setup full's plan: everything at its defaults. Parts left out of a plan are left as they are. */
export const defaultPlan = (guild) => ({ log: { mode: 'auto' }, tickets: ticketDefaults(guild), tempVoice: true, stats: { types: ['members', 'bots'], roleIds: [] } });

/**
 * Runs a full setup: every part in `plan`, one after another, then locks it. A part that can't be set up is
 * reported and the rest still run. Returns [{ name, ok, text }] for the reply.
 *   log:       { mode: 'auto' (keep the current one, or make #bot-logs) | 'channel' (channelId) | 'off' }
 *   tickets:   { staffRoleId, queueChannelId, pingStaff, types } or false to skip
 *   tempVoice: true to set up, false to skip
 *   stats:     { types, roleIds } or false to skip
 *   levels:    { enabled, announce, message, xp } (panel only)
 *   wordFilter: true or false (panel only)
 */
export async function runFullSetup(guild, user, plan, via) {
  checkFullSetupUnlocked(guild);
  const parts = [];
  if (plan.log) {
    parts.push(['Log channel', async () => {
      if (plan.log.mode === 'off') {
        await setLogChannel(guild, user, null);
        return 'off';
      }
      if (plan.log.mode === 'channel') {
        const channel = guild.channels.cache.get(plan.log.channelId);
        if (channel?.type !== ChannelType.GuildText) refuse("That log channel doesn't exist anymore.");
        await setLogChannel(guild, user, channel);
        return `${channel}`;
      }
      const { channel, made } = await defaultLogChannel(guild, user);
      return made ? `${channel}, made for staff only` : `${channel}, kept as it was`;
    }]);
  }
  if (plan.wordFilter !== undefined) {
    parts.push(['Word filter', async () => {
      guildConfig.set(guild.id, { ...guildConfig.get(guild.id, {}), wordFilter: Boolean(plan.wordFilter) });
      return plan.wordFilter ? 'on' : 'off';
    }]);
  }
  if (plan.tickets) {
    parts.push(['Tickets', async () => {
      const { channel } = await setUpTickets(guild, user, plan.tickets);
      return `dropdown in ${channel} with ${plan.tickets.types.length} type${plan.tickets.types.length === 1 ? '' : 's'}${plan.tickets.staffRoleId ? '' : '; admins only'}`;
    }]);
  }
  if (plan.tempVoice) parts.push(['Temporary voice', async () => `join ${(await setUpTempVoice(guild, user)).hub} to make a channel`]);
  if (plan.stats) {
    parts.push(['Server stats', async () => {
      const { skipped } = await setUpStats(guild, user, plan.stats);
      return `${statSettings(guild).stats.length} stat channel(s)${skipped ? `; ${skipped} didn't fit` : ''}`;
    }]);
  }
  if (plan.levels) {
    parts.push(['Levels', async () => {
      if (off('ENABLE_LEVELS')) refuse("Levels are turned off in the bot's .env.");
      saveLevelSettings(guild.id, plan.levels);
      return plan.levels.enabled === false ? 'off' : 'on';
    }]);
  }

  const results = [];
  for (const [name, run] of parts) {
    try {
      results.push({ name, ok: true, text: await run() });
    } catch (err) {
      if (!(err instanceof Refused)) console.error(`Full setup (${name}):`, err);
      results.push({ name, ok: false, text: err instanceof Refused ? err.message : 'something went wrong; set it up on its own.' });
    }
  }
  guildConfig.set(guild.id, { ...guildConfig.get(guild.id, {}), fullSetup: { at: Date.now(), by: { id: user.id, username: user.username }, via } });
  await logEvent(guild, {
    title: 'Full setup run',
    color: COLORS.info,
    user,
    description: results.map((r) => `${r.ok ? '✅' : '⚠️'} **${r.name}:** ${r.text}`).join('\n').slice(0, 4000),
  });
  return results;
}

/**
 * Undoes a full setup so it can run again. Removes what the bot builds (stat channels, temporary voice, the
 * ticket dropdown channel) and puts settings back to their defaults. Never touches ticket channels, the
 * archive, the log channel itself, or anyone's XP. Returns [{ name, text }].
 */
export async function fullReset(guild, user) {
  const results = [];
  const note = (name, text) => results.push({ name, text });
  await logEvent(guild, { title: 'Full Reset started', color: COLORS.info, user });

  if (statSettings(guild).stats.length) {
    await saveStatChannels(guild, []);
    note('Server stats', 'stat channels and their category removed');
  }
  if (tempVoiceSettings(guild.id)) {
    const { left } = await removeTempVoice(guild);
    note('Temporary voice', `join channel removed${left ? `; ${left} channel(s) in use disappear when they empty` : ''}`);
  }
  const tickets = ticketSettings(guild.id);
  if (tickets) {
    const open = allTickets(guild.id).filter((t) => t.status !== 'archived').length;
    if (open) {
      note('Tickets', `kept, because ${open} ticket(s) are still open; close them and reset again to remove the dropdown`);
    } else {
      await guild.channels.cache.get(tickets.channelId)?.delete('Full Reset').catch(() => {});
      const config = { ...guildConfig.get(guild.id, {}) };
      delete config.tickets;
      guildConfig.set(guild.id, config);
      note('Tickets', '"Create A Ticket" channel removed and ticket settings cleared; closed tickets stay in their archive');
    }
  }
  saveLevelSettings(guild.id, { enabled: true, announce: 'here', message: null, xp: { ...XP_DEFAULTS }, rewards: {} });
  note('Levels', 'settings back to their defaults; everyone keeps their XP');

  const config = { ...guildConfig.get(guild.id, {}) };
  const hadLogs = Boolean(config.logChannelId);
  delete config.logChannelId;
  delete config.wordFilter;
  delete config.fullSetup;
  guildConfig.set(guild.id, config);
  note('Log channel', hadLogs ? 'turned off; the channel itself is kept' : 'was already off');
  note('Word filter', 'back on (the default)');
  note('Full setup', 'unlocked');
  return results;
}
