import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, logEvent, markBotDeleted, transcriptFile } from '../../utils/logging.js';
import { notice } from '../../utils/replies.js';

export default {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk-delete recent messages in this channel')
    .addIntegerOption((o) =>
      o.setName('amount').setDescription('How many messages to delete (1–100)').setRequired(true).setMinValue(1).setMaxValue(100),
    )
    .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const amount = interaction.options.getInteger('amount', true);
    const user = interaction.options.getUser('user');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let messages = await interaction.channel.messages.fetch({ limit: 100 });
    if (user) messages = messages.filter((m) => m.author.id === user.id);
    const toDelete = [...messages.values()].slice(0, amount);

    markBotDeleted(toDelete.map((m) => m.id));
    // `true` skips messages older than 14 days, which Discord won't bulk-delete.
    const deleted = await interaction.channel.bulkDelete(toDelete, true);
    const skipped = toDelete.length - deleted.size;
    await interaction.editReply(
      notice(
        `🗑️ Deleted ${deleted.size} message(s)${user ? ` from ${user.tag}` : ''}.` +
          (skipped ? ` Skipped ${skipped} older than 14 days (Discord doesn't allow bulk-deleting those).` : ''),
        { tone: 'success' },
      ),
    );

    if (!deleted.size) return;
    await logEvent(interaction.guild, {
      title: 'Messages purged',
      color: COLORS.delete,
      user: interaction.user,
      fields: [
        { name: 'Channel', value: `${interaction.channel}`, inline: true },
        { name: 'Count', value: String(deleted.size), inline: true },
        ...(user ? [{ name: 'From user', value: `${user} (${user.id})`, inline: true }] : []),
      ],
      files: [transcriptFile(toDelete.filter((m) => deleted.has(m.id)))],
    });
  },
};
