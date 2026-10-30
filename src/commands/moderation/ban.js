import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, checkTarget, ephemeral, logAction, notice, notifyUser } from '../../utils/moderation.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from the server')
    .addUserOption((o) => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the ban').setMaxLength(500))
    .addIntegerOption((o) =>
      o
        .setName('delete_messages')
        .setDescription('Also delete their recent messages')
        .addChoices(
          { name: "Don't delete any", value: 0 },
          { name: 'Last hour', value: 3_600 },
          { name: 'Last 24 hours', value: 86_400 },
          { name: 'Last 7 days', value: 604_800 },
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    const member = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason given';

    // Users who already left can still be banned; only check hierarchy for current members.
    if (member) {
      const error = checkTarget(interaction, member, 'ban');
      if (error) return interaction.reply(ephemeral(error));
      await notifyUser(user, `You were banned from **${interaction.guild.name}**.\nReason: ${reason}`);
    }

    await interaction.guild.bans.create(user, {
      reason: `${interaction.user.tag}: ${reason}`,
      deleteMessageSeconds: interaction.options.getInteger('delete_messages') ?? 0,
    });
    await interaction.reply(notice(`🔨 Banned **${user.tag}**.\n**Reason:** ${reason}`, { tone: 'error' }));
    await logAction(interaction.guild, { action: 'Ban', color: COLORS.ban, target: user, moderator: interaction.user, reason });
  },
};
