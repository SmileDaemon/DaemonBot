import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputStyle,
} from 'discord.js';
import { buildModal, field } from '../../utils/embeds.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral, notice, outcome } from '../../utils/replies.js';
import { defaultColor } from '../../utils/parse.js';
import { guildConfig } from '../../utils/store.js';
import { MAX_OPEN_PER_USER, claimTicket, closeTicket, openTicket, ticketSettings } from '../../features/tickets.js';

const BOT_NEEDS_IN_TICKET_CHANNEL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
];

const openTicketModal = () =>
  buildModal('ticket:submit', 'Open a ticket', [
    { id: 'subject', label: 'Subject', required: true, max: 80, placeholder: 'Short summary of what you need' },
    { id: 'details', label: 'Details', style: TextInputStyle.Paragraph, required: true, max: 1500 },
  ]);

async function setup(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply(ephemeral('You need the Manage Server permission to set up tickets.'));
  }
  const channel = interaction.options.getChannel('channel', true);
  const staffRole = interaction.options.getRole('staff_role', true);
  const queueChannel = interaction.options.getChannel('queue_channel');
  const me = interaction.guild.members.me;

  if (!channel.permissionsFor(me).has(BOT_NEEDS_IN_TICKET_CHANNEL)) {
    return interaction.reply(
      ephemeral(`In ${channel} I need: View Channel, Send Messages, Embed Links, Create Private Threads, Send Messages in Threads, and Manage Threads.`),
    );
  }
  if (queueChannel && !queueChannel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return interaction.reply(ephemeral(`I need View Channel, Send Messages, and Embed Links in ${queueChannel}.`));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Members only talk inside their ticket threads, not in the ticket channel itself.
  const lockedDown = await channel.permissionOverwrites
    .edit(
      interaction.guild.roles.everyone,
      { SendMessages: false, CreatePublicThreads: false, CreatePrivateThreads: false, SendMessagesInThreads: true },
      { reason: `Ticket channel set up by ${interaction.user.tag}` },
    )
    .then(() => true, () => false);

  const panel = new EmbedBuilder()
    .setTitle('Need help?')
    .setDescription(
      'Click **Open a ticket** to start a private conversation with the staff team. Only you and staff can see it.\n\n' +
        'After your ticket is closed it stays here, so you can look back at it any time.',
    )
    .setColor(defaultColor);
  await channel.send({
    embeds: [panel],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket:open').setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
      ),
    ],
  });

  const config = guildConfig.get(interaction.guild.id, {});
  guildConfig.set(interaction.guild.id, {
    ...config,
    tickets: {
      channelId: channel.id,
      staffRoleId: staffRole.id,
      queueChannelId: queueChannel?.id ?? null,
      pingStaff: interaction.options.getBoolean('ping_staff') ?? false,
    },
  });

  const notes = [
    `✅ Tickets are set up. Threads and the "Open a ticket" button are in ${channel}, and ${staffRole} members can claim tickets.`,
    queueChannel
      ? `New tickets are queued in ${queueChannel}, with their full details.`
      : `New tickets are queued in ${channel}. Anyone who can see that channel can see each ticket's subject (not its details). To keep subjects private, run setup again with a staff-only \`queue_channel\`.`,
    lockedDown
      ? `I stopped @everyone from posting directly in ${channel}; they can still talk in their own ticket threads.`
      : `⚠️ I couldn't change ${channel}'s permissions. Turn off "Send Messages" for @everyone there yourself, but leave "Send Messages in Threads" on.`,
    `Everyone who should be able to open tickets needs to be able to **see** ${channel}.`,
  ];
  await interaction.editReply(notice(notes.join('\n\n'), { tone: 'success', title: 'Tickets are set up' }));
  await logEvent(interaction.guild, {
    title: 'Ticket system set up',
    color: COLORS.ticket,
    user: interaction.user,
    fields: [
      { name: 'Ticket channel', value: `${channel}`, inline: true },
      { name: 'Queue', value: `${queueChannel ?? channel}`, inline: true },
      { name: 'Staff role', value: `${staffRole}`, inline: true },
    ],
  });
}

async function runClose(interaction, threadId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { error } = await closeTicket(interaction, threadId);
  await interaction.editReply(outcome(error, '🔒 Ticket closed.')).catch(() => {});
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open, close, or set up support tickets')
    .addSubcommand((s) => s.setName('open').setDescription('Open a private ticket with the staff team'))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket (use inside the ticket thread)'))
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Admins: choose the ticket channel and staff role, and post the "Open a ticket" button')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel where ticket threads live').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((o) => o.setName('staff_role').setDescription('Role allowed to claim tickets').setRequired(true))
        .addChannelOption((o) =>
          o
            .setName('queue_channel')
            .setDescription('Optional staff-only channel for the ticket queue (defaults to the ticket channel)')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((o) => o.setName('ping_staff').setDescription('Ping the staff role for each new ticket')),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    switch (interaction.options.getSubcommand()) {
      case 'setup':
        return setup(interaction);
      case 'open':
        if (!ticketSettings(interaction.guild.id)) return interaction.reply(ephemeral("Tickets aren't set up here yet. An admin can run `/ticket setup`."));
        return interaction.showModal(openTicketModal());
      case 'close':
        if (!interaction.channel.isThread()) return interaction.reply(ephemeral('Run this inside the ticket thread you want to close.'));
        return runClose(interaction, interaction.channelId);
    }
  },

  async handleButton(interaction) {
    const [, action, threadId] = interaction.customId.split(':');
    if (action === 'open') {
      if (!ticketSettings(interaction.guild.id)) return interaction.reply(ephemeral("Tickets aren't set up here anymore."));
      return interaction.showModal(openTicketModal());
    }
    if (action === 'close') return runClose(interaction, threadId);
    if (action === 'claim') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { error, thread } = await claimTicket(interaction, threadId);
      return interaction.editReply(outcome(error, `You claimed this ticket. Head over to ${thread}.`));
    }
  },

  async handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error, thread } = await openTicket(interaction, field(interaction, 'subject'), field(interaction, 'details'));
    await interaction.editReply(outcome(error, `🎫 Your ticket is open: ${thread}. You can have up to ${MAX_OPEN_PER_USER} open at a time.`));
  },
};
