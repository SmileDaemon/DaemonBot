import { EmbedBuilder, Events } from 'discord.js';
import { LavalinkManager } from 'lavalink-client';
import { notice } from '../utils/replies.js';
import { formatDuration } from './helpers.js';

const NOW_PLAYING_COLOR = 0x1db954;

/** Connects the bot to the Lavalink audio server described in .env and posts "now playing" updates. */
export function setupMusic(client) {
  const manager = new LavalinkManager({
    nodes: [
      {
        id: 'main',
        host: process.env.LAVALINK_HOST || 'localhost',
        port: Number(process.env.LAVALINK_PORT || 2333),
        authorization: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
        secure: process.env.LAVALINK_SECURE === 'true',
        // Keep retrying, so the bot reconnects whenever Lavalink is (re)started.
        retryAmount: Number.MAX_SAFE_INTEGER,
        retryDelay: 15_000,
      },
    ],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    autoSkip: true,
    playerOptions: {
      defaultSearchPlatform: 'scsearch',
      onDisconnect: { autoReconnect: false, destroyPlayer: true },
      // Leave the voice channel 2 minutes after the queue runs out.
      onEmptyQueue: { destroyAfterMs: 120_000 },
    },
  });
  client.lavalink = manager;

  // Lavalink needs Discord's raw voice events to join voice channels.
  client.on('raw', (packet) => manager.sendRawData(packet));
  client.once(Events.ClientReady, (c) => manager.init({ id: c.user.id, username: c.user.username }));

  manager.nodeManager
    .on('connect', (node) => console.log(`Lavalink: connected to "${node.id}".`))
    .on('disconnect', (node, reason) => console.warn(`Lavalink: disconnected from "${node.id}"`, reason?.reason ?? ''))
    .on('error', (node, err) => console.warn(`Lavalink: can't reach "${node.id}" (${err.message}). Is the Lavalink server running?`));

  const textChannel = (player) => client.channels.cache.get(player.textChannelId);

  manager.on('trackStart', (player, track) => {
    if (!track) return;
    const embed = new EmbedBuilder()
      .setAuthor({ name: 'Now playing' })
      .setTitle(track.info.title)
      .setURL(track.info.uri)
      .setDescription(`by **${track.info.author}** · ${track.info.isStream ? 'Live' : formatDuration(track.info.duration)}`)
      .setThumbnail(track.info.artworkUrl)
      .setColor(NOW_PLAYING_COLOR);
    if (track.requester) embed.setFooter({ text: `Requested by ${track.requester.username}` });
    textChannel(player)?.send({ embeds: [embed] }).catch(() => {});
  });

  manager.on('queueEnd', (player) => {
    textChannel(player)?.send(notice("Queue finished. I'll leave the voice channel in 2 minutes unless something is added.")).catch(() => {});
  });

  // Leave when everyone else has left the voice channel.
  client.on(Events.VoiceStateUpdate, (before) => {
    const player = manager.getPlayer(before.guild.id);
    if (!player || before.channelId !== player.voiceChannelId) return;
    const channel = before.guild.channels.cache.get(player.voiceChannelId);
    if (channel && !channel.members.some((m) => !m.user.bot)) {
      textChannel(player)?.send(notice('Everyone left the voice channel, so I stopped the music.')).catch(() => {});
      player.destroy('channel empty').catch(console.error);
    }
  });
}
