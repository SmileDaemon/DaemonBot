import { EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, time } from 'discord.js';
import { COLORS, ephemeral, logAction, notice } from '../../utils/moderation.js';
import { warnings } from '../../utils/store.js';

export default {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View or clear warnings')
    .addSubcommand((s) =>
      s
        .setName('view')
        .setDescription("List a user's warnings")
        .addUserOption((o) => o.setName('user').setDescription('User to look up').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('clear')
        .setDescription("Delete all of a user's warnings")
        .addUserOption((o) => o.setName('user').setDescription('User to clear').setRequired(true)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    const guildWarnings = warnings.get(interaction.guild.id, {});
    const userWarnings = guildWarnings[user.id] ?? [];

    if (interaction.options.getSubcommand() === 'clear') {
      if (!userWarnings.length) return interaction.reply(ephemeral(`${user.tag} has no warnings.`, 'info'));
      const { [user.id]: _removed, ...rest } = guildWarnings;
      warnings.set(interaction.guild.id, rest);
      await interaction.reply(notice(`🧹 Cleared ${userWarnings.length} warning(s) for **${user.tag}**.`, { tone: 'success' }));
      return logAction(interaction.guild, {
        action: 'Warnings cleared',
        color: COLORS.undo,
        target: user,
        moderator: interaction.user,
        reason: `Cleared ${userWarnings.length} warning(s)`,
      });
    }

    if (!userWarnings.length) return interaction.reply(ephemeral(`${user.tag} has no warnings.`, 'info'));

    // Embeds allow 25 fields; show the most recent ones.
    const recent = userWarnings.slice(-25);
    const embed = new EmbedBuilder()
      .setTitle(`Warnings for ${user.tag}`)
      .setThumbnail(user.displayAvatarURL())
      .setColor(COLORS.warn)
      .setFooter({ text: `${userWarnings.length} total` })
      .addFields(
        recent.map((w, i) => ({
          name: `#${userWarnings.length - recent.length + i + 1} · ${time(new Date(w.at), 'd')}`,
          value: `${w.reason}\n-# by <@${w.moderatorId}>`,
        })),
      );
    await interaction.reply({ embeds: [embed], ...ephemeral() });
  },
};
