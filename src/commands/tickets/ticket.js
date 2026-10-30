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
import { MAX_OPEN_PER_USER, changeStaffRole, claimTicket, closeTicket, openTicket, ticketCategories, ticketSettings } from '../../features/tickets.js';

const BOT_NEEDS_IN_TICKET_CHANNEL = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
// To make each ticket's channel and choose who can see it. The bot can only hand out permissions it has itself.
const BOT_NEEDS_IN_SERVER = [
  ...BOT_NEEDS_IN_TICKET_CHANNEL,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
];
const BOT_NEEDS_IN_CATEGORY = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels];

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
  const category = interaction.options.getChannel('category');
  const archiveCategory = interaction.options.getChannel('archive_category');
  const me = interaction.guild.members.me;

  if (!me.permissions.has(BOT_NEEDS_IN_SERVER)) {
    return interaction.reply(
      ephemeral('In this server I need: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels, and Manage Roles.'),
    );
  }
  if (!channel.permissionsFor(me).has(BOT_NEEDS_IN_TICKET_CHANNEL)) {
    return interaction.reply(ephemeral(`In ${channel} I need: View Channel, Send Messages, and Embed Links.`));
  }
  for (const c of [category, archiveCategory]) {
    if (c && !c.permissionsFor(me).has(BOT_NEEDS_IN_CATEGORY)) return interaction.reply(ephemeral(`In ${c} I need View Channel and Manage Channels.`));
  }
  if (category && category.id === archiveCategory?.id) return interaction.reply(ephemeral('Open and archived tickets need different categories.'));
  if (queueChannel && !queueChannel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return interaction.reply(ephemeral(`I need View Channel, Send Messages, and Embed Links in ${queueChannel}.`));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Members only talk inside their own ticket channels, not in the channel with the button.
  const lockedDown = await channel.permissionOverwrites
    .edit(
      interaction.guild.roles.everyone,
      { SendMessages: false, CreatePublicThreads: false, CreatePrivateThreads: false },
      { reason: `Ticket channel set up by ${interaction.user.tag}` },
    )
    .then(() => true, () => false);

  const panel = new EmbedBuilder()
    .setTitle('Need help?')
    .setDescription(
      'Click **Open a ticket** to start a private conversation with the staff team. You get your own channel that only you and staff can see.\n\n' +
        'After your ticket is closed it moves to the archive, where you can still read it but not post.',
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
  if (config.tickets && config.tickets.staffRoleId !== staffRole.id) await changeStaffRole(interaction.guild, config.tickets.staffRoleId, staffRole.id);
  const categories = await ticketCategories(
    interaction.guild,
    { ...config.tickets, staffRoleId: staffRole.id },
    { categoryId: category?.id, archiveCategoryId: archiveCategory?.id },
  );
  guildConfig.set(interaction.guild.id, {
    ...guildConfig.get(interaction.guild.id, {}),
    tickets: {
      ...config.tickets,
      ...categories,
      channelId: channel.id,
      staffRoleId: staffRole.id,
      queueChannelId: queueChannel?.id ?? null,
      pingStaff: interaction.options.getBoolean('ping_staff') ?? false,
    },
  });

  const notes = [
    `✅ Tickets are set up. The "Open a ticket" button is in ${channel}, and ${staffRole} members can see and claim tickets.`,
    `Open tickets go in <#${categories.categoryId}>. Closed ones move to <#${categories.archiveCategoryId}>, where whoever opened them can read but not post.`,
    queueChannel
      ? `New tickets are also listed in ${queueChannel}, with their full details, so make sure only staff can see it.`
      : 'Staff claim each ticket from a button inside its channel.',
    lockedDown
      ? `I stopped @everyone from posting directly in ${channel}; they talk in their own ticket channels.`
      : `⚠️ I couldn't change ${channel}'s permissions. Turn off "Send Messages" for @everyone there yourself.`,
    `Everyone who should be able to open tickets needs to be able to **see** ${channel}.`,
  ];
  await interaction.editReply(notice(notes.join('\n\n'), { tone: 'success', title: 'Tickets are set up' }));
  await logEvent(interaction.guild, {
    title: 'Ticket system set up',
    color: COLORS.ticket,
    user: interaction.user,
    fields: [
      { name: 'Ticket channel', value: `${channel}`, inline: true },
      { name: 'Queue', value: queueChannel ? `${queueChannel}` : 'None', inline: true },
      { name: 'Staff role', value: `${staffRole}`, inline: true },
    ],
  });
}

async function runClose(interaction, channelId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { error } = await closeTicket(interaction, channelId);
  await interaction.editReply(outcome(error, '🔒 Ticket closed.')).catch(() => {});
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open, close, or set up support tickets')
    .addSubcommand((s) => s.setName('open').setDescription('Open a private ticket with the staff team'))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket (use inside the ticket channel)'))
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Admins: choose the ticket channel and staff role, and post the "Open a ticket" button')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel for the "Open a ticket" button').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((o) => o.setName('staff_role').setDescription('Role allowed to claim tickets').setRequired(true))
        .addChannelOption((o) =>
          o
            .setName('queue_channel')
            .setDescription('Optional staff-only channel listing new tickets (otherwise staff claim inside each ticket)')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((o) =>
          o.setName('category').setDescription('Category for open tickets (made for you if left out)').addChannelTypes(ChannelType.GuildCategory),
        )
        .addChannelOption((o) =>
          o.setName('archive_category').setDescription('Category for closed tickets (made for you if left out)').addChannelTypes(ChannelType.GuildCategory),
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
        return runClose(interaction, interaction.channelId);
    }
  },

  async handleButton(interaction) {
    const [, action, channelId] = interaction.customId.split(':');
    if (action === 'open') {
      if (!ticketSettings(interaction.guild.id)) return interaction.reply(ephemeral("Tickets aren't set up here anymore."));
      return interaction.showModal(openTicketModal());
    }
    if (action === 'close') return runClose(interaction, channelId);
    if (action === 'claim') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { error, channel } = await claimTicket(interaction, channelId);
      return interaction.editReply(outcome(error, `You claimed this ticket. Head over to ${channel}.`));
    }
  },

  async handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error, channel } = await openTicket(interaction, field(interaction, 'subject'), field(interaction, 'details'));
    await interaction.editReply(outcome(error, `🎫 Your ticket is open: ${channel}. You can have up to ${MAX_OPEN_PER_USER} open at a time.`));
  },
};
