import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  OverwriteType,
  PermissionFlagsBits,
  time,
} from 'discord.js';
import { COLORS, logEvent } from '../utils/logging.js';
import { notice } from '../utils/replies.js';
import { guildConfig, tickets as ticketStore } from '../utils/store.js';

const STATUS = {
  pending: { label: '🟡 Pending', color: 0xf1c40f },
  active: { label: '🔵 Active', color: 0x3498db },
  archived: { label: '⚫ Archived', color: 0x95a5a6 },
};

export const MAX_OPEN_PER_USER = 3;
const CATEGORY_LIMIT = 50; // Discord's limit of channels in one category

const TALK = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];
const TALK_EDIT = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true };
// A closed ticket stays readable for whoever opened it, but nothing can be added to it.
const READ_ONLY = {
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessages: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  AddReactions: false,
};

export const ticketSettings = (guildId) => guildConfig.get(guildId, {}).tickets ?? null;

/** Tickets used to be private threads, stored by thread ID. Those keep working until they're closed. */
function guildTickets(guildId) {
  const data = ticketStore.get(guildId, { next: 1, byChannel: {} });
  if (data.byThread) {
    data.byChannel = Object.fromEntries(Object.entries(data.byThread).map(([id, { threadId, ...t }]) => [id, { ...t, channelId: threadId }]));
    delete data.byThread;
  }
  return data;
}
const getTicket = (guildId, channelId) => guildTickets(guildId).byChannel[channelId] ?? null;

/** Every ticket in a server, as stored. */
export const allTickets = (guildId) => Object.values(guildTickets(guildId).byChannel);

function saveTicket(guildId, ticket) {
  const data = guildTickets(guildId);
  data.byChannel[ticket.channelId] = ticket;
  ticketStore.set(guildId, data);
}

const number = (ticket) => `#${String(ticket.number).padStart(4, '0')}`;

const channelName = (ticket) =>
  `${ticket.status === 'archived' ? 'closed' : 'ticket'}-${String(ticket.number).padStart(4, '0')}-${ticket.openerName}`.slice(0, 100);

const isStaff = (member, settings) =>
  member.permissions.has(PermissionFlagsBits.Administrator) || member.roles.cache.has(settings.staffRoleId);

/** The queue only exists when it's a separate channel: anywhere else, a card would show who needs help and why. */
const hasQueue = (settings) => Boolean(settings.queueChannelId && settings.queueChannelId !== settings.channelId);

const claimButton = (ticket) =>
  new ButtonBuilder().setCustomId(`ticket:claim:${ticket.channelId}`).setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Primary);

/** The ticket summary, used both inside the ticket and as the queue card. */
function ticketEmbed(ticket, { showDetails = true } = {}) {
  const status = STATUS[ticket.status];
  const embed = new EmbedBuilder()
    .setTitle(`Ticket ${number(ticket)} · ${ticket.subject}`)
    .setColor(status.color)
    .addFields(
      { name: 'Status', value: status.label, inline: true },
      { name: 'Opened by', value: `<@${ticket.openerId}>`, inline: true },
      { name: 'Claimed by', value: ticket.claimerId ? `<@${ticket.claimerId}>` : 'Nobody yet', inline: true },
      { name: 'Channel', value: `<#${ticket.channelId}>`, inline: true },
    )
    .setTimestamp(ticket.createdAt);
  if (showDetails) embed.setDescription(ticket.details);
  if (ticket.closedById) {
    embed.addFields({ name: 'Closed by', value: `<@${ticket.closedById}> ${time(new Date(ticket.closedAt), 'R')}`, inline: true });
  }
  return embed;
}

function cardMessage(ticket, settings) {
  const components = ticket.status === 'pending' ? [new ActionRowBuilder().addComponents(claimButton(ticket))] : [];
  return { embeds: [ticketEmbed(ticket, { showDetails: hasQueue(settings) })], components };
}

