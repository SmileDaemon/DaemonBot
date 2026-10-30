import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, checkTarget, ephemeral, logAction, notice } from '../../utils/moderation.js';

export default {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription("Remove a member's timeout early")
    .addUserOption((o) => o.setName('user').setDescription('Member to un-timeout').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason given';

    const error = checkTarget(interaction, member, 'un-timeout');
    if (error) return interaction.reply(ephemeral(error));
    if (!member.isCommunicationDisabled()) return interaction.reply(ephemeral(`${member.user.tag} isn't timed out.`));

    await member.timeout(null, `${interaction.user.tag}: ${reason}`);
    await interaction.reply(notice(`🔊 Removed timeout for **${member.user.tag}**.`, { tone: 'success' }));
    await logAction(interaction.guild, { action: 'Timeout removed', color: COLORS.undo, target: member.user, moderator: interaction.user, reason });
  },
};
