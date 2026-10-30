import { EmbedBuilder, InteractionContextType, SlashCommandBuilder, time } from 'discord.js';
import { forgetUser, hasOptedOut, isTracking, liveMs } from '../../features/gameTracker.js';
import { defaultColor } from '../../utils/parse.js';
import { ephemeral } from '../../utils/replies.js';
import { gameStats } from '../../utils/store.js';

const TOP = 10;
const WEEK = 7 * 24 * 60 * 60_000;

/** 45m, 3h 20m, 2d 4h */
function hours(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h}h ${minutes % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Sessions per week since the game was first seen (counting at least one week). */
const perWeek = (stats) => (stats.sessions / Math.max(1, (stats.last - stats.first) / WEEK)).toFixed(1);

function trackingOffReply(interaction) {
  if (process.env.ENABLE_GAME_TRACKING !== 'true') return ephemeral("Game tracking is turned off in the bot's settings.", 'info');
  if (!isTracking(interaction.guild.id)) return ephemeral('Game tracking is off in this server. An admin can turn it on with `/config games`.', 'info');
  return null;
}

function userStats(interaction) {
  const user = interaction.options.getUser('user') ?? interaction.user;
  const guildId = interaction.guild.id;
  if (user.bot) return interaction.reply(ephemeral("Bots aren't tracked.", 'info'));
  if (hasOptedOut(guildId, user.id)) {
    return interaction.reply(ephemeral(`${user.id === interaction.user.id ? "You've" : `${user.tag} has`} opted out of game tracking.`, 'info'));
  }

  const games = Object.entries(gameStats.get(guildId, {}).users?.[user.id] ?? {})
    .map(([game, stats]) => ({ game, stats, live: liveMs(guildId, user.id, game) }))
    .sort((a, b) => b.stats.ms + b.live - (a.stats.ms + a.live));
  if (!games.length) return interaction.reply(ephemeral(`I haven't seen ${user.id === interaction.user.id ? 'you' : user.tag} play anything yet.`, 'info'));

  const total = games.reduce((sum, g) => sum + g.stats.ms + g.live, 0);
  const embed = new EmbedBuilder()
    .setTitle(`🎮 Games played by ${user.displayName}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(defaultColor)
    .setDescription(`**${hours(total)}** across ${plural(games.length, 'game')}`)
    .addFields(
      games.slice(0, TOP).map(({ game, stats, live }) => ({
        name: `${live ? '🟢 ' : ''}${game}`,
        value:
          `**${hours(stats.ms + live)}** · ${plural(stats.sessions, 'session')} · avg ${hours(stats.ms / stats.sessions)}\n` +
          `${plural(stats.days, 'day')} played · ~${perWeek(stats)}×/week · last ${live ? 'now' : time(new Date(stats.last), 'R')}`,
      })),
    )
    .setFooter({ text: games.length > TOP ? `Showing the top ${TOP} of ${games.length} games` : 'Sessions under a minute are not counted' });
  return interaction.reply({ embeds: [embed] });
}

function serverTop(interaction) {
  const users = gameStats.get(interaction.guild.id, {}).users ?? {};
  const game = interaction.options.getString('game');

  if (game) {
    const players = Object.entries(users)
      .filter(([, games]) => games[game])
      .map(([userId, games]) => ({ userId, stats: games[game] }))
      .sort((a, b) => b.stats.ms - a.stats.ms);
    if (!players.length) return interaction.reply(ephemeral(`Nobody here has played **${game}** yet.`, 'info'));
    const lines = players
      .slice(0, TOP)
      .map(({ userId, stats }, i) => `**${i + 1}.** <@${userId}> · **${hours(stats.ms)}** · ${plural(stats.sessions, 'session')} · last ${time(new Date(stats.last), 'R')}`);
    const total = players.reduce((sum, p) => sum + p.stats.ms, 0);
    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top ${game} players`)
      .setColor(defaultColor)
      .setDescription(`${plural(players.length, 'player')} · ${hours(total)} in total\n\n${lines.join('\n')}`);
    return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  const totals = new Map();
  for (const games of Object.values(users)) {
    for (const [name, stats] of Object.entries(games)) {
      const t = totals.get(name) ?? { ms: 0, sessions: 0, players: 0 };
      t.ms += stats.ms;
      t.sessions += stats.sessions;
      t.players += 1;
      totals.set(name, t);
    }
  }
  if (!totals.size) return interaction.reply(ephemeral("I haven't seen anyone here play anything yet.", 'info'));
  const ranked = [...totals].sort((a, b) => b[1].ms - a[1].ms);
  const lines = ranked
    .slice(0, TOP)
    .map(([name, t], i) => `**${i + 1}. ${name}** · **${hours(t.ms)}** · ${plural(t.players, 'player')} · ${plural(t.sessions, 'session')}`);
  const embed = new EmbedBuilder()
    .setTitle(`🎮 Most played in ${interaction.guild.name}`)
    .setColor(defaultColor)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${plural(ranked.length, 'game')} tracked · /games top game:<name> for its top players` });
  return interaction.reply({ embeds: [embed] });
}

function privacy(interaction) {
  const track = interaction.options.getBoolean('track', true);
  const guildId = interaction.guild.id;
  const data = gameStats.get(guildId, {});
  data.optedOut ??= {};
  if (track) {
    delete data.optedOut[interaction.user.id];
  } else {
    data.optedOut[interaction.user.id] = true;
    if (data.users) delete data.users[interaction.user.id];
    forgetUser(guildId, interaction.user.id);
  }
  gameStats.set(guildId, data);
  return interaction.reply(
    ephemeral(
      track
        ? "Game tracking is on for you in this server. I'll record what you play from now on."
        : "You're opted out. I deleted your game history in this server and won't record any more.",
      'success',
    ),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('games')
    .setDescription('See what games people in this server play, for how long and how often')
    .addSubcommand((s) =>
      s
        .setName('stats')
        .setDescription("A member's games: time played, sessions, how often")
        .addUserOption((o) => o.setName('user').setDescription('Member to look up (defaults to you)')),
    )
    .addSubcommand((s) =>
      s
        .setName('top')
        .setDescription("The server's most played games, or one game's top players")
        .addStringOption((o) => o.setName('game').setDescription('Show the top players of this game').setAutocomplete(true).setMaxLength(100)),
    )
    .addSubcommand((s) =>
      s
        .setName('privacy')
        .setDescription('Opt in or out of game tracking (opting out deletes your history here)')
        .addBooleanOption((o) => o.setName('track').setDescription('Record the games you play?').setRequired(true)),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'privacy') return privacy(interaction);
    const off = trackingOffReply(interaction);
    if (off) return interaction.reply(off);
    return sub === 'stats' ? userStats(interaction) : serverTop(interaction);
  },

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const names = new Set();
    for (const games of Object.values(gameStats.get(interaction.guild.id, {}).users ?? {})) {
      for (const name of Object.keys(games)) if (name.toLowerCase().includes(typed)) names.add(name);
    }
    await interaction.respond([...names].slice(0, 25).map((name) => ({ name, value: name })));
  },
};
