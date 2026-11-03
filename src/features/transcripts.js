import { AttachmentBuilder, EmbedBuilder, Events, time } from 'discord.js';
import { COLORS } from '../utils/logging.js';
import { guildConfig, transcripts } from '../utils/store.js';

// A copy of every ticket's conversation, saved when it closes. A server's transcripts are all deleted
// together: the first one starts a 30-day countdown, and when it runs out every transcript goes at once. The
// next transcript starts a new countdown. 7 days before, the server is reminded to export what it wants to keep.

export const KEEP_DAYS = 30;
const REMIND_DAYS = 7;
const DAY = 86_400_000;
const MAX_MESSAGES = 5000;

/** { deleteAt, list: { [number]: transcript } }: when this server's transcripts are next all deleted, and them. */
const cycleOf = (guildId) => transcripts.get(guildId, { deleteAt: null, list: {} });
const listOf = (guildId) => cycleOf(guildId).list;
function save(guildId, cycle) {
  if (Object.keys(cycle.list).length) transcripts.set(guildId, cycle);
  else transcripts.delete(guildId);
}

/** Every message in a ticket's channel, oldest first. */
async function readAll(channel) {
  const out = [];
  let before;
  while (out.length < MAX_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out.reverse().map((m) => ({
    at: m.createdTimestamp,
    authorId: m.author.id,
    author: m.member?.displayName ?? m.author.username,
    bot: m.author.bot,
    content: m.content,
    embeds: m.embeds.map((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')).filter(Boolean),
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
  }));
}

/** Saves a ticket's conversation as it closes. Returns the transcript, or null if the channel couldn't be read. */
export async function saveTranscript(guild, ticket, channel) {
  const messages = await readAll(channel);
  if (!messages.length) return null;
  const closedAt = ticket.closedAt ?? Date.now();
  const cycle = cycleOf(guild.id);
  // The first transcript since the last deletion starts the countdown for all of them.
  const deleteAt = cycle.deleteAt && cycle.deleteAt > Date.now() ? cycle.deleteAt : Date.now() + KEEP_DAYS * DAY;
  const transcript = {
    number: ticket.number,
    subject: ticket.subject,
    type: ticket.type ?? null,
    openerId: ticket.openerId,
    opener: ticket.openerName,
    claimerId: ticket.claimerId ?? null,
    createdAt: ticket.createdAt,
    closedAt,
    reminded: false,
    messages,
  };
  save(guild.id, { deleteAt, list: { ...cycle.list, [ticket.number]: transcript } });
  return { ...transcript, expiresAt: deleteAt };
}

/** A transcript with the day it's deleted, which is the same for all of a server's transcripts. */
const withExpiry = (guildId, t) => (t ? { ...t, expiresAt: cycleOf(guildId).deleteAt } : null);
export const transcriptOf = (guildId, number) => withExpiry(guildId, listOf(guildId)[number]);
export const transcriptsIn = (guildId) => Object.values(listOf(guildId)).map((t) => withExpiry(guildId, t)).sort((a, b) => b.closedAt - a.closedAt);

const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const pad = (n) => String(n).padStart(4, '0');

/** A transcript as a text file, for exporting. */
export function transcriptFile(guild, t) {
  const lines = [
    `Ticket #${pad(t.number)}: ${t.subject}`,
    `Server: ${guild.name}`,
    ...(t.type ? [`Type: ${t.type}`] : []),
    `Opened by: ${t.opener} (${t.openerId}) on ${stamp(t.createdAt)}`,
    `Closed: ${stamp(t.closedAt)}`,
    `The bot deletes this server's ticket transcripts, this one included, on ${stamp(t.expiresAt)}.`,
    '',
    '-'.repeat(60),
    '',
  ];
  for (const m of t.messages) {
    lines.push(`[${stamp(m.at)}] ${m.author}${m.bot ? ' (bot)' : ''}:`);
    if (m.content) lines.push(...m.content.split('\n').map((l) => `  ${l}`));
    for (const e of m.embeds) lines.push(...e.split('\n').map((l) => `  │ ${l}`));
    for (const a of m.attachments) lines.push(`  📎 ${a.name}: ${a.url}`);
    lines.push('');
  }
  return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `ticket-${pad(t.number)}-transcript.txt` });
}

/** For the control panel's ticket list: when each ticket's transcript goes. */
export function transcriptSummary(guildId) {
  return Object.fromEntries(transcriptsIn(guildId).map((t) => [t.number, { expiresAt: t.expiresAt, messages: t.messages.length }]));
}

// ---------------------------------------------------------------------------
//   Deleting old ones, and the reminder before
// ---------------------------------------------------------------------------

/** Where the reminder goes: the log channel, else the ticket queue, else the button's channel. */
function reminderChannel(guild) {
  const config = guildConfig.get(guild.id, {});
  return [config.logChannelId, config.tickets?.queueChannelId, config.tickets?.channelId]
    .map((id) => guild.channels.cache.get(id))
    .find((c) => c?.isTextBased?.()) ?? null;
}

/**
 * Deletes every transcript once the countdown runs out. In its last 7 days, reminds the server about the
 * transcripts that will go, including any saved after an earlier reminder. None to delete, no reminder.
 */
async function checkGuild(guild, now = Date.now()) {
  const cycle = cycleOf(guild.id);
  if (!cycle.deleteAt) return 0;
  if (cycle.deleteAt <= now) {
    transcripts.delete(guild.id);
    return 0;
  }
  if (cycle.deleteAt - now > REMIND_DAYS * DAY) return 0;
  const all = cycle.list;
  const soon = Object.values(all).filter((t) => !t.reminded).sort((a, b) => a.closedAt - b.closedAt);
  if (soon.length) {
    const channel = reminderChannel(guild);
    const sent = await channel
      ?.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('🗂️ Ticket transcripts will be deleted soon')
            .setColor(COLORS.ticket)
            .setDescription(
              `All of this server's ticket transcripts are deleted together ${time(new Date(cycle.deleteAt), 'R')} (${time(new Date(cycle.deleteAt), 'f')}). Export any you want to keep with \`/ticket export\` (or from the control panel's Moderation tab) before then.\n\n` +
                `${Object.keys(all).length > soon.length ? 'Saved since the last reminder:' : `${soon.length} transcript${soon.length === 1 ? '' : 's'}:`}\n` +
                soon.slice(0, 25).map((t) => `• **#${pad(t.number)}** ${t.subject} (${t.opener})`).join('\n') +
                (soon.length > 25 ? `\n…and ${soon.length - 25} more.` : ''),
            ),
        ],
      })
      .catch(() => null);
    // Only mark them once the reminder is out, so a missing channel doesn't lose it.
    if (sent) for (const t of soon) all[t.number].reminded = true;
  }
  save(guild.id, cycle);
  return soon.length;
}

export function registerTranscripts(client) {
  const tick = async () => {
    for (const guildId of transcripts.keys()) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) await checkGuild(guild).catch((err) => console.error(`Transcripts (${guildId}):`, err.message));
    }
  };
  client.once(Events.ClientReady, () => {
    tick();
    setInterval(tick, 60 * 60_000).unref();
  });
}