function introMessage(ticket, settings) {
  if (ticket.status === 'archived') return { embeds: [ticketEmbed(ticket)], components: [] };
  const row = new ActionRowBuilder();
  if (ticket.status === 'pending' && !hasQueue(settings)) row.addComponents(claimButton(ticket));
  row.addComponents(
    new ButtonBuilder().setCustomId(`ticket:close:${ticket.channelId}`).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [ticketEmbed(ticket)], components: [row] };
}

/** Refreshes the queue card and the summary at the top of the ticket to match its state. */
async function refreshMessages(guild, ticket, settings, channel) {
  if (ticket.cardMessageId) {
    const queue = await guild.channels.fetch(ticket.cardChannelId).catch(() => null);
    await queue?.messages.edit(ticket.cardMessageId, cardMessage(ticket, settings)).catch(() => {});
  }
  await channel.messages.edit(ticket.introMessageId, introMessage(ticket, settings)).catch(() => {});
}

const staffOverwrite = (roleId) => ({ id: roleId, type: OverwriteType.Role, allow: TALK });
const hiddenFromEveryone = (guild) => ({ id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
const botOverwrite = (guild) => ({
  id: guild.members.me.id,
  type: OverwriteType.Member,
  allow: [...TALK, PermissionFlagsBits.ManageChannels],
});

function createCategory(guild, name, staffRoleId) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [hiddenFromEveryone(guild), staffOverwrite(staffRoleId), botOverwrite(guild)],
    reason: 'Ticket categories',
  });
}

const childCount = (guild, categoryId) => guild.channels.cache.filter((c) => c.parentId === categoryId).size;

/** The categories tickets live in, made if they're missing. Servers set up before tickets were channels get them on their next ticket. */
export async function ticketCategories(guild, settings, wanted = {}) {
  const usable = (id) => (guild.channels.cache.get(id)?.type === ChannelType.GuildCategory ? id : null);
  const categoryId = wanted.categoryId ?? usable(settings.categoryId) ?? (await createCategory(guild, 'Tickets', settings.staffRoleId)).id;
  const archiveCategoryId =
    wanted.archiveCategoryId ?? usable(settings.archiveCategoryId) ?? (await createCategory(guild, 'Archived Tickets', settings.staffRoleId)).id;
  return { categoryId, archiveCategoryId };
}

function saveSettings(guildId, changes) {
  const config = guildConfig.get(guildId, {});
  guildConfig.set(guildId, { ...config, tickets: { ...config.tickets, ...changes } });
}

/** Archives can outgrow a category: when one is full, the next closed ticket starts another. */
async function archiveCategoryFor(guild, settings) {
  const categories = await ticketCategories(guild, settings);
  saveSettings(guild.id, categories);
  const { archiveCategoryId } = categories;
  if (childCount(guild, archiveCategoryId) < CATEGORY_LIMIT) return archiveCategoryId;
  const fresh = await createCategory(guild, `Archived Tickets ${(settings.archiveCategories ?? 1) + 1}`, settings.staffRoleId);
  saveSettings(guild.id, { archiveCategoryId: fresh.id, archiveCategories: (settings.archiveCategories ?? 1) + 1 });
  return fresh.id;
}

/** Hands every ticket over to a new staff role, so the old role stops seeing them. */
export async function changeStaffRole(guild, oldRoleId, newRoleId) {
  const settings = ticketSettings(guild.id);
  const places = [settings?.categoryId, settings?.archiveCategoryId, ...allTickets(guild.id).map((t) => t.channelId)];
  for (const id of new Set(places)) {
    const channel = guild.channels.cache.get(id);
    if (!channel?.permissionOverwrites) continue; // gone, or one of the old private threads
    await channel.permissionOverwrites.delete(oldRoleId, 'Ticket staff role changed').catch(() => {});
    await channel.permissionOverwrites.edit(newRoleId, TALK_EDIT, { reason: 'Ticket staff role changed' });
  }
}

