import { ChannelType } from 'discord.js';
import { activityIn } from '../features/activityTracker.js';
import { connectionsIn } from '../features/connectionTracker.js';
import { gamesOf, liveMs } from '../features/gameTracker.js';
import { levelSettings } from '../features/levels.js';
import { liveVoice, voiceOf } from '../features/voiceTracker.js';
import { guildConfig, isOptedOut, tickets, warnings } from '../utils/store.js';

const env = (name) => process.env[name] === 'true';

const userName = (guild, id) =>
  guild.members.cache.get(id)?.displayName ?? guild.client.users.cache.get(id)?.username ?? `Unknown (${id})`;

const WEEK = 7 * 24 * 60 * 60_000;

/**
 * Voice time in this server's channels, per member and per channel. Records are per user across every
 * server, but a server's panel only shows its own channels (each entry still names its server).
 */
function voiceSnapshot(guild) {
  const members = [];
  const channels = new Map();
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (isOptedOut(guild.id, member.id)) continue;
    const records = Object.entries(voiceOf(member.id)).filter(([, r]) => r.guildId === guild.id);
    const live = liveVoice(member.id);
    const inThisServer = live && guild.channels.cache.has(live.channelId);
    if (inThisServer && !records.some(([id]) => id === live.channelId)) {
      records.push([live.channelId, { guildId: guild.id, ms: 0, sessions: 0, days: 0, first: live.since, last: live.since, with: {} }]);
    }
    if (!records.length) continue;

    const list = records.map(([channelId, r]) => {
      const isLive = inThisServer && live.channelId === channelId;
      const withMs = { ...r.with };
      if (isLive) for (const [id, ms] of live.with) withMs[id] = (withMs[id] ?? 0) + ms;
      return {
        channelId,
        channelName: guild.channels.cache.get(channelId)?.name ?? r.channelName ?? 'deleted channel',
        guildId: guild.id,
        guildName: guild.name,
        ms: r.ms + (isLive ? live.ms : 0),
        sessions: r.sessions + (isLive && !r.sessions ? 1 : 0),
        days: r.days,
        perWeek: Number((r.sessions / Math.max(1, (r.last - r.first) / WEEK)).toFixed(1)),
        first: r.first,
        last: isLive ? Date.now() : r.last,
        inChannelNow: Boolean(isLive),
        with: Object.entries(withMs)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([userId, ms]) => ({ userId, username: userName(guild, userId), ms })),
      };
    });
    list.sort((a, b) => b.ms - a.ms);
    members.push({
      userId: member.id,
      username: member.displayName,
      ms: list.reduce((sum, c) => sum + c.ms, 0),
      inChannelNow: inThisServer ? list.find((c) => c.inChannelNow)?.channelName ?? null : null,
      channels: list,
    });
    for (const c of list) {
      const t = channels.get(c.channelId) ?? { channelId: c.channelId, channelName: c.channelName, ms: 0, members: 0, sessions: 0 };
      t.ms += c.ms;
      t.members += 1;
      t.sessions += c.sessions;
      channels.set(c.channelId, t);
    }
  }
  return {
    channels: [...channels.values()].sort((a, b) => b.ms - a.ms),
    members: members.sort((a, b) => b.ms - a.ms).slice(0, 50),
  };
}

/** How active each member is in this server: messages, reactions, active days, voice time, recent days. */
function activitySnapshot(guild, voice) {
  const voiceMs = new Map(voice.members.map((m) => [m.userId, m.ms]));
  const now = Date.now();
  const recentDays = Array.from({ length: 30 }, (_, i) => new Date(now - (29 - i) * 864e5).toISOString().slice(0, 10));
  const records = activityIn(guild.id);
  const ids = new Set([...Object.keys(records), ...voiceMs.keys()]);
  return [...ids]
    .filter((id) => guild.members.cache.has(id))
    .map((userId) => {
      const r = records[userId] ?? { messages: 0, reactions: 0, days: 0, first: null, last: null, channels: {}, daily: {} };
      const daily = recentDays.map((day) => ({ day, count: r.daily[day] ?? 0 }));
      return {
        userId,
        username: userName(guild, userId),
        messages: r.messages,
        reactions: r.reactions,
        activeDays: r.days,
        activeDaysLast30: daily.filter((d) => d.count).length,
        last30: daily.reduce((sum, d) => sum + d.count, 0),
        voiceMs: voiceMs.get(userId) ?? 0,
        first: r.first,
        last: r.last,
        topChannels: Object.entries(r.channels)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([channelId, count]) => ({ channelId, channelName: guild.channels.cache.get(channelId)?.name ?? 'deleted channel', count })),
        daily,
      };
    })
    .sort((a, b) => b.last30 - a.last30 || b.voiceMs - a.voiceMs)
    .slice(0, 100);
}

