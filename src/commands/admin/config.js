import { EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral } from '../../utils/moderation.js';
import { defaultColor } from '../../utils/parse.js';
import { guildConfig } from '../../utils/store.js';

const onOff = (envVar, serverValue) =>
  process.env[envVar] !== 'true' ? "Off (disabled in the bot's .env)" : serverValue === false ? 'Off' : 'On';

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Turn the word filter on or off, or see this server\'s settings (set things up with /setup)')
    .addSubcommand((s) =>
      s
        .setName('filter')
        .setDescription('Turn the offensive-language filter on or off in this server')
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
          {
            name: 'Tickets',
            value: t
              ? `Button in <#${t.channelId}> · queue ${t.queueChannelId ? `<#${t.queueChannelId}>` : 'none'} · staff <@&${t.staffRoleId}>${t.pingStaff ? ' (pinged)' : ''}`
              : 'Not set up (`/setup tickets`)',
          },
        );
      return interaction.reply({ embeds: [embed], ...ephemeral() });
    }

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
  },
};
