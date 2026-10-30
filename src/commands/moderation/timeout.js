import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, time } from 'discord.js';
import { COLORS, checkTarget, ephemeral, logAction, notice, notifyUser } from '../../utils/moderation.js';
import { parseDuration } from '../../utils/parse.js';

const MAX_TIMEOUT = 28 * 86_400_000; // Discord's limit

export default {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Temporarily stop a member from chatting, reacting, or joining voice')
    .addUserOption((o) => o.setName('user').setDescription('Member to time out').setRequired(true))
    .addStringOption((o) =>
      o.setName('duration').setDescription('How long, e.g. 10m, 1h, 1d, 1h30m (max 28d)').setRequired(true),
    )
    .addStringOption((o) => o.setName('reason').setDescription('Reason for the timeout').setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason given';
    const duration = parseDuration(interaction.options.getString('duration', true));

    if (!duration) return interaction.reply(ephemeral('Invalid duration. Use something like `10m`, `2h`, `1d`, or `1h30m`.'));
    if (duration > MAX_TIMEOUT) return interaction.reply(ephemeral('Timeouts can be at most 28 days.'));

    const error = checkTarget(interaction, member, 'time out');
    if (error) return interaction.reply(ephemeral(error));

    const until = new Date(Date.now() + duration);
    await member.timeout(duration, `${interaction.user.tag}: ${reason}`);
    await notifyUser(member.user, `You were timed out in **${interaction.guild.name}** until ${time(until, 'F')}.\nReason: ${reason}`);
    await interaction.reply(notice(`🔇 Timed out **${member.user.tag}** until ${time(until, 'f')} (${time(until, 'R')}).\n**Reason:** ${reason}`, { tone: 'warn' }));
    await logAction(interaction.guild, {
      action: 'Timeout',
      color: COLORS.timeout,
      target: member.user,
      moderator: interaction.user,
      reason,
      fields: [{ name: 'Until', value: time(until, 'F') }],
    });
  },
};
