import { InteractionContextType, MessageFlags, SlashCommandBuilder, TextInputStyle } from 'discord.js';
import { buildModal, field } from '../../utils/embeds.js';
import { ephemeral, outcome } from '../../utils/replies.js';
import { MAX_OPEN_PER_USER, claimTicket, closeTicket, openTicket, ticketSettings } from '../../features/tickets.js';

const openTicketModal = () =>
  buildModal('ticket:submit', 'Open a ticket', [
    { id: 'subject', label: 'Subject', required: true, max: 80, placeholder: 'Short summary of what you need' },
    { id: 'details', label: 'Details', style: TextInputStyle.Paragraph, required: true, max: 1500 },
  ]);

async function runClose(interaction, channelId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { error } = await closeTicket(interaction, channelId);
  await interaction.editReply(outcome(error, '🔒 Ticket closed.')).catch(() => {});
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open or close a support ticket')
    .addSubcommand((s) => s.setName('open').setDescription('Open a private ticket with the staff team'))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket (use inside the ticket channel)'))
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    switch (interaction.options.getSubcommand()) {
      case 'open':
        if (!ticketSettings(interaction.guild.id)) return interaction.reply(ephemeral("Tickets aren't set up here yet. An admin can run `/setup tickets`."));
        return interaction.showModal(openTicketModal());
      case 'close':
        return runClose(interaction, interaction.channelId);
    }
  },

  async handleButton(interaction) {
    const [, action, channelId] = interaction.customId.split(':');
    if (action === 'open') {
      if (!ticketSettings(interaction.guild.id)) return interaction.reply(ephemeral("Tickets aren't set up here anymore."));
      return interaction.showModal(openTicketModal());
    }
    if (action === 'close') return runClose(interaction, channelId);
    if (action === 'claim') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { error, channel } = await claimTicket(interaction, channelId);
      return interaction.editReply(outcome(error, `You claimed this ticket. Head over to ${channel}.`));
    }
  },

  async handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error, channel } = await openTicket(interaction, field(interaction, 'subject'), field(interaction, 'details'));
    await interaction.editReply(outcome(error, `🎫 Your ticket is open: ${channel}. You can have up to ${MAX_OPEN_PER_USER} open at a time.`));
  },
};
