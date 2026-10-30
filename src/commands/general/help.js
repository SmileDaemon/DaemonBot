import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { ephemeral } from '../../utils/moderation.js';
import { defaultColor } from '../../utils/parse.js';

export default {
  data: new SlashCommandBuilder().setName('help').setDescription('List available commands'),

  async execute(interaction) {
    const lines = [...interaction.client.commands.values()]
      .filter(({ data }) => data.description) // right-click menu commands have no description
      .map(({ data }) => `**/${data.name}** · ${data.description}`)
      .sort();
    lines.push('', '**Right-click a bot embed → Apps → Edit Embed** · edit it in place');

    const embed = new EmbedBuilder()
      .setTitle(`${interaction.client.user.username} commands`)
      .setColor(defaultColor)
      .setDescription(lines.join('\n'))
      .setFooter({ text: "Moderation commands only appear for members with the matching permission." });
    await interaction.reply({ embeds: [embed], ...ephemeral() });
  },
};
