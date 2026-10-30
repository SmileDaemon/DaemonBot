import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, checkTarget, ephemeral, logAction, notice, notifyUser } from '../../utils/moderation.js';

export default {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the kick').setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason given';

    const error = checkTarget(interaction, member, 'kick');
    if (error) return interaction.reply(ephemeral(error));

    await notifyUser(member.user, `You were kicked from **${interaction.guild.name}**.\nReason: ${reason}`);
    await member.kick(`${interaction.user.tag}: ${reason}`);
    await interaction.reply(notice(`👢 Kicked **${member.user.tag}**.\n**Reason:** ${reason}`, { tone: 'warn' }));
    await logAction(interaction.guild, { action: 'Kick', color: COLORS.kick, target: member.user, moderator: interaction.user, reason });
  },
};