/** Is this one of the bot's ticket channels, or in a ticket category? Their comings and goings aren't server news. */
export function isTicketChannel(channel) {
  const settings = ticketSettings(channel.guild.id);
  if (!settings) return false;
  return (
    [settings.categoryId, settings.archiveCategoryId].includes(channel.parentId) ||
    Boolean(getTicket(channel.guild.id, channel.id))
  );
}

/** Tickets whose channel was deleted can't be closed any more, so they don't count as open. */
async function openTicketsOf(guild, userId) {
  const open = allTickets(guild.id).filter((t) => t.openerId === userId && t.status !== 'archived');
  const still = [];
  for (const ticket of open) {
    if (await guild.channels.fetch(ticket.channelId).catch(() => null)) still.push(ticket);
    else saveTicket(guild.id, { ...ticket, status: 'archived', closedAt: Date.now() });
  }
  return still;
}

/** Returns an error message if something is wrong, otherwise the new channel. */
export async function openTicket(interaction, subject, details) {
  const { guild, user } = interaction;
  const settings = ticketSettings(guild.id);
  if (!settings) return { error: "Tickets aren't set up in this server yet. An admin can run `/ticket setup`." };

  const openCount = (await openTicketsOf(guild, user.id)).length;
  if (openCount >= MAX_OPEN_PER_USER) {
    return { error: `You already have ${openCount} open tickets. Please wait for those to be resolved first.` };
  }

  let channel;
  const data = guildTickets(guild.id);
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

  try {
    const categories = await ticketCategories(guild, settings);
    saveSettings(guild.id, categories);
    if (childCount(guild, categories.categoryId) >= CATEGORY_LIMIT) {
      return { error: 'There are too many open tickets right now. Please try again once some are closed.' };
    }
    channel = await guild.channels.create({
      name: channelName(ticket),
      type: ChannelType.GuildText,
      parent: categories.categoryId,
      topic: `Ticket ${number(ticket)} · ${subject}`.slice(0, 1024),
      permissionOverwrites: [
        hiddenFromEveryone(guild),
        staffOverwrite(settings.staffRoleId),
        botOverwrite(guild),
        { id: user.id, type: OverwriteType.Member, allow: TALK },
      ],
      reason: `Ticket ${number(ticket)} opened by ${user.tag}`,
    });
  } catch (err) {
    console.error(`Couldn't open a ticket in ${guild.id}:`, err.message);
    return { error: "I couldn't create the ticket channel. An admin should check that I have Manage Channels and Manage Roles, and that the server isn't at Discord's channel limit." };
  }
  ticket.channelId = channel.id;

  const separateQueue = hasQueue(settings);
  const ping = settings.pingStaff ? `<@&${settings.staffRoleId}>` : '';
  await channel.send({
    ...notice('Thanks for reaching out! A staff member will pick this up soon. You can add more details or screenshots here while you wait.', {
      content: `${user}${separateQueue ? '' : ` ${ping}`}`.trim(),
    }),
    allowedMentions: { users: [user.id], roles: settings.pingStaff && !separateQueue ? [settings.staffRoleId] : [] },
  });
  const intro = await channel.send(introMessage(ticket, settings));
  ticket.introMessageId = intro.id;

  if (separateQueue) {
    const queue = await guild.channels.fetch(settings.queueChannelId).catch(() => null);
    const card = await queue
      ?.send({ content: ping || undefined, ...cardMessage(ticket, settings), allowedMentions: { roles: settings.pingStaff ? [settings.staffRoleId] : [] } })
      .catch(() => null);
    if (card) {
      ticket.cardChannelId = queue.id;
      ticket.cardMessageId = card.id;
    }
  }
  saveTicket(guild.id, ticket);

  await logEvent(guild, {
    title: 'Ticket opened',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Ticket', value: `${number(ticket)} · ${subject}`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
    ],
  });
  return { channel };
}

