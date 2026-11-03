import { InteractionContextType, MessageFlags, SlashCommandBuilder, TextInputStyle } from 'discord.js';
import { buildModal, field } from '../../utils/embeds.js';
import { ephemeral, outcome } from '../../utils/replies.js';
import { MAX_OPEN_PER_USER, claimTicket, closeTicket, openTicket, resetPanel, ticketSettings, ticketTypeMenu, ticketTypes } from '../../features/tickets.js';

/** The form for a ticket of the type at `index` in the server's list. */
const openTicketModal = (guildId, index = 0) =>
  buildModal(`ticket:submit:${index}`, `Open a ticket: ${ticketTypes(ticketSettings(guildId))[index] ?? 'Support'}`.slice(0, 45), [
    { id: 'subject', label: 'Subject', required: true, max: 80, placeholder: 'Short summary of what you need' },
    { id: 'details', label: 'Details', style: TextInputStyle.Paragraph, required: true, max: 1500 },
  ]);

const notSetUp = "Tickets aren't set up here yet. An admin can run `/setup tickets`.";

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
      case 'open': {
        const settings = ticketSettings(interaction.guild.id);
        if (!settings) return interaction.reply(ephemeral(notSetUp));
        // With more than one type, ask which first.
        if (ticketTypes(settings).length > 1) {
          return interaction.reply({ content: 'What is your ticket about?', components: [ticketTypeMenu(settings)], flags: MessageFlags.Ephemeral });
        }
        return interaction.showModal(openTicketModal(interaction.guild.id));
      }
      case 'close':
        return runClose(interaction, interaction.channelId);
    }
  },

  async handleButton(interaction) {
    const [, action, channelId] = interaction.customId.split(':');
    // The "Open a ticket" button from before tickets had types.
    if (action === 'open') {
      if (!ticketSettings(interaction.guild.id)) return interaction.reply(ephemeral(notSetUp));
      return interaction.showModal(openTicketModal(interaction.guild.id));
    }
    if (action === 'close') return runClose(interaction, channelId);
    if (action === 'claim') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { error, channel } = await claimTicket(interaction, channelId);
      return interaction.editReply(outcome(error, `You claimed this ticket. Head over to ${channel}.`));
    }
  },

  // A type picked from the dropdown.
  async handleSelect(interaction) {
    if (!ticketSettings(interaction.guild.id)) return interaction.reply(ephemeral(notSetUp));
    return interaction.showModal(openTicketModal(interaction.guild.id, Number(interaction.values[0]) || 0));
  },

  async handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const index = Number(interaction.customId.split(':')[2]) || 0;
    const type = ticketTypes(ticketSettings(interaction.guild.id))[index] ?? null;
    const { error, channel } = await openTicket(interaction, field(interaction, 'subject'), field(interaction, 'details'), type);
    await resetPanel(interaction.message, interaction.guild.id);
    await interaction.editReply(outcome(error, `🎫 Your ticket is open: ${channel}. You can have up to ${MAX_OPEN_PER_USER} open at a time.`));
  },
};
