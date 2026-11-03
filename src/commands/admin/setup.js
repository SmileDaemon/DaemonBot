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
} from 'discord.js';
import { BOT_NEEDS as TEMP_VOICE_NEEDS, handleTempVoice, removeTempVoice, setupTempVoice, tempVoiceSettings } from '../../features/tempVoice.js';
import { changeStaffRole, ticketCategories } from '../../features/tickets.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { defaultColor } from '../../utils/parse.js';
import { ephemeral, notice } from '../../utils/replies.js';
import { guildConfig } from '../../utils/store.js';

const BOT_NEEDS_IN_TICKET_CHANNEL = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
// To make each ticket's channel and choose who can see it. The bot can only hand out permissions it has itself.
const BOT_NEEDS_FOR_TICKETS = [
  ...BOT_NEEDS_IN_TICKET_CHANNEL,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
];
const BOT_NEEDS_IN_CATEGORY = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels];
const BOT_NEEDS_IN_LOG_CHANNEL = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];

const tempVoiceOff = () => process.env.ENABLE_TEMP_VOICE !== 'true';

async function tickets(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  const staffRole = interaction.options.getRole('staff_role', true);
  const queueChannel = interaction.options.getChannel('queue_channel');
  const category = interaction.options.getChannel('category');
  const archiveCategory = interaction.options.getChannel('archive_category');
  const me = interaction.guild.members.me;

  if (!me.permissions.has(BOT_NEEDS_FOR_TICKETS)) {
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

async function logs(interaction) {
  const config = guildConfig.get(interaction.guild.id, {});
  const channel = interaction.options.getChannel('channel');
  if (channel && !channel.permissionsFor(interaction.guild.members.me).has(BOT_NEEDS_IN_LOG_CHANNEL)) {
    return interaction.reply(ephemeral(`I need View Channel, Send Messages, Embed Links, and Attach Files in ${channel} first.`));
  }
  // Log the change before turning logging off, and after turning it on, so either way it's recorded.
  const entry = { title: `Log channel ${channel ? `set to #${channel.name}` : 'turned off'}`, color: COLORS.info, user: interaction.user };
  if (!channel) await logEvent(interaction.guild, entry);
  guildConfig.set(interaction.guild.id, { ...config, logChannelId: channel?.id ?? null });
  if (channel) await logEvent(interaction.guild, entry);
  await interaction.reply(ephemeral(channel ? `Logs will be posted in ${channel}.` : 'Logging turned off.', 'success'));
}

async function tempVoice(interaction) {
  if (tempVoiceOff()) return interaction.reply(ephemeral("Temporary voice channels are turned off in the bot's .env."));
  if (!interaction.guild.members.me.permissions.has(TEMP_VOICE_NEEDS)) {
    return interaction.reply(ephemeral('In this server I need: View Channels, Connect, Send Messages, Embed Links, Manage Channels, Manage Roles, and Move Members.'));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { category, hub, fresh } = await setupTempVoice(interaction.guild);
  await interaction.editReply(
    notice(
      `Anyone who joins ${hub} gets their own voice channel in **${category.name}**, named after them, with buttons in its chat to manage it. ` +
        'Each channel disappears once everyone has left. Move or rename the category and join channel as you like.',
      { tone: 'success', title: fresh ? 'Temporary voice channels are set up' : 'Temporary voice channels checked' },
    ),
  );
  await logEvent(interaction.guild, {
    title: 'Temporary voice channels set up',
    color: COLORS.info,
    user: interaction.user,
    fields: [{ name: 'Join channel', value: `${hub}`, inline: true }],
  });
}

async function removeTempVoiceCommand(interaction) {
  if (!tempVoiceSettings(interaction.guild.id)) return interaction.reply(ephemeral("Temporary voice channels aren't set up here."));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { left } = await removeTempVoice(interaction.guild);
  await interaction.editReply(
    notice(
      `Temporary voice channels are off, and the join channel is gone.${left ? ` ${left} channel${left === 1 ? ' is' : 's are'} still in use and will disappear when ${left === 1 ? 'it empties' : 'they empty'}.` : ''}`,
      { tone: 'success' },
    ),
  );
  await logEvent(interaction.guild, { title: 'Temporary voice channels removed', color: COLORS.info, user: interaction.user });
}

const RUN = { tickets, logs, 'temp-voice': tempVoice, 'remove-temp-voice': removeTempVoiceCommand };

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Admins: set up tickets, the log channel and temporary voice channels')
    .addSubcommand((s) =>
      s
        .setName('tickets')
        .setDescription('Choose the ticket channel and staff role, and post the "Open a ticket" button')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel for the "Open a ticket" button').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((o) => o.setName('staff_role').setDescription('Role that can see and claim tickets').setRequired(true))
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
    .addSubcommand((s) =>
      s
        .setName('logs')
        .setDescription('Set the channel where moderation, bot actions and server events are logged (empty = off)')
        .addChannelOption((o) => o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) => s.setName('temp-voice').setDescription('Create the Temp Voice Channels category and its "Join To Create" channel'))
    .addSubcommand((s) => s.setName('remove-temp-voice').setDescription('Remove the join channel; temporary channels in use disappear when they empty'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    return RUN[interaction.options.getSubcommand()](interaction);
  },

  // The controls inside each temporary voice channel ("setup:tempvoice:<action>:<channel>").
  handleButton: handleTempVoice,
  handleModal: handleTempVoice,
  handleSelect: handleTempVoice,
};
