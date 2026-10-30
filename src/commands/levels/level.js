import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { levelFromXp, levelSettings, levelsIn, ranking } from '../../features/levels.js';
import { ephemeral } from '../../utils/replies.js';
import { defaultColor } from '../../utils/parse.js';
import { isOptedOut } from '../../utils/store.js';

const bar = (into, needed, width = 12) => {
  const filled = Math.round((into / needed) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
};

export default {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription("Show your level in this server, or someone else's")
    .addUserOption((o) => o.setName('member').setDescription('Whose level to show (default: you)'))
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const { guild } = interaction;
    if (!levelSettings(guild.id).enabled) return interaction.reply(ephemeral('Levels are turned off in this server.'));
    const user = interaction.options.getUser('member') ?? interaction.user;
    if (user.bot) return interaction.reply(ephemeral("Bots don't earn levels."));
    if (isOptedOut(guild.id, user.id)) return interaction.reply(ephemeral(`${user} has opted out of statistics in this server, so they have no level.`));

    const xp = levelsIn(guild.id)[user.id]?.xp ?? 0;
    const { level, into, needed } = levelFromXp(xp);
    const rank = ranking(guild.id).find((r) => r.userId === user.id)?.rank;
    const embed = new EmbedBuilder()
      .setColor(defaultColor)
      .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
      .setTitle(`Level ${level}`)
      .setDescription(`${bar(into, needed)}\n**${into.toLocaleString()}** / ${needed.toLocaleString()} XP to level ${level + 1}`)
      .addFields(
        { name: 'Total XP', value: xp.toLocaleString(), inline: true },
        { name: 'Rank', value: rank ? `#${rank}` : 'Unranked', inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  },
};
