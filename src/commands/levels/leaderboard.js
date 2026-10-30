import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { levelFromXp, levelSettings, ranking } from '../../features/levels.js';
import { ephemeral } from '../../utils/replies.js';
import { defaultColor } from '../../utils/parse.js';

const PAGE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription("This server's most active members by level")
    .addIntegerOption((o) => o.setName('page').setDescription('Page (10 per page)').setMinValue(1))
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const { guild } = interaction;
    if (!levelSettings(guild.id).enabled) return interaction.reply(ephemeral('Levels are turned off in this server.'));
    // People who left keep their XP (in case they come back) but aren't listed.
    const ranked = ranking(guild.id).filter((r) => !guild.members.cache.size || guild.members.cache.has(r.userId));
    if (!ranked.length) return interaction.reply(ephemeral('Nobody has earned any XP yet.', 'info'));

    const pages = Math.ceil(ranked.length / PAGE);
    const page = Math.min(interaction.options.getInteger('page') ?? 1, pages);
    const lines = ranked.slice((page - 1) * PAGE, page * PAGE).map((r, i) => {
      const place = (page - 1) * PAGE + i;
      return `${MEDALS[place] ?? `**${place + 1}.**`} <@${r.userId}> · level ${levelFromXp(r.xp).level} · ${r.xp.toLocaleString()} XP`;
    });
    const mine = ranked.findIndex((r) => r.userId === interaction.user.id);

    const embed = new EmbedBuilder()
      .setColor(defaultColor)
      .setTitle(`${guild.name} leaderboard`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Page ${page} of ${pages}${mine >= 0 ? ` · You're #${mine + 1}` : ''}` });
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
