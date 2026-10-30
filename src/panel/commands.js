import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { endGuildSessions } from '../features/gameTracker.js';
import { saveLevelSettings } from '../features/levels.js';
import { optIn, optOut } from '../features/optOut.js';
import { endGuildVoice } from '../features/voiceTracker.js';
import { parseWordList, SAVED_WORDS } from '../features/wordFilter.js';
import { COLORS, logEvent } from '../utils/logging.js';
import { guildConfig, isOptedOut, warnings } from '../utils/store.js';

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};

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

    // As with /config log: log before turning logging off, after turning it on.
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
    if (!config.tickets) refuse('Tickets are not set up in this server. Run /ticket setup in Discord first.');
    const tickets = { ...config.tickets };
    const changes = [];

    if (payload.staffRoleId) {
      if (!guild.roles.cache.has(payload.staffRoleId)) refuse("That role doesn't exist anymore.");
      tickets.staffRoleId = payload.staffRoleId;
      changes.push({ name: 'Staff role', value: `<@&${payload.staffRoleId}>`, inline: true });
    }
    if ('queueChannelId' in payload) {
      const id = payload.queueChannelId || null;
      if (id) textChannel(guild, id);
      tickets.queueChannelId = id;
      changes.push({ name: 'Queue channel', value: id ? `<#${id}>` : 'The ticket channel', inline: true });
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
    const message = await handler(guild, command.payload ?? {}, command.user, client);
    return { id: command.id, ok: true, message };
  } catch (err) {
    if (!(err instanceof Refused)) console.error(`Panel change ${command.type} failed:`, err);
    return { id: command.id, ok: false, message: err instanceof Refused ? err.message : 'Something went wrong applying that.' };
  }
}
