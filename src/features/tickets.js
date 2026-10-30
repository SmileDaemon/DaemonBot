import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  time,
} from 'discord.js';
import { COLORS, logEvent } from '../utils/logging.js';
import { notice } from '../utils/replies.js';
import { guildConfig, tickets as ticketStore } from '../utils/store.js';

const STATUS = {
  pending: { tag: '[PENDING]', label: '🟡 Pending', color: 0xf1c40f },
  active: { tag: '[ACTIVE]', label: '🔵 Active', color: 0x3498db },
  archived: { tag: '[ARCHIVED]', label: '⚫ Archived', color: 0x95a5a6 },
};

export const MAX_OPEN_PER_USER = 3;

export const ticketSettings = (guildId) => guildConfig.get(guildId, {}).tickets ?? null;

const guildTickets = (guildId) => ticketStore.get(guildId, { next: 1, byThread: {} });
const getTicket = (guildId, threadId) => guildTickets(guildId).byThread[threadId] ?? null;

function saveTicket(guildId, ticket) {
  const data = guildTickets(guildId);
  data.byThread[ticket.threadId] = ticket;
  ticketStore.set(guildId, data);
}

const number = (ticket) => `#${String(ticket.number).padStart(4, '0')}`;

// Discord only allows 2 renames per thread every 10 minutes; tickets rename at most twice (claim, close).
const threadName = (ticket) =>
  `${STATUS[ticket.status].tag} ${number(ticket)} · ${ticket.openerName} · ${ticket.subject}`.slice(0, 100);

const isStaff = (member, settings) =>
  member.permissions.has(PermissionFlagsBits.Administrator) || member.roles.cache.has(settings.staffRoleId);

/** The ticket summary, used both inside the thread and as the queue card. */
function ticketEmbed(ticket, { showDetails = true } = {}) {
  const status = STATUS[ticket.status];
  const embed = new EmbedBuilder()
    .setTitle(`Ticket ${number(ticket)} · ${ticket.subject}`)
    .setColor(status.color)
    .addFields(
      { name: 'Status', value: status.label, inline: true },
      { name: 'Opened by', value: `<@${ticket.openerId}>`, inline: true },
      { name: 'Claimed by', value: ticket.claimerId ? `<@${ticket.claimerId}>` : 'Nobody yet', inline: true },
      { name: 'Thread', value: `<#${ticket.threadId}>`, inline: true },
    )
    .setTimestamp(ticket.createdAt);
  if (showDetails) embed.setDescription(ticket.details);
  if (ticket.closedById) {
    embed.addFields({ name: 'Closed by', value: `<@${ticket.closedById}> ${time(new Date(ticket.closedAt), 'R')}`, inline: true });
  }
  return embed;
}

function cardMessage(ticket, settings) {
  // Ticket details are only shown in the queue when it's a separate (staff-only) channel.
  const showDetails = Boolean(settings.queueChannelId && settings.queueChannelId !== settings.channelId);
  const components =
    ticket.status === 'pending'
      ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket:claim:${ticket.threadId}`).setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Primary),
        )]
      : [];
  return { embeds: [ticketEmbed(ticket, { showDetails })], components };
}

function threadMessage(ticket) {
  const components =
    ticket.status === 'archived'
      ? []
      : [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket:close:${ticket.threadId}`).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        )];
  return { embeds: [ticketEmbed(ticket)], components };
}

/** Refreshes the queue card and the summary at the top of the thread to match the ticket's state. */
async function refreshMessages(guild, ticket, settings, thread) {
  const queue = await guild.channels.fetch(ticket.cardChannelId).catch(() => null);
  await queue?.messages.edit(ticket.cardMessageId, cardMessage(ticket, settings)).catch(() => {});
  await thread.messages.edit(ticket.introMessageId, threadMessage(ticket)).catch(() => {});
}

