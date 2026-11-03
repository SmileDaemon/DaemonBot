import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { latestBackup, restoreBackup, takeBackup } from '../features/backups.js';
import { fullReset, runFullSetup, setUpTickets } from '../features/fullSetup.js';
import { endGuildSessions } from '../features/gameTracker.js';
import { saveLevelSettings } from '../features/levels.js';
import { optIn, optOut } from '../features/optOut.js';
import { botRoleIsTop, endLockdown, MODULES, ROLE_HINT, saveSecuritySettings, startLockdown } from '../features/security.js';
import { MAX_NAME, MAX_STATS, saveStatChannels, STAT_TYPES, statTypeOffered } from '../features/statChannels.js';
import { BOT_NEEDS as TEMP_VOICE_NEEDS, removeTempVoice, setupTempVoice } from '../features/tempVoice.js';
import { acceptTerms, declineTerms, LOCKED_MESSAGE, termsLocked } from '../features/terms.js';
import { transcriptFile, transcriptOf } from '../features/transcripts.js';
import { changeStaffRole, parseTicketTypes } from '../features/tickets.js';
import { endGuildVoice } from '../features/voiceTracker.js';
import { parseWordList, SAVED_WORDS } from '../features/wordFilter.js';
import { COLORS, logEvent } from '../utils/logging.js';
import { refuse, Refused } from '../utils/refused.js';
import { guildConfig, isOptedOut, warnings } from '../utils/store.js';


const LOOP_MODES = ['off', 'track', 'queue'];

/** The Discord user an opt-out request is about, checked and named for the reply. */
async function optOutTarget(client, userId) {
  const id = String(userId ?? '').trim();
  if (!/^\d{17,20}$/.test(id)) refuse("That isn't a Discord user ID. It's a 17 to 20 digit number.");
  const found = await client.users.fetch(id).catch(() => null);
  return { id, name: found ? `${found.username} (${id})` : id };
}

/** Logs a panel change in the server's log channel, credited to whoever made it. */
async function logPanelChange(guild, user, title, fields = []) {
  const author = await guild.client.users.fetch(user.id).catch(() => null);
  return logEvent(guild, {
    title: `${title} (control panel)`,
    color: COLORS.info,
    user: author ?? undefined,
    description: author ? undefined : `By ${user.username} (${user.id})`,
    fields,
  });
}

function textChannel(guild, id) {
  const channel = guild.channels.cache.get(id);
  if (!channel?.isTextBased()) refuse("That channel doesn't exist anymore.");
  return channel;
}

/** The Discord account behind a panel change, for setup steps that log who made them. */
async function panelAuthor(guild, user) {
  const author = await guild.client.users.fetch(user.id).catch(() => null);
  if (!author) refuse("I couldn't look up your Discord account. Try again in a moment.");
  return author;
}

