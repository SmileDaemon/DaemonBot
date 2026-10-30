import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, checkTarget, ephemeral, logAction, notice, notifyUser } from '../../utils/moderation.js';
import { warnings } from '../../utils/store.js';

export default {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Give a member a formal warning (recorded, view with /warnings)')
    .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the warning').setRequired(true).setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason', true);

    const error = checkTarget(interaction, member, 'warn');
    if (error) return interaction.reply(ephemeral(error));

    const guildWarnings = warnings.get(interaction.guild.id, {});
    const userWarnings = [...(guildWarnings[member.id] ?? []), { reason, moderatorId: interaction.user.id, at: Date.now() }];
    warnings.set(interaction.guild.id, { ...guildWarnings, [member.id]: userWarnings });

    await notifyUser(member.user, `You received a warning in **${interaction.guild.name}**.\nReason: ${reason}`);
    await interaction.reply(notice(`⚠️ Warned **${member.user.tag}** (warning #${userWarnings.length}).\n**Reason:** ${reason}`, { tone: 'warn' }));
    await logAction(interaction.guild, {
      action: 'Warning',
      color: COLORS.warn,
      target: member.user,
      moderator: interaction.user,
      reason,
      fields: [{ name: 'Total warnings', value: String(userWarnings.length), inline: true }],
    });
  },
};
