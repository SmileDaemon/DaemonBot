import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, ephemeral, logAction, notice } from '../../utils/moderation.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Lift a ban')
    .addStringOption((o) => o.setName('user_id').setDescription('ID of the banned user').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the unban').setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const userId = interaction.options.getString('user_id', true).trim();
    const reason = interaction.options.getString('reason') ?? 'No reason given';

    const user = await interaction.guild.bans
      .remove(userId, `${interaction.user.tag}: ${reason}`)
      .catch(() => null);
    if (!user) return interaction.reply(ephemeral(`No ban found for user ID \`${userId}\`.`));

    await interaction.reply(notice(`✅ Unbanned **${user.tag}**.`, { tone: 'success' }));
    await logAction(interaction.guild, { action: 'Unban', color: COLORS.undo, target: user, moderator: interaction.user, reason });
  },
};
