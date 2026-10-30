import { Events } from 'discord.js';
import { onShutdown } from '../utils/shutdown.js';
import { connectionStats, guildConfig } from '../utils/store.js';
import { currentPlayers } from './gameTracker.js';
import { liveVoice, voiceOf } from './voiceTracker.js';

// Interactions are batched like activity counts, and games played together are sampled on the same tick.
const FLUSH_MS = 60_000;
// Two people talking in the same channel this close together count as chatting with each other.
const CHAT_GAP_MS = 2 * 60_000;
// A message pinging a crowd says little about who someone knows, so only the first few mentions count.
const MAX_MENTIONS = 5;
// How much each kind of interaction adds to a connection's score. Time together is per 10 minutes.
const WEIGHTS = { replies: 3, mentions: 2, reactions: 1, chats: 1, per10Min: 1 };
// Connections weaker than this are left out when working out groups, so one stray reply doesn't merge two.
const MIN_GROUP_EDGE = 5;
const MIN_GROUP_SIZE = 3;

// guildId -> Map(pairKey -> { replies, mentions, reactions, chats, gameMs, games: Map(game -> ms), at })
const pending = new Map();
// channelId -> { userId, at }: who spoke last, for spotting back-and-forth conversation
const lastSpeaker = new Map();
let lastSample = Date.now();

const isTracking = (guildId) => guildConfig.get(guildId, {}).connectionTracking !== false;

const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function note(guildId, a, b, kind, amount = 1, game) {
  if (a === b) return;
  if (!pending.has(guildId)) pending.set(guildId, new Map());
  const pairs = pending.get(guildId);
  const key = pairKey(a, b);
  const p = pairs.get(key) ?? { replies: 0, mentions: 0, reactions: 0, chats: 0, gameMs: 0, games: new Map(), at: 0 };
  p[kind] += amount;
  if (game) p.games.set(game, (p.games.get(game) ?? 0) + amount);
  p.at = Date.now();
  pairs.set(key, p);
}

/** Credits everyone in the same server playing the same game with the time since the last sample. */
function sampleGames(client) {
  const now = Date.now();
  const elapsed = Math.min(now - lastSample, FLUSH_MS * 2); // don't credit a long stall (sleep, lag) in full
  lastSample = now;
  const playing = currentPlayers();
  if (!playing.length) return;
  for (const guild of client.guilds.cache.values()) {
    if (!isTracking(guild.id)) continue;
    const byGame = new Map();
    for (const [userId, games] of playing) {
      if (!guild.members.cache.has(userId)) continue;
      for (const game of games) byGame.set(game, [...(byGame.get(game) ?? []), userId]);
    }
    for (const [game, ids] of byGame) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) note(guild.id, ids[i], ids[j], 'gameMs', elapsed, game);
    }
  }
}

function flush() {
  for (const [guildId, pairs] of pending) {
    const data = connectionStats.get(guildId, {});
    for (const [key, p] of pairs) {
      const rec = (data[key] ??= { replies: 0, mentions: 0, reactions: 0, chats: 0, gameMs: 0, games: {}, first: p.at, last: p.at });
      for (const kind of ['replies', 'mentions', 'reactions', 'chats', 'gameMs']) rec[kind] += p[kind];
      for (const [game, ms] of p.games) rec.games[game] = (rec.games[game] ?? 0) + ms;
      rec.last = p.at;
    }
    connectionStats.set(guildId, data);
  }
  pending.clear();
}

/** Voice time each pair of members spent together in this server's channels, including stays in progress. */
function voicePairs(guild) {
  // Each person's record says how long they were with the other; the two can differ slightly
  // (a stay under a minute isn't saved), so the larger of the two is used.
  const seen = new Map();
  const add = (a, b, ms) => {
    const key = pairKey(a, b);
    const both = seen.get(key) ?? {};
    both[a] = (both[a] ?? 0) + ms;
    seen.set(key, both);
  };
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    for (const rec of Object.values(voiceOf(member.id))) {
      if (rec.guildId === guild.id) for (const [other, ms] of Object.entries(rec.with ?? {})) add(member.id, other, ms);
    }
    const live = liveVoice(member.id);
    if (live && guild.channels.cache.has(live.channelId)) for (const [other, ms] of live.with) add(member.id, other, ms);
  }
  return new Map([...seen].map(([key, both]) => [key, Math.max(...Object.values(both))]));
}