/** Mentions in a setup step's result, made readable for the panel. */
const readable = (guild, text) =>
  text
    .replace(/<#(\d+)>/g, (m, id) => (guild.channels.cache.get(id) ? `#${guild.channels.cache.get(id).name}` : m))
    .replace(/<@&(\d+)>/g, (m, id) => (guild.roles.cache.get(id) ? `@${guild.roles.cache.get(id).name}` : m))
    .replaceAll('**', '');

/** Ticket options from the panel, checked. */
function ticketPlan(guild, t) {
  const staffRoleId = t.staffRoleId || null;
  if (staffRoleId && !guild.roles.cache.has(staffRoleId)) refuse("The staff role doesn't exist anymore.");
  const queueChannelId = t.queueChannelId || null;
  if (queueChannelId) textChannel(guild, queueChannelId);
  if (!Array.isArray(t.types)) refuse('Ticket types are missing.');
  return { staffRoleId, queueChannelId, pingStaff: Boolean(t.pingStaff && staffRoleId), types: parseTicketTypes(t.types.join('\n')) };
}

const XP_LIMITS = { messageMin: ['Least XP per message', 1000], messageMax: ['Most XP per message', 1000], cooldownSeconds: ['Cooldown', 3600], voicePerMinute: ['Voice XP per minute', 1000] };

/** Level options from the panel, checked the way /levels checks them. Only what's given is changed. */
function levelPlan(guild, l) {
  const out = {};
  if ('enabled' in l) out.enabled = Boolean(l.enabled);
  if ('announce' in l) {
    if (l.announce !== 'here' && l.announce !== 'off') {
      const channel = textChannel(guild, l.announce);
      if (!channel.permissionsFor(guild.members.me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        refuse(`I need View Channel and Send Messages in #${channel.name} for level-up messages.`);
      }
    }
    out.announce = l.announce;
  }
  if ('message' in l) {
    const text = String(l.message ?? '').trim();
    if (text.length > 1000) refuse('The level-up message can be up to 1000 characters.');
    out.message = text || null;
  }
  if ('xp' in l) {
    const xp = {};
    for (const [key, [label, max]] of Object.entries(XP_LIMITS)) {
      const value = Number(l.xp?.[key]);
      if (!Number.isInteger(value) || value < 0 || value > max) refuse(`${label} must be a whole number from 0 to ${max}.`);
      xp[key] = value;
    }
    if (xp.messageMin > xp.messageMax) refuse("The least XP per message can't be more than the most.");
    out.xp = xp;
  }
  return out;
}

/** Stats to add in a full setup, checked. */
function statsPlan(guild, s) {
  const types = (s.types ?? []).filter((t) => statTypeOffered(t) && !STAT_TYPES[t].role);
  const roleIds = (s.roleIds ?? []).filter((id) => guild.roles.cache.has(id));
  if (types.length + roleIds.length > MAX_STATS) refuse(`A server can have up to ${MAX_STATS} stat channels.`);
  return { types, roleIds };
}

function player(client, guildId) {
  const p = client.lavalink?.getPlayer(guildId);
  if (!p) refuse('Nothing is playing in that server.');
  return p;
}

/** Each change the panel can ask for. Keep in step with COMMANDS in worker/src/index.js. */
const HANDLERS = {
  async 'settings.update'(guild, payload, user) {
    const config = guildConfig.get(guild.id, {});
    const next = { ...config };
    const changes = [];

    if ('logChannelId' in payload) {
      const id = payload.logChannelId || null;
      if (id) {
        const channel = textChannel(guild, id);
        const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];
        if (!channel.permissionsFor(guild.members.me).has(needed)) {
          refuse(`I need View Channel, Send Messages, Embed Links and Attach Files in #${channel.name} first.`);
        }
      }
      next.logChannelId = id;
      changes.push({ name: 'Log channel', value: id ? `<#${id}>` : 'Off', inline: true });
    }
    for (const [key, label] of [
      ['wordFilter', 'Word filter'],
      ['updateNotes', 'Bot update notes'],
      ['gameTracking', 'Game tracking'],
      ['voiceTracking', 'Voice tracking'],
      ['activityTracking', 'Activity tracking'],
      ['connectionTracking', 'Connection tracking'],
    ]) {
      if (!(key in payload)) continue;
      next[key] = Boolean(payload[key]);
      changes.push({ name: label, value: next[key] ? 'On' : 'Off', inline: true });
    }
    // Levels keep all their settings in one object (see levelSettings); the panel only switches them on and off.
    const levelsOn = 'levels' in payload ? Boolean(payload.levels) : null;
    if (levelsOn !== null) changes.push({ name: 'Levels', value: levelsOn ? 'On' : 'Off', inline: true });
    if (!changes.length) refuse('Nothing to change.');

    // As with /setup logs: log before turning logging off, after turning it on.
    if (config.logChannelId && !next.logChannelId) await logPanelChange(guild, user, 'Settings changed', changes);
    guildConfig.set(guild.id, next);
    if (levelsOn !== null) saveLevelSettings(guild.id, { enabled: levelsOn }); // after the set above, so it isn't overwritten
    if (next.gameTracking === false && config.gameTracking !== false) endGuildSessions(guild.id);
    if (next.voiceTracking === false && config.voiceTracking !== false) endGuildVoice(guild.id);
    if (next.logChannelId) await logPanelChange(guild, user, 'Settings changed', changes);
    return 'Settings saved.';
  },

  async 'tickets.update'(guild, payload, user) {
    const config = guildConfig.get(guild.id, {});
    if (!config.tickets) refuse('Tickets are not set up in this server. Run /setup tickets in Discord first.');
    const tickets = { ...config.tickets };
    const changes = [];

    if ('staffRoleId' in payload) {
      const id = payload.staffRoleId || null; // none: admins only
      if (id && !guild.roles.cache.has(id)) refuse("That role doesn't exist anymore.");
      if (id !== (tickets.staffRoleId ?? null)) await changeStaffRole(guild, tickets.staffRoleId ?? null, id);
      tickets.staffRoleId = id;
      if (!id) tickets.pingStaff = false;
      changes.push({ name: 'Staff role', value: id ? `<@&${id}>` : 'None (admins only)', inline: true });
    }
    if ('queueChannelId' in payload) {
      const id = payload.queueChannelId || null;
      if (id) textChannel(guild, id);
      tickets.queueChannelId = id;
      changes.push({ name: 'Queue channel', value: id ? `<#${id}>` : 'None', inline: true });
    }
    if ('pingStaff' in payload) {
      tickets.pingStaff = Boolean(payload.pingStaff);
      changes.push({ name: 'Ping staff', value: tickets.pingStaff ? 'Yes' : 'No', inline: true });
    }
    if (!changes.length) refuse('Nothing to change.');

    guildConfig.set(guild.id, { ...config, tickets });
    await logPanelChange(guild, user, 'Ticket settings changed', changes);
    return 'Ticket settings saved.';
  },

  async 'statchannels.set'(guild, { stats }, user) {
    if (process.env.ENABLE_STAT_CHANNELS !== 'true') refuse("Stat channels are turned off in the bot's .env.");
    if (!Array.isArray(stats) || stats.length > MAX_STATS) refuse(`A server can have up to ${MAX_STATS} stat channels.`);
    const wanted = stats.map(({ type, roleId, name, channelId }) => {
      if (!statTypeOffered(type)) refuse("This bot can't count that.");
      if (STAT_TYPES[type].role && !guild.roles.cache.has(roleId)) refuse("That role doesn't exist anymore.");
      const text = String(name ?? '').trim();
      if (!text.includes('{count}')) refuse('Every channel name needs {count} in it, where the number goes.');
      if (text.length > MAX_NAME) refuse(`Channel names can be up to ${MAX_NAME} characters.`);
      return { type, roleId: STAT_TYPES[type].role ? roleId : null, name: text, channelId };
    });
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect];
    if (!guild.members.me.permissions.has(needed)) refuse('I need View Channels, Manage Channels and Connect in this server first.');

    const { added, removed } = await saveStatChannels(guild, wanted);
    await logPanelChange(guild, user, 'Stat channels changed', [
      { name: 'Channels', value: String(wanted.length), inline: true },
      { name: 'Added', value: String(added), inline: true },
      { name: 'Removed', value: String(removed), inline: true },
    ]);
    return 'Stat channels saved. New names and counts can take up to 5 minutes to show, because of a Discord limit.';
  },

  async 'tempvoice.setup'(guild, _payload, user) {
    if (process.env.ENABLE_TEMP_VOICE !== 'true') refuse("Temporary voice channels are turned off in the bot's .env.");
    if (!guild.members.me.permissions.has(TEMP_VOICE_NEEDS)) {
      refuse('I need View Channels, Connect, Send Messages, Embed Links, Manage Channels, Manage Roles and Move Members in this server first.');
    }
    const { hub, fresh } = await setupTempVoice(guild);
    await logPanelChange(guild, user, 'Temporary voice channels set up', [{ name: 'Join channel', value: `${hub}`, inline: true }]);
    return fresh ? `Set up. Joining "${hub.name}" now makes a temporary voice channel.` : 'Already set up; anything missing was made again.';
  },
  // Makes the ticket section, or updates it (ticket types included). /setup tickets does the same in Discord.
  async 'tickets.setup'(guild, payload, user) {
    const { channel } = await setUpTickets(guild, await panelAuthor(guild, user), ticketPlan(guild, payload));
    return `Tickets saved. Members open them from the dropdown in #${channel.name}.`;
  },

  async 'levels.update'(guild, payload, user) {
    if (process.env.ENABLE_LEVELS !== 'true') refuse("Levels are turned off in the bot's .env.");
    const changes = levelPlan(guild, payload);
    if (!Object.keys(changes).length) refuse('Nothing to change.');
    saveLevelSettings(guild.id, changes);
    await logPanelChange(guild, user, 'Level settings changed', Object.keys(changes).map((key) => ({ name: key, value: 'Changed', inline: true })));
    return 'Level settings saved.';
  },

  // Every part at once, as chosen in the panel. Runs once per server; after that it's locked until setup.reset.
  async 'setup.full'(guild, payload, user) {
    const log = payload.log ?? { mode: 'auto' };
    if (!['auto', 'channel', 'off'].includes(log.mode)) refuse('Pick what to do about the log channel.');
    if (log.mode === 'channel') textChannel(guild, log.channelId);
    const plan = {
      log,
      wordFilter: Boolean(payload.wordFilter),
      tickets: payload.tickets ? ticketPlan(guild, payload.tickets) : false,
      tempVoice: Boolean(payload.tempVoice),
      stats: payload.stats ? statsPlan(guild, payload.stats) : false,
      levels: payload.levels ? levelPlan(guild, payload.levels) : undefined,
      security: Boolean(payload.security),
    };
    const results = await runFullSetup(guild, await panelAuthor(guild, user), plan, 'panel');
    const gaps = results.filter((r) => !r.ok).length;
    return `Full setup ${gaps ? `done, with ${gaps} gap${gaps === 1 ? '' : 's'}` : 'done'}. ` +
      results.map((r) => `${r.ok ? '✓' : '⚠'} ${r.name}: ${readable(guild, r.text)}`).join(' · ');
  },

  // Security tab: which protections are on, their limits, and who they leave alone.
  async 'security.update'(guild, payload, user) {
    if (process.env.ENABLE_SECURITY !== 'true') refuse("Raid protection is turned off in the bot's .env.");
    const before = { ...(guildConfig.get(guild.id, {}).security?.modules ?? {}) };
    const after = await saveSecuritySettings(guild, payload);
    const turned = Object.keys(MODULES).filter((k) => Boolean(before[k]) !== after.modules[k]);
    await logPanelChange(guild, user, 'Raid protection changed', [
      ...turned.map((k) => ({ name: MODULES[k].label, value: after.modules[k] ? 'On' : 'Off', inline: true })),
      ...(payload.limits || payload.trusted ? [{ name: 'Limits and trusted list', value: 'Saved', inline: true }] : []),
    ]);
    const anyOn = Object.values(after.modules).some(Boolean);
    return `Raid protection saved.${anyOn && !botRoleIsTop(guild) ? ` ${ROLE_HINT}` : ''}`;
  },
  async 'security.lockdown'(guild, { on }, user) {
    const by = (await panelAuthor(guild, user)).tag;
    const changed = on ? await startLockdown(guild, { by }) : await endLockdown(guild, by);
    if (!changed) refuse(on ? 'The server is already locked down.' : "The server isn't locked down.");
    return on ? "Locked down: @everyone can't post, verification is High and invites are paused." : 'Lockdown over: everything is back as it was.';
  },
  async 'security.backup'(guild, _payload, user) {
    const b = takeBackup(guild, 'manual');
    await logPanelChange(guild, user, 'Backup taken');
    return `Backed up ${b.roles.length} roles and ${b.channels.length} channels.`;
  },
  // Makes again what the latest backup has and the server doesn't. The panel asks for the server's name first.
  async 'security.restore'(guild, { confirm }, user) {
    if (confirm !== guild.name) refuse("Type the server's name exactly to confirm a restore.");
    if (!latestBackup(guild.id)) refuse('There are no backups yet.');
    const r = await restoreBackup(guild);
    await logPanelChange(guild, user, 'Restored from backup', [{ name: 'Made again', value: `${r.roles} roles, ${r.channels} channels`, inline: true }]);
    return `Made again: ${r.roles} role(s) and ${r.channels} channel(s).${r.failed ? ` ${r.failed} couldn't be made; check my role is at the top.` : ''}`;
  },

  // The terms page: both documents read to the end and agreed to. Unlocks the server.
  async 'terms.accept'(guild, { tos, privacy }, user) {
    if (tos !== true || privacy !== true) refuse('Both the Terms of Service and the Privacy Policy need to be accepted.');
    const changed = await acceptTerms(guild, await panelAuthor(guild, user), 'panel');
    return changed ? 'Thanks! The bot is unlocked for this server, and everything can be set up now.' : 'This server had already accepted them.';
  },
  async 'terms.decline'(guild, { which }, user) {
    if (!termsLocked(guild)) refuse('This server already accepted the terms. To remove the bot, kick it in Discord.');
    await declineTerms(guild, await panelAuthor(guild, user), which === 'privacy' ? 'privacy' : 'tos');
    return 'Declined. DaemonBot is leaving the server.';
  },

  // Danger Zone: undoes a full setup and unlocks it. The panel asks for the server's name; checked again here.
  async 'setup.reset'(guild, { confirm }, user) {
    if (confirm !== guild.name) refuse("Type the server's name exactly to confirm a Full Reset.");
    const results = await fullReset(guild, await panelAuthor(guild, user));
    return `Full Reset done. ${results.map((r) => `${r.name}: ${r.text}`).join(' · ')}`;
  },

  async 'tempvoice.remove'(guild, _payload, user) {
    const { left } = await removeTempVoice(guild);
    await logPanelChange(guild, user, 'Temporary voice channels removed');
    return `Removed.${left ? ` ${left} channel${left === 1 ? ' is' : 's are'} still in use and will disappear when emptied.` : ''}`;
  },

  // Sends a ticket's transcript to whoever asked, by direct message.
  async 'tickets.transcript'(guild, { number }, user) {
    const t = transcriptOf(guild.id, Number(number));
    if (!t) refuse("That transcript isn't kept anymore.");
    const author = await panelAuthor(guild, user);
    const sent = await author.send({ content: `Transcript of ticket #${t.number} in ${guild.name}.`, files: [transcriptFile(guild, t)] }).then(() => true, () => false);
    if (!sent) refuse("I couldn't message you. Allow direct messages from this server's members, or use /ticket export in Discord.");
    return 'Sent to you in a direct message on Discord.';
  },

  async 'warnings.clear'(guild, { userId }, user) {
    const all = warnings.get(guild.id, {});
    const count = all[userId]?.length ?? 0;
    if (!count) refuse('That member has no warnings.');
    delete all[userId];
    warnings.set(guild.id, all);
    await logPanelChange(guild, user, 'Warnings cleared', [
      { name: 'Member', value: `<@${userId}> (${userId})`, inline: true },
      { name: 'Removed', value: String(count), inline: true },
    ]);
    return `Cleared ${count} warning${count === 1 ? '' : 's'}.`;
  },

  async 'warnings.remove'(guild, { userId, at }, user) {
    const all = warnings.get(guild.id, {});
    const list = all[userId] ?? [];
    const index = list.findIndex((w) => w.at === at);
    if (index === -1) refuse('That warning is already gone.');
    const [removed] = list.splice(index, 1);
    if (list.length) all[userId] = list;
    else delete all[userId];
    warnings.set(guild.id, all);
    await logPanelChange(guild, user, 'Warning removed', [
      { name: 'Member', value: `<@${userId}> (${userId})`, inline: true },
      { name: 'Reason it was given', value: removed.reason || 'No reason given' },
    ]);
    return 'Warning removed.';
  },

  async 'music.pause'(guild) {
    await player(guild.client, guild.id).pause();
    return 'Paused.';
  },
  async 'music.resume'(guild) {
    await player(guild.client, guild.id).resume();
    return 'Resumed.';
  },
  async 'music.skip'(guild) {
    const p = player(guild.client, guild.id);
    if (p.queue.tracks.length) await p.skip();
    else await p.stopPlaying(true, false);
    return 'Skipped.';
  },
  async 'music.stop'(guild, _payload, user) {
    await player(guild.client, guild.id).destroy(`stopped from the control panel by ${user.username}`);
    return 'Stopped and left the voice channel.';
  },
  async 'music.shuffle'(guild) {
    const p = player(guild.client, guild.id);
    if (p.queue.tracks.length < 2) refuse('Need at least 2 songs in the queue to shuffle.');
    await p.queue.shuffle();
    return 'Shuffled.';
  },
  async 'music.volume'(guild, { volume }) {
    const percent = Math.round(Number(volume));
    if (!(percent >= 1 && percent <= 150)) refuse('Volume must be between 1 and 150.');
    await player(guild.client, guild.id).setVolume(percent);
    return `Volume ${percent}%.`;
  },
  async 'music.loop'(guild, { mode }) {
    if (!LOOP_MODES.includes(mode)) refuse('Loop must be off, track or queue.');
    await player(guild.client, guild.id).setRepeatMode(mode);
    return `Loop: ${mode}.`;
  },

  // Bot-wide: the worker only lets the bot's owners send this.
  async 'wordlist.set'(_guild, { text }) {
    if (typeof text !== 'string' || text.length > 100_000) refuse('That word list is not valid.');
    const count = parseWordList(text).length;
    mkdirSync(dirname(SAVED_WORDS), { recursive: true });
    writeFileSync(SAVED_WORDS, text.replace(/\r?\n/g, '\n'), 'utf8');
    return `Word list saved: ${count} entr${count === 1 ? 'y' : 'ies'}. The filter picks it up within a few seconds.`;
  },
  // Owners only: applies an opt-out a member asked for by email. Each server is requested separately.
  async 'optout.add'(guild, { userId }, _user, client) {
    if (!guild) refuse('Pick the server they asked to be opted out of.');
    const { id, name } = await optOutTarget(client, userId);
    const already = isOptedOut(guild.id, id);
    optOut(guild, id); // also re-runs the deletion, in case anything slipped in
    return already
      ? `${name} was already opted out of ${guild.name}. Checked again that nothing is kept about them there.`
      : `Opted out ${name} in ${guild.name}: their statistics there are deleted, and they won't be tracked there again.`;
  },
  async 'optout.remove'(guild, { userId }, _user, client) {
    if (!guild) refuse('Pick the server to undo the opt-out in.');
    const { id, name } = await optOutTarget(client, userId);
    if (!isOptedOut(guild.id, id)) refuse(`${name} isn't opted out of ${guild.name}.`);
    optIn(guild.id, id);
    return `${name} is tracked in ${guild.name} again from now on. Statistics deleted earlier don't come back.`;
  },
};

export const PANEL_COMMANDS = Object.keys(HANDLERS);

/** Applies one change from the panel. Returns { id, ok, message } for the worker. */
export async function runPanelCommand(client, command) {
  const handler = HANDLERS[command.type];
  try {
    if (!handler) refuse(`This bot doesn't know how to "${command.type}". Is it up to date?`);
    let guild = null;
    if (command.guildId) {
      guild = client.guilds.cache.get(command.guildId);
      if (!guild) refuse("I'm not in that server anymore.");
    }
    if (guild && termsLocked(guild) && !command.type.startsWith('terms.')) refuse(LOCKED_MESSAGE);
    const message = await handler(guild, command.payload ?? {}, command.user, client);
    return { id: command.id, ok: true, message };
  } catch (err) {
    if (!(err instanceof Refused)) console.error(`Panel change ${command.type} failed:`, err);
    return { id: command.id, ok: false, message: err instanceof Refused ? err.message : 'Something went wrong applying that.' };
  }
}
