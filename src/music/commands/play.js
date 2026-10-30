import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { musicContext } from '../../music/helpers.js';
import { ephemeral, notice } from '../../utils/moderation.js';

const SPOTIFY = /open\.spotify\.com|^spotify:/i;
const YOUTUBE = /youtube\.com|youtu\.be/i;

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song: search SoundCloud, or paste a SoundCloud, Bandcamp, Twitch, Vimeo or direct audio link')
    .addStringOption((o) => o.setName('query').setDescription('Song name or link').setRequired(true).setMaxLength(500))
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const query = interaction.options.getString('query', true).trim();
    if (SPOTIFY.test(query)) {
      return interaction.reply(ephemeral("Spotify links aren't supported: Spotify doesn't allow bots to stream its audio. Try searching the song name instead."));
    }
    if (YOUTUBE.test(query)) {
      return interaction.reply(ephemeral("YouTube links aren't supported: streaming from YouTube breaks its terms of service. Try searching the song name instead."));
    }

    const { error, lavalink, voiceChannel, player: existing } = musicContext(interaction, { requirePlayer: false });
    if (error) return interaction.reply(ephemeral(error));

    await interaction.deferReply();
    const player =
      existing ??
      lavalink.createPlayer({
        guildId: interaction.guild.id,
        voiceChannelId: voiceChannel.id,
        textChannelId: interaction.channelId,
        selfDeaf: true,
        volume: 60,
      });
    if (!player.connected) await player.connect();

    const result = await player.search({ query, source: 'scsearch' }, interaction.user);
    if (!result?.tracks.length || result.loadType === 'error' || result.loadType === 'empty') {
      if (!player.playing && !player.queue.tracks.length) await player.destroy();
      // A failed lookup isn't "no results": a search source can break when the site changes (SoundCloud did in 2026).
      const isLink = /^https?:\/\//i.test(query);
      const message =
        result?.loadType === 'error'
          ? isLink
            ? `That link couldn't be loaded (${result.exception?.message ?? 'the music server reported an error'}).`
            : "Searching isn't working right now: the music server couldn't reach SoundCloud. Paste a direct link instead (Bandcamp, Vimeo, Twitch, or an audio/radio stream)."
          : `Couldn't find anything for **${query}**.`;
      return interaction.editReply(notice(message, { tone: 'error' }));
    }

    const queuedBefore = player.queue.current ? player.queue.tracks.length + 1 : 0;
    if (result.loadType === 'playlist') {
      await player.queue.add(result.tracks);
      await interaction.editReply(notice(`📃 Added playlist **${result.playlist?.name ?? 'playlist'}** (${result.tracks.length} tracks).`));
    } else {
      const [track] = result.tracks;
      await player.queue.add(track);
      await interaction.editReply(
        notice(
          queuedBefore ? `➕ Queued **${track.info.title}** by ${track.info.author} (position ${queuedBefore}).` : `▶️ Starting **${track.info.title}** by ${track.info.author}.`,
        ),
      );
    }

    if (!player.playing) await player.play();
  },
};