const scoreOf = (c) =>
  c.replies * WEIGHTS.replies +
  c.mentions * WEIGHTS.mentions +
  c.reactions * WEIGHTS.reactions +
  c.chats * WEIGHTS.chats +
  ((c.voiceMs + c.gameMs) / 600_000) * WEIGHTS.per10Min;

/** One pass of Louvain: moves each node to the neighbouring community that most improves modularity. */
function localMoves(graph) {
  const nodes = [...graph.keys()].sort();
  const degree = new Map();
  let total = 0;
  for (const [n, row] of graph) {
    let k = 0;
    for (const w of row.values()) k += w;
    degree.set(n, k);
    total += k;
  }
  const community = new Map(nodes.map((n) => [n, n]));
  const tot = new Map(degree);
  if (!total) return community;
  let improved = true;
  for (let pass = 0; improved && pass < 20; pass++) {
    improved = false;
    for (const n of nodes) {
      const k = degree.get(n);
      const current = community.get(n);
      const links = new Map();
      for (const [m, w] of graph.get(n)) if (m !== n) links.set(community.get(m), (links.get(community.get(m)) ?? 0) + w);
      tot.set(current, tot.get(current) - k);
      let best = current;
      let bestGain = (links.get(current) ?? 0) - (tot.get(current) * k) / total;
      for (const [c, w] of links) {
        const gain = w - (tot.get(c) * k) / total;
        if (gain > bestGain + 1e-9) {
          best = c;
          bestGain = gain;
        }
      }
      tot.set(best, tot.get(best) + k);
      if (best !== current) {
        community.set(n, best);
        improved = true;
      }
    }
  }
  return community;
}

/** Collapses each community into one node, keeping the weight inside it as a self-loop. */
function aggregate(graph, community) {
  const next = new Map();
  for (const [n, row] of graph) {
    const c = community.get(n);
    if (!next.has(c)) next.set(c, new Map());
    const out = next.get(c);
    for (const [m, w] of row) out.set(community.get(m), (out.get(community.get(m)) ?? 0) + w);
  }
  return next;
}

/** Splits a weighted graph (Map(node -> Map(node -> weight))) into groups that talk mostly among themselves. */
function findGroups(graph) {
  const membership = new Map([...graph.keys()].map((n) => [n, n]));
  for (let level = 0; level < 10; level++) {
    const community = localMoves(graph);
    if ([...community].every(([n, c]) => n === c)) break;
    for (const [n, node] of membership) membership.set(n, community.get(node));
    graph = aggregate(graph, community);
  }
  const groups = new Map();
  for (const [n, c] of membership) groups.set(c, [...(groups.get(c) ?? []), n]);
  return [...groups.values()];
}

const topGames = (games, limit = 5) =>
  Object.entries(games)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([game, ms]) => ({ game, ms }));

/**
 * Who in this server is connected to whom, and the groups they form. Built from replies, mentions,
 * reactions to each other's messages, back-and-forth chat, voice time together and games played together.
 */
