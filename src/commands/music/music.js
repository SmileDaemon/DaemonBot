import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { formatDuration, musicContext, trackLine } from '../../music/helpers.js';
import { ephemeral, notice } from '../../utils/moderation.js';

const QUEUE_PAGE = 10;
const LOOP_LABELS = { off: 'Loop off', track: '🔂 Looping this song', queue: '🔁 Looping the whole queue' };

export default {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Control the music player (you must be in the same voice channel)')
    .addSubcommand((s) => s.setName('skip').setDescription('Skip the current song'))
    .addSubcommand((s) => s.setName('pause').setDescription('Pause or resume'))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop, clear the queue, and leave the voice channel'))
    .addSubcommand((s) => s.setName('queue').setDescription('Show what is playing and up next'))
    .addSubcommand((s) => s.setName('nowplaying').setDescription('Show the current song'))
    .addSubcommand((s) => s.setName('shuffle').setDescription('Shuffle the queue'))
    .addSubcommand((s) =>
      s
        .setName('volume')
        .setDescription('Set the volume')
        .addIntegerOption((o) => o.setName('percent').setDescription('1–150').setRequired(true).setMinValue(1).setMaxValue(150)),
    )
    .addSubcommand((s) =>
      s
        .setName('loop')
        .setDescription('Repeat the current song or the whole queue')
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('What to repeat')
            .setRequired(true)
            .addChoices({ name: 'Off', value: 'off' }, { name: 'This song', value: 'track' }, { name: 'Whole queue', value: 'queue' }),
        ),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const { error, player } = musicContext(interaction);
    if (error) return interaction.reply(ephemeral(error));
    const current = player.queue.current;

    switch (interaction.options.getSubcommand()) {
      case 'skip':
        if (player.queue.tracks.length) await player.skip();
        else await player.stopPlaying(true, false);
        return interaction.reply(notice(`⏭️ Skipped **${current?.info.title ?? 'the current song'}**.`));

      case 'pause':
        if (player.paused) {
          await player.resume();
          return interaction.reply(notice('▶️ Resumed.'));
        }
        await player.pause();
        return interaction.reply(notice('⏸️ Paused. Use `/music pause` again to resume.'));

      case 'stop':
        await player.destroy(`stopped by ${interaction.user.tag}`);
        return interaction.reply(notice('⏹️ Stopped the music and left the voice channel.'));

      case 'shuffle': {
        if (player.queue.tracks.length < 2) return interaction.reply(ephemeral('Need at least 2 songs in the queue to shuffle.'));
        await player.queue.shuffle();
        return interaction.reply(notice(`🔀 Shuffled ${player.queue.tracks.length} songs.`));
      }

      case 'volume': {
        const percent = interaction.options.getInteger('percent', true);
        await player.setVolume(percent);
        return interaction.reply(notice(`🔊 Volume set to ${percent}%.`));
      }

      case 'loop': {
        const mode = interaction.options.getString('mode', true);
        await player.setRepeatMode(mode);
        return interaction.reply(notice(LOOP_LABELS[mode]));
      }

      case 'nowplaying': {
        if (!current) return interaction.reply(ephemeral("Nothing's playing right now.", 'info'));
        const progress = current.info.isStream ? 'Live' : `${formatDuration(player.position)} / ${formatDuration(current.info.duration)}`;
        const embed = new EmbedBuilder()
          .setTitle(current.info.title)
          .setURL(current.info.uri)
          .setDescription(`by **${current.info.author}**\n${progress}${player.paused ? ' · paused' : ''}`)
          .setThumbnail(current.info.artworkUrl)
          .setColor(0x1db954);
        return interaction.reply({ embeds: [embed] });
      }

      case 'queue': {
        const upcoming = player.queue.tracks;
        const lines = upcoming.slice(0, QUEUE_PAGE).map((t, i) => `**${i + 1}.** ${trackLine(t)}`);
        if (upcoming.length > QUEUE_PAGE) lines.push(`…and ${upcoming.length - QUEUE_PAGE} more`);
        const embed = new EmbedBuilder()
          .setTitle('Queue')
          .setColor(0x1db954)
          .setDescription(
            `**Now playing**\n${current ? trackLine(current) : 'Nothing'}\n\n**Up next (${upcoming.length})**\n` +
              (lines.join('\n') || 'Nothing queued. Add songs with `/play`.'),
          )
          .setFooter({ text: `Volume ${player.volume}% · ${LOOP_LABELS[player.repeatMode]}` });
        return interaction.reply({ embeds: [embed] });
      }
    }
  },
};
