import { EmbedBuilder, Events } from 'discord.js';
import { defaultColor } from '../utils/parse.js';
import { guildConfig, updateNotes } from '../utils/store.js';

/**
 * What's new, for each server's log channel. Add an entry (newest last) with the day it ships, in Eastern
 * time: when the bot restarts with it, servers get a note. Several on the same day share one message, which
 * is edited as more arrive; the next day starts a new one.
 */
const UPDATES = [
  { id: 'setup-tickets', date: '2026-11-03', text: '`/setup tickets` builds a **Support Tickets** section with a **Create A Ticket** channel, and asks which ticket types to offer in its dropdown.' },
  { id: 'setup-serverstats', date: '2026-11-03', text: '`/setup serverstats` shows members and bots as locked voice channels, and asks which other stats and roles to count.' },
  { id: 'setup-full', date: '2026-11-03', text: '`/setup full` sets everything up at once, and the control panel has a Full Setup that lets you choose each part. It runs once per server; Full Reset in the panel undoes it.' },
  { id: 'detect', date: '2026-11-03', text: '`/detect` finds other bots in the server, says what this bot can take over from each, and how to phase them out.' },
  { id: 'raid-protection', date: '2026-11-03', text: "**Raid protection**: a join alarm, lockdown, new account filter, raid cleanup, join gate, flood, mention and link guards, anti-nuke, permission watch, backups and raid reports. Switch each on in the control panel's Security tab, or use `/security`." },
  { id: 'join-gate-own', date: '2026-11-03', text: 'The join gate can be set up for you, or use a role and channel you choose.' },
  { id: 'ticket-transcripts', date: '2026-11-03', text: "Closed tickets now keep a **transcript**. A server's transcripts are all deleted together every 30 days; download them with `/ticket export` (or **Send to me** in the control panel). You'll get a reminder a week before." },
  { id: 'update-notes', date: '2026-11-03', text: "These notes: when the bot gets new features, they're listed here. Turn them off in the control panel's Settings." },
];

const ZONE = 'America/New_York';
/** The day a moment falls on in Eastern time, as YYYY-MM-DD. */
const easternDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function notesMessage(day, ids) {
  const lines = ids.map((id) => UPDATES.find((u) => u.id === id)).filter(Boolean).map((u) => `• ${u.text}`);
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`📣 Bot updates · ${dayLabel(day)}`)
        .setColor(defaultColor)
        .setDescription(lines.join('\n\n').slice(0, 4096))
        .setFooter({ text: "Turn these notes off in the control panel's Settings." }),
    ],
  };
}

/**
 * Posts the updates this server hasn't seen to its log channel, or adds them to today's message. A server
 * seeing these for the first time only gets today's; servers with update notes off, or no log channel, just
 * have them marked as seen so nothing piles up for later.
 */
async function postUpdates(guild, { quiet = false } = {}) {
  const now = Date.now();
  const today = easternDay(now);
  const state = updateNotes.get(guild.id) ?? { seen: UPDATES.filter((u) => u.date < today).map((u) => u.id), day: null, channelId: null, messageId: null, posted: [] };
  const fresh = UPDATES.filter((u) => !state.seen.includes(u.id)).map((u) => u.id);
  const seen = UPDATES.map((u) => u.id);
  const config = guildConfig.get(guild.id, {});
  const channel = guild.channels.cache.get(config.logChannelId);
  if (!fresh.length || quiet || config.updateNotes === false || !channel) {
    updateNotes.set(guild.id, { ...state, seen });
    return null;
  }

  const sameDay = state.day === today && state.channelId === channel.id && state.messageId;
  const old = sameDay ? await channel.messages.fetch(state.messageId).catch(() => null) : null;
  const posted = old ? [...state.posted, ...fresh] : fresh;
  const message = old ? await old.edit(notesMessage(today, posted)).catch(() => null) : await channel.send(notesMessage(today, posted)).catch(() => null);
  if (!message) return null; // couldn't post: try again on the next start
  updateNotes.set(guild.id, { seen, day: today, channelId: channel.id, messageId: message.id, posted });
  return { edited: Boolean(old), count: fresh.length };
}

export function registerUpdates(client) {
  client.once(Events.ClientReady, async () => {
    for (const guild of client.guilds.cache.values()) await postUpdates(guild).catch((err) => console.error(`Update notes (${guild.id}):`, err.message));
  });
  // A server that adds the bot later starts from what's current, without a list of everything it missed.
  client.on(Events.GuildCreate, (guild) => {
    if (client.isReady() && !updateNotes.get(guild.id)) postUpdates(guild, { quiet: true }).catch(() => {});
  });
}