export function connectionsIn(guild, nameOf) {
  if (!isTracking(guild.id)) return { pairs: [], members: [], groups: [] };

  const stored = connectionStats.get(guild.id, {});
  const voice = voicePairs(guild);
  const empty = { replies: 0, mentions: 0, reactions: 0, chats: 0, gameMs: 0, games: {}, first: null, last: null };
  const unsaved = pending.get(guild.id) ?? new Map();
  const pairs = [];
  for (const key of new Set([...Object.keys(stored), ...voice.keys(), ...unsaved.keys()])) {
    const [a, b] = key.split('-');
    if (!guild.members.cache.has(a) || !guild.members.cache.has(b)) continue; // someone left
    const c = { ...empty, ...stored[key], voiceMs: voice.get(key) ?? 0 };
    // Interactions from the last minute that haven't been saved yet
    const p = unsaved.get(key);
    if (p) {
      for (const kind of ['replies', 'mentions', 'reactions', 'chats', 'gameMs']) c[kind] += p[kind];
      c.games = { ...c.games };
      for (const [game, ms] of p.games) c.games[game] = (c.games[game] ?? 0) + ms;
      c.first ??= p.at;
      c.last = p.at;
    }
    const score = scoreOf(c);
    if (score > 0) pairs.push({ a, b, score, ...c });
  }

  // Graph of the stronger connections, for groups
  const graph = new Map();
  const link = (x, y, w) => {
    if (!graph.has(x)) graph.set(x, new Map());
    graph.get(x).set(y, w);
  };
  for (const p of pairs) {
    if (p.score < MIN_GROUP_EDGE) continue;
    link(p.a, p.b, p.score);
    link(p.b, p.a, p.score);
  }

  const groupOf = new Map();
  const groups = findGroups(graph)
    .filter((ids) => ids.length >= MIN_GROUP_SIZE)
    .map((ids) => {
      const inside = new Set(ids);
      const internal = pairs.filter((p) => inside.has(p.a) && inside.has(p.b));
      const strength = new Map(ids.map((id) => [id, 0]));
      const games = {};
      for (const p of internal) {
        strength.set(p.a, strength.get(p.a) + p.score);
        strength.set(p.b, strength.get(p.b) + p.score);
        for (const [game, ms] of Object.entries(p.games)) games[game] = (games[game] ?? 0) + ms;
      }
      const sum = (field) => internal.reduce((s, p) => s + p[field], 0);
      const members = ids
        .map((userId) => ({ userId, username: nameOf(userId), score: Math.round(strength.get(userId)) }))
        .sort((x, y) => y.score - x.score);
      return {
        // The lowest member ID, so a group keeps its ID while its membership is unchanged
        id: [...ids].sort()[0],
        size: ids.length,
        members,
        score: Math.round(sum('score')),
        // Share of possible pairs in the group that have any connection at all
        cohesion: Number((internal.length / ((ids.length * (ids.length - 1)) / 2)).toFixed(2)),
        messages: sum('replies') + sum('mentions') + sum('chats'),
        reactions: sum('reactions'),
        voiceMs: sum('voiceMs'),
        gameMs: sum('gameMs'),
        topGames: topGames(games),
        last: Math.max(...internal.map((p) => p.last ?? 0)) || null,
      };
    })
    .sort((x, y) => y.score - x.score);
  for (const g of groups) for (const m of g.members) groupOf.set(m.userId, g.id);

  // Each member's strongest connections
  const byMember = new Map();
  for (const p of pairs) {
    for (const [self, other] of [[p.a, p.b], [p.b, p.a]]) {
      const list = byMember.get(self) ?? [];
      list.push({ userId: other, username: nameOf(other), score: Math.round(p.score) });
      byMember.set(self, list);
    }
  }
  const members = [...byMember]
    .map(([userId, list]) => ({
      userId,
      username: nameOf(userId),
      score: Math.round(list.reduce((s, c) => s + c.score, 0)),
      connections: list.length,
      groupId: groupOf.get(userId) ?? null,
      top: list.sort((x, y) => y.score - x.score).slice(0, 10),
    }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 100);

  return {
    pairs: pairs
      .sort((x, y) => y.score - x.score)
      .slice(0, 100)
      .map((p) => ({
        a: { userId: p.a, username: nameOf(p.a) },
        b: { userId: p.b, username: nameOf(p.b) },
        score: Math.round(p.score),
        replies: p.replies,
        mentions: p.mentions,
        reactions: p.reactions,
        chats: p.chats,
        voiceMs: p.voiceMs,
        gameMs: p.gameMs,
        topGames: topGames(p.games, 3),
        first: p.first,
        last: p.last,
      })),
    members,
    groups,
  };
}

export function registerConnectionTracker(client) {
  client.on(Events.MessageCreate, (message) => {
    if (!message.guild || message.author.bot || message.system || !isTracking(message.guild.id)) return;
    const { guild, author, channelId } = message;
    const now = Date.now();

    const replied = message.mentions.repliedUser;
    if (replied && !replied.bot) note(guild.id, author.id, replied.id, 'replies');
    const mentioned = [...message.mentions.users.values()].filter((u) => !u.bot && u.id !== replied?.id).slice(0, MAX_MENTIONS);
    for (const user of mentioned) note(guild.id, author.id, user.id, 'mentions');

    const prev = lastSpeaker.get(channelId);
    if (prev && prev.userId !== author.id && now - prev.at <= CHAT_GAP_MS) note(guild.id, author.id, prev.userId, 'chats');
    lastSpeaker.set(channelId, { userId: author.id, at: now });
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    const { guildId } = reaction.message;
    if (!guildId || user.bot || !isTracking(guildId)) return;
    // Reactions on messages from before the bot started arrive without the author
    const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    const author = message?.author;
    if (author && !author.bot) note(guildId, user.id, author.id, 'reactions');
  });

  setInterval(() => {
    sampleGames(client);
    flush();
  }, FLUSH_MS).unref();
  onShutdown(flush);
}