export async function claimTicket(interaction, channelId) {
  const { guild, user, member } = interaction;
  const settings = ticketSettings(guild.id);
  const ticket = getTicket(guild.id, channelId);
  if (!settings || !ticket) return { error: "I couldn't find that ticket." };
  if (!isStaff(member, settings)) return { error: `Only members with <@&${settings.staffRoleId}> can claim tickets.` };
  if (ticket.status === 'active') return { error: `Already claimed by <@${ticket.claimerId}>.` };
  if (ticket.status === 'archived') return { error: 'That ticket is already closed.' };
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return { error: "That ticket's channel doesn't exist anymore." };

  // Update state before any awaits so two staff clicking at once can't both claim it.
  ticket.status = 'active';
  ticket.claimerId = user.id;
  ticket.claimedAt = Date.now();
  saveTicket(guild.id, ticket);

  if (channel.isThread()) {
    if (channel.archived) await channel.setArchived(false);
    await channel.members.add(user.id);
  }
  await channel.send({
    ...notice(`${user} has picked up your ticket and will help you from here.`, { tone: 'success', content: `<@${ticket.openerId}>` }),
    allowedMentions: { users: [ticket.openerId] },
  });
  await refreshMessages(guild, ticket, settings, channel);

  await logEvent(guild, {
    title: 'Ticket claimed',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Ticket', value: `${number(ticket)} · ${ticket.subject}`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
    ],
  });
  return { channel };
}

/** A left member can't be given permissions, and doesn't need them: they can't see the channel anyway. */
async function makeReadOnly(channel, ticket) {
  try {
    await channel.permissionOverwrites.edit(ticket.openerId, READ_ONLY, { type: OverwriteType.Member, reason: 'Ticket closed' });
  } catch (err) {
    if (await channel.guild.members.fetch(ticket.openerId).catch(() => null)) throw err;
  }
}

/** Closes a ticket: its opener can still read it but no longer post, and it moves to the archive category. */
export async function closeTicket(interaction, channelId) {
  const { guild, user, member } = interaction;
  const settings = ticketSettings(guild.id);
  const ticket = getTicket(guild.id, channelId);
  if (!settings || !ticket) return { error: "This isn't a ticket channel." };
  if (ticket.status === 'archived') return { error: 'This ticket is already closed.' };

  const allowed =
    user.id === ticket.openerId || user.id === ticket.claimerId || member.permissions.has(PermissionFlagsBits.Administrator);
  if (!allowed) return { error: 'Only the person who opened this ticket or the staff member who claimed it can close it.' };
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return { error: "That ticket's channel doesn't exist anymore." };

  const before = { ...ticket };
  ticket.status = 'archived';
  ticket.closedById = user.id;
  ticket.closedAt = Date.now();
  saveTicket(guild.id, ticket);

  try {
    if (channel.isThread()) {
      if (channel.archived) await channel.setArchived(false);
      await refreshMessages(guild, ticket, settings, channel);
      await channel.send(notice(`🔒 Ticket closed by ${user}. This thread is now read-only, but it stays in the ticket channel so you can look back at it any time.`));
      await channel.edit({ locked: true, archived: true, reason: `Ticket closed by ${user.tag}` });
    } else {
      // Read-only first, so a failure further on can't leave the opener able to post in an archived ticket.
      await makeReadOnly(channel, ticket);
      const parent = await archiveCategoryFor(guild, settings);
      await channel.edit({ name: channelName(ticket), parent, lockPermissions: false, reason: `Ticket closed by ${user.tag}` });
      await refreshMessages(guild, ticket, settings, channel);
      await channel.send(notice(`🔒 Ticket closed by ${user}. This channel is now read-only for <@${ticket.openerId}>, and it stays here so they can look back at it any time.`));
    }
  } catch (err) {
    console.error(`Couldn't close ticket ${channelId} in ${guild.id}:`, err.message);
    saveTicket(guild.id, before);
    return { error: "I couldn't close this ticket. An admin should check that I have Manage Channels and Manage Roles." };
  }

  await logEvent(guild, {
    title: 'Ticket closed',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Ticket', value: `${number(ticket)} · ${ticket.subject}`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
    ],
  });
  return { channel };
}
