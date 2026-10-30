import { SlashCommandBuilder } from 'discord.js';
import { notice } from '../../utils/replies.js';

export default {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is responding'),

  async execute(interaction) {
    const { resource } = await interaction.reply({ ...notice('Pinging…'), withResponse: true });
    const roundTrip = resource.message.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(notice(`🏓 Pong! Round trip ${roundTrip}ms · Gateway ${interaction.client.ws.ping}ms`, { tone: 'success' }));
  },
};
