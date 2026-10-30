import { ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral, notice } from '../../utils/moderation.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const channelOption = (o) =>
  o.setName('channel').setDescription('Channel (defaults to this one)').addChannelTypes(...TEXT_CHANNELS);

export default {
  data: new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Lock, unlock, or set slowmode on a channel')
    .addSubcommand((s) =>
      s
        .setName('lock')
        .setDescription('Stop @everyone from sending messages')
        .addChannelOption(channelOption)
        .addStringOption((o) => o.setName('reason').setDescription('Shown in the channel').setMaxLength(300)),
    )
    .addSubcommand((s) => s.setName('unlock').setDescription('Let @everyone send messages again').addChannelOption(channelOption))
    .addSubcommand((s) =>
      s
        .setName('slowmode')
        .setDescription('Set how long members must wait between messages')
        .addIntegerOption((o) =>
          o.setName('seconds').setDescription('0 to turn off, up to 21600 (6 hours)').setRequired(true).setMinValue(0).setMaxValue(21_600),
        )
        .addChannelOption(channelOption),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    if (!TEXT_CHANNELS.includes(channel.type)) return interaction.reply(ephemeral('That only works in text or announcement channels.'));

    const everyone = interaction.guild.roles.everyone;
    const auditReason = `${interaction.user.tag} via /channel`;
    const log = (title, extra = []) =>
      logEvent(interaction.guild, {
        title,
        color: COLORS.edit,
        user: interaction.user,
        fields: [{ name: 'Channel', value: `${channel}`, inline: true }, ...extra],
      });

    switch (interaction.options.getSubcommand()) {
      case 'lock': {
        const reason = interaction.options.getString('reason');
        await channel.permissionOverwrites.edit(
          everyone,
          { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, AddReactions: false },
          { reason: auditReason },
        );
        if (channel.id !== interaction.channelId) await channel.send(notice(`🔒 This channel has been locked.${reason ? `\n**Reason:** ${reason}` : ''}`, { tone: 'warn' }));
        await interaction.reply(notice(`🔒 Locked ${channel}.${reason ? `\n**Reason:** ${reason}` : ''}`, { tone: 'warn' }));
        return log('Channel locked', reason ? [{ name: 'Reason', value: reason }] : []);
      }
      case 'unlock':
        // null resets to "inherit from category" rather than explicitly allowing.
        await channel.permissionOverwrites.edit(
          everyone,
          { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null, AddReactions: null },
          { reason: auditReason },
        );
        await interaction.reply(notice(`🔓 Unlocked ${channel}.`, { tone: 'success' }));
        return log('Channel unlocked');
      case 'slowmode': {
        const seconds = interaction.options.getInteger('seconds', true);
        await channel.setRateLimitPerUser(seconds, auditReason);
        await interaction.reply(notice(seconds ? `🐢 Slowmode in ${channel} set to ${seconds}s.` : `Slowmode turned off in ${channel}.`, { tone: 'success' }));
        return log('Slowmode changed', [{ name: 'Delay', value: seconds ? `${seconds}s` : 'Off', inline: true }]);
      }
    }
  },
};