/** Everything the panel shows about one server, as plain data. */
export function guildSnapshot(guild) {
  const config = guildConfig.get(guild.id, {});

  const channels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => (a.parent?.position ?? -1) - (b.parent?.position ?? -1) || a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null }));

  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));

  const ticketList = Object.values(tickets.get(guild.id, {}).byThread ?? {}).sort((a, b) => b.createdAt - a.createdAt);
  const ticketCounts = { pending: 0, active: 0, archived: 0 };
  for (const t of ticketList) ticketCounts[t.status] = (ticketCounts[t.status] ?? 0) + 1;

  const warned = Object.entries(warnings.get(guild.id, {}))
    .filter(([, list]) => list.length)
    .map(([userId, list]) => ({
      userId,
      username: userName(guild, userId),
      warnings: list.map((w) => ({ reason: w.reason, moderator: userName(guild, w.moderatorId), at: w.at })),
    }))
    .sort((a, b) => b.warnings.length - a.warnings.length);

  // Game time counted in this server only. A session in progress is included, flagged with playingNow.
  const games = new Map();
  const gameMembers = [];
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (isOptedOut(guild.id, member.id)) continue;
    const played = Object.entries(gamesOf(guild.id, member.id)).map(([game, s]) => {
      const live = liveMs(guild.id, member.id, game);
      return {
        game,
        ms: s.ms + live,
        sessions: s.sessions,
        days: s.days,
        perWeek: Number((s.sessions / Math.max(1, (s.last - s.first) / (7 * 24 * 60 * 60_000))).toFixed(1)),
        first: s.first,
        last: live ? Date.now() : s.last,
        playingNow: live > 0,
      };
    });
    if (!played.length) continue;
    played.sort((a, b) => b.ms - a.ms);
    gameMembers.push({
      userId: member.id,
      username: member.displayName,
      ms: played.reduce((sum, g) => sum + g.ms, 0),
      playingNow: played.filter((g) => g.playingNow).map((g) => g.game),
      games: played.slice(0, 10),
    });
    for (const p of played) {
      const g = games.get(p.game) ?? { game: p.game, ms: 0, players: 0, sessions: 0, topPlayers: [] };
      g.ms += p.ms;
      g.players += 1;
      g.sessions += p.sessions;
      g.topPlayers.push({ userId: member.id, username: member.displayName, ms: p.ms, sessions: p.sessions, last: p.last });
      games.set(p.game, g);
    }
  }
  for (const g of games.values()) g.topPlayers = g.topPlayers.sort((a, b) => b.ms - a.ms).slice(0, 10);

  const voice = voiceSnapshot(guild);

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ size: 128 }),
    memberCount: guild.memberCount,
    features: {
      serverLogs: env('ENABLE_SERVER_LOGS'),
      wordFilter: env('ENABLE_WORD_FILTER'),
      gameTracking: env('ENABLE_GAME_TRACKING'),
      voiceTracking: env('ENABLE_VOICE_TRACKING'),
      activityTracking: env('ENABLE_ACTIVITY_TRACKING'),
      connectionTracking: env('ENABLE_CONNECTION_TRACKING'),
      levels: env('ENABLE_LEVELS'),
      music: env('ENABLE_MUSIC'),
    },
    settings: {
      logChannelId: config.logChannelId ?? null,
      wordFilter: config.wordFilter !== false,
      gameTracking: config.gameTracking !== false,
      voiceTracking: config.voiceTracking !== false,
      activityTracking: config.activityTracking !== false,
      connectionTracking: config.connectionTracking !== false,
      levels: levelSettings(guild.id).enabled,
      tickets: config.tickets ?? null,
    },
    channels,
    roles,
    tickets: {
      counts: ticketCounts,
      list: ticketList.slice(0, 100).map((t) => ({
        number: t.number,
        subject: t.subject,
        status: t.status,
        opener: t.openerName ?? userName(guild, t.openerId),
        claimer: t.claimerId ? userName(guild, t.claimerId) : null,
        createdAt: t.createdAt,
        claimedAt: t.claimedAt ?? null,
        closedAt: t.closedAt ?? null,
        threadId: t.threadId,
      })),
    },
    warnings: warned,
    games: [...games.values()].sort((a, b) => b.ms - a.ms).slice(0, 25),
    gameMembers: gameMembers.sort((a, b) => b.ms - a.ms).slice(0, 50),
    voice,
    activity: activitySnapshot(guild, voice),
    connections: connectionsIn(guild, (id) => userName(guild, id)),
  };
}

/** The music player's state in a server, or null when nothing is playing. */
export function musicState(client, guildId) {
  const player = client.lavalink?.getPlayer(guildId);
  if (!player) return null;
  const track = (t) => ({
    title: t.info.title,
    author: t.info.author,
    uri: t.info.uri,
    duration: t.info.isStream ? null : t.info.duration,
    artwork: t.info.artworkUrl ?? null,
  });
  return {
    current: player.queue.current ? track(player.queue.current) : null,
    position: player.position,
    paused: player.paused,
    volume: player.volume,
    repeat: player.repeatMode,
    voiceChannel: client.channels.cache.get(player.voiceChannelId)?.name ?? null,
    queue: player.queue.tracks.slice(0, 25).map(track),
    queueLength: player.queue.tracks.length,
  };
}
