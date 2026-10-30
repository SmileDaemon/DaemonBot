import { ChannelType, EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { endGuildSessions } from '../../features/gameTracker.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral } from '../../utils/moderation.js';
import { defaultColor } from '../../utils/parse.js';
import { guildConfig } from '../../utils/store.js';

const onOff = (envVar, serverValue) =>
  process.env[envVar] !== 'true' ? "Off (disabled in the bot's .env)" : serverValue === false ? 'Off' : 'On';

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the bot for this server')
    .addSubcommand((s) =>
      s
        .setName('log')
        .setDescription('Set the channel where moderation, bot actions and server events are logged (empty = off)')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('filter')
        .setDescription('Turn the offensive-language filter on or off in this server')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('games')
        .setDescription('Turn recording of the games members play on or off in this server')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('view').setDescription('Show current settings'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const config = guildConfig.get(interaction.guild.id, {});
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view') {
      const t = config.tickets;
      const embed = new EmbedBuilder()
        .setTitle(`Settings for ${interaction.guild.name}`)
        .setColor(defaultColor)
        .addFields(
          { name: 'Log channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Off' },
          { name: 'Server event logging', value: onOff('ENABLE_SERVER_LOGS') },
          { name: 'Word filter', value: onOff('ENABLE_WORD_FILTER', config.wordFilter) },
          { name: 'Game tracking', value: onOff('ENABLE_GAME_TRACKING', config.gameTracking) },
          {
            name: 'Tickets',
            value: t
              ? `Channel <#${t.channelId}> · queue <#${t.queueChannelId ?? t.channelId}> · staff <@&${t.staffRoleId}>${t.pingStaff ? ' (pinged)' : ''}`
              : 'Not set up (`/ticket setup`)',
          },
        );
      return interaction.reply({ embeds: [embed], ...ephemeral() });
    }

    if (subcommand === 'filter') {
      const enabled = interaction.options.getBoolean('enabled', true);
      guildConfig.set(interaction.guild.id, { ...config, wordFilter: enabled });
      await interaction.reply(
        ephemeral(
          enabled
            ? 'Word filter is on. Messages with listed words are deleted (Administrators are exempt). I need Manage Messages in each channel.'
            : 'Word filter is off for this server.',
          'success',
        ),
      );
      return logEvent(interaction.guild, {
        title: `Word filter turned ${enabled ? 'on' : 'off'}`,
        color: COLORS.info,
        user: interaction.user,
      });
    }

    if (subcommand === 'games') {
      const enabled = interaction.options.getBoolean('enabled', true);
      guildConfig.set(interaction.guild.id, { ...config, gameTracking: enabled });
      if (!enabled) endGuildSessions(interaction.guild.id);
      await interaction.reply(
        ephemeral(
          enabled
            ? 'Game tracking is on. Members can see stats with `/games` and opt out with `/games privacy`.'
            : 'Game tracking is off for this server. History recorded so far is kept.',
          'success',
        ),
      );
      return logEvent(interaction.guild, {
        title: `Game tracking turned ${enabled ? 'on' : 'off'}`,
        color: COLORS.info,
        user: interaction.user,
      });
    }

    const channel = interaction.options.getChannel('channel');
    if (channel) {
      const me = interaction.guild.members.me;
      if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles])) {
        return interaction.reply(ephemeral(`I need View Channel, Send Messages, Embed Links, and Attach Files in ${channel} first.`));
      }
    }
    // Log the change before turning logging off, and after turning it on, so either way it's recorded.
    const entry = { title: `Log channel ${channel ? `set to #${channel.name}` : 'turned off'}`, color: COLORS.info, user: interaction.user };
    if (!channel) await logEvent(interaction.guild, entry);
    guildConfig.set(interaction.guild.id, { ...config, logChannelId: channel?.id ?? null });
    if (channel) await logEvent(interaction.guild, entry);
    await interaction.reply(ephemeral(channel ? `Logs will be posted in ${channel}.` : 'Logging turned off.', 'success'));
  },
};
