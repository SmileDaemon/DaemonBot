import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, TextInputStyle } from 'discord.js';
import { buildModal, field } from '../../utils/embeds.js';
import { ephemeral, outcome } from '../../utils/replies.js';
import { MAX_OPEN_PER_USER, claimTicket, closeTicket, openTicket, resetPanel, ticketSettings, ticketTypeMenu, ticketTypes } from '../../features/tickets.js';
import { KEEP_DAYS, transcriptFile, transcriptOf, transcriptsIn } from '../../features/transcripts.js';

/** The form for a ticket of the type at `index` in the server's list. */
const openTicketModal = (guildId, index = 0) =>
  buildModal(`ticket:submit:${index}`, `Open a ticket: ${ticketTypes(ticketSettings(guildId))[index] ?? 'Support'}`.slice(0, 45), [
    { id: 'subject', label: 'Subject', required: true, max: 80, placeholder: 'Short summary of what you need' },
    { id: 'details', label: 'Details', style: TextInputStyle.Paragraph, required: true, max: 1500 },
  ]);

const notSetUp = "Tickets aren't set up here yet. An admin can run `/setup tickets`.";

/** Staff can export any transcript; members only those of their own tickets. */
const canSeeAll = (member) =>
  member.permissions.has(PermissionFlagsBits.ManageGuild) || member.roles.cache.has(ticketSettings(member.guild.id)?.staffRoleId ?? '');

async function exportTranscripts(interaction) {
  const number = interaction.options.getInteger('number');
  const all = canSeeAll(interaction.member);
  const mine = (t) => all || t.openerId === interaction.user.id;
  const list = number ? [transcriptOf(interaction.guild.id, number)].filter(Boolean) : transcriptsIn(interaction.guild.id);
  const visible = list.filter(mine);
  if (!visible.length) {
    return interaction.reply(ephemeral(number ? `There's no transcript of ticket #${number} you can export. Transcripts are kept for ${KEEP_DAYS} days after a ticket closes.` : `There are no transcripts ${all ? 'here' : 'of your tickets'} to export. They're kept for ${KEEP_DAYS} days after a ticket closes.`));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const files = visible.map((t) => transcriptFile(interaction.guild, t));
  // Discord takes up to 10 files a message.
  for (let i = 0; i < files.length; i += 10) {
    const batch = { content: i ? undefined : `${files.length} transcript${files.length === 1 ? '' : 's'}. Save them somewhere safe: the bot deletes each one ${KEEP_DAYS} days after its ticket closed.`, files: files.slice(i, i + 10), flags: MessageFlags.Ephemeral };
    if (i) await interaction.followUp(batch);
    else await interaction.editReply(batch);
  }
}

async function runClose(interaction, channelId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { error } = await closeTicket(interaction, channelId);
  await interaction.editReply(outcome(error, '🔒 Ticket closed.')).catch(() => {});
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open, close or export support tickets')
    .addSubcommand((s) => s.setName('open').setDescription('Open a private ticket with the staff team'))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket (use inside the ticket channel)'))
    .addSubcommand((s) =>
      s
        .setName('export')
        .setDescription(`Download ticket transcripts (kept ${KEEP_DAYS} days after a ticket closes)`)
        .addIntegerOption((o) => o.setName('number').setDescription('Just this ticket number (all of them if left out)').setMinValue(1)),
    )
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
      case 'export':
        return exportTranscripts(interaction);
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
