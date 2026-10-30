import { PermissionFlagsBits } from 'discord.js';

export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export const trackLine = (track) =>
  `[${track.info.title}](${track.info.uri}) · ${track.info.author} · ${track.info.isStream ? 'Live' : formatDuration(track.info.duration)}`;

/**
 * Checks everything a music command needs. Returns { error } or { lavalink, player, voiceChannel }.
 * With `requirePlayer`, there must already be music playing in the caller's voice channel.
 */
export function musicContext(interaction, { requirePlayer = true } = {}) {
  const { lavalink } = interaction.client;
  if (!lavalink) return { error: "Music isn't turned on for this bot (ENABLE_MUSIC in .env)." };
  if (![...lavalink.nodeManager.nodes.values()].some((node) => node.connected)) {
    return { error: "I can't reach the music server right now. Ask the bot owner to check that Lavalink is running." };
  }

  const voiceChannel = interaction.member.voice.channel;
  const player = lavalink.getPlayer(interaction.guild.id);
  if (requirePlayer && !player) return { error: "Nothing's playing right now." };
  if (!voiceChannel) return { error: 'Join a voice channel first.' };
  if (player && player.voiceChannelId !== voiceChannel.id) {
    return { error: `I'm playing in <#${player.voiceChannelId}>. Join that channel to control the music.` };
  }
  if (!player && !voiceChannel.permissionsFor(interaction.guild.members.me).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    return { error: `I need Connect and Speak permissions in ${voiceChannel}.` };
  }
  return { lavalink, player, voiceChannel };
}