/** Returns an error message if something is wrong, otherwise the new thread. */
export async function openTicket(interaction, subject, details) {
  const { guild, user } = interaction;
  const settings = ticketSettings(guild.id);
  if (!settings) return { error: "Tickets aren't set up in this server yet. An admin can run `/ticket setup`." };

  const data = guildTickets(guild.id);
  const openCount = Object.values(data.byThread).filter((t) => t.openerId === user.id && t.status !== 'archived').length;
  if (openCount >= MAX_OPEN_PER_USER) {
    return { error: `You already have ${openCount} open tickets. Please wait for those to be resolved first.` };
  }

  const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
  if (!channel) return { error: "The ticket channel doesn't exist anymore. An admin needs to run `/ticket setup` again." };

  const ticket = {
    number: data.next++,
    subject,
    details,
    openerId: user.id,
    openerName: user.username,
    status: 'pending',
    createdAt: Date.now(),
  };
  ticketStore.set(guild.id, data); // reserve the ticket number

  const thread = await channel.threads.create({
    name: threadName(ticket),
    type: ChannelType.PrivateThread,
    invitable: false, // only staff can add more people
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `Ticket ${number(ticket)} opened by ${user.tag}`,
  });
  ticket.threadId = thread.id;
  await thread.members.add(user.id);

  await thread.send({
    ...notice('Thanks for reaching out! A staff member will pick this up soon. You can add more details or screenshots here while you wait.', {
      content: `${user}`,
    }),
    allowedMentions: { users: [user.id] },
  });
  const intro = await thread.send(threadMessage(ticket));
  ticket.introMessageId = intro.id;

  const queue = settings.queueChannelId ? await guild.channels.fetch(settings.queueChannelId).catch(() => channel) : channel;
  const card = await queue.send({
    content: settings.pingStaff ? `<@&${settings.staffRoleId}>` : undefined,
    ...cardMessage(ticket, settings),
    allowedMentions: { roles: settings.pingStaff ? [settings.staffRoleId] : [] },
  });
  ticket.cardChannelId = queue.id;
  ticket.cardMessageId = card.id;
  saveTicket(guild.id, ticket);

  await logEvent(guild, {
    title: 'Ticket opened',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Ticket', value: `${number(ticket)} · ${subject}`, inline: true },
      { name: 'Thread', value: `${thread}`, inline: true },
    ],
  });
  return { thread };
}

export async function claimTicket(interaction, threadId) {
  const { guild, user, member } = interaction;
  const settings = ticketSettings(guild.id);
  const ticket = getTicket(guild.id, threadId);
  if (!settings || !ticket) return { error: "I couldn't find that ticket." };
  if (!isStaff(member, settings)) return { error: `Only members with <@&${settings.staffRoleId}> can claim tickets.` };
  if (ticket.status === 'active') return { error: `Already claimed by <@${ticket.claimerId}>.` };
  if (ticket.status === 'archived') return { error: 'That ticket is already closed.' };

  // Update state before any awaits so two staff clicking at once can't both claim it.
  ticket.status = 'active';
  ticket.claimerId = user.id;
  ticket.claimedAt = Date.now();
  saveTicket(guild.id, ticket);

  const thread = await guild.channels.fetch(threadId);
  if (thread.archived) await thread.setArchived(false);
  await thread.members.add(user.id);
  await thread.setName(threadName(ticket));
  await thread.send({
    ...notice(`${user} has picked up your ticket and will help you from here.`, { tone: 'success', content: `<@${ticket.openerId}>` }),
    allowedMentions: { users: [ticket.openerId] },
  });
  await refreshMessages(guild, ticket, settings, thread);

  await logEvent(guild, {
    title: 'Ticket claimed',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Ticket', value: `${number(ticket)} · ${ticket.subject}`, inline: true },
      { name: 'Thread', value: `${thread}`, inline: true },
    ],
  });
  return { thread };
}

/** Closes a ticket: renames it [ARCHIVED], then locks and archives the thread so it stays readable but can't be added to. */
export async function closeTicket(interaction, threadId) {
  const { guild, user, member } = interaction;
  const settings = ticketSettings(guild.id);
  const ticket = getTicket(guild.id, threadId);
  if (!settings || !ticket) return { error: "This isn't a ticket thread." };
  if (ticket.status === 'archived') return { error: 'This ticket is already closed.' };

  const allowed =
    user.id === ticket.openerId || user.id === ticket.claimerId || member.permissions.has(PermissionFlagsBits.Administrator);
  if (!allowed) return { error: 'Only the person who opened this ticket or the staff member who claimed it can close it.' };

  ticket.status = 'archived';
  ticket.closedById = user.id;
  ticket.closedAt = Date.now();
  saveTicket(guild.id, ticket);

  const thread = await guild.channels.fetch(threadId);
  if (thread.archived) await thread.setArchived(false);
  await refreshMessages(guild, ticket, settings, thread);
  await thread.send(notice(`🔒 Ticket closed by ${user}. This thread is now read-only, but it stays in the ticket channel so you can look back at it any time.`));
  await thread.edit({ name: threadName(ticket), locked: true, archived: true, reason: `Ticket closed by ${user.tag}` });

  await logEvent(guild, {
    title: 'Ticket closed',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Ticket', value: `${number(ticket)} · ${ticket.subject}`, inline: true },
      { name: 'Thread', value: `${thread}`, inline: true },
    ],
  });
  return { thread };
}
