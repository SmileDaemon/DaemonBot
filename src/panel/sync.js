import { existsSync, readFileSync, statSync } from 'node:fs';
import { Events } from 'discord.js';
import { count, drain, enableAnalytics, gauge, markActive, restore } from './analytics.js';
import { runPanelCommand } from './commands.js';
import { guildSnapshot, musicState } from './snapshot.js';
import { wordsFile } from '../features/wordFilter.js';
import { isOptedOut } from '../utils/store.js';

const SYNC_MS = 10_000;
// Unchanged snapshots are re-sent this often anyway, in case the panel's database was reset.
const REFRESH_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

const started = Date.now();

/**
 * Keeps the control panel up to date. Every few seconds the bot sends its status,
 * what changed in each server, counts and log entries, and collects any changes
 * made in the panel. Only outgoing requests: nothing on this machine is exposed.
 */
export function startPanel(client) {
  const base = process.env.PANEL_URL?.replace(/\/+$/, '');
  const secret = process.env.PANEL_SECRET;
  if (!base || !secret) return;
  enableAnalytics();

  // Counting for the analytics pages.
  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild() || message.author.bot) return;
    count(message.guildId, 'messages', message.channelId);
    if (!isOptedOut(message.guildId, message.author.id)) markActive(message.guildId, message.author.id);
  });
  client.on(Events.GuildMemberAdd, (member) => count(member.guild.id, 'joins'));
  client.on(Events.GuildMemberRemove, (member) => count(member.guild.id, 'leaves'));
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.inGuild() && (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand())) {
      count(interaction.guildId, 'commands', interaction.commandName);
    }
  });
  client.lavalink?.on('trackStart', (p) => count(p.guildId, 'tracks'));

  const sentSnapshots = new Map(); // guild ID -> { json, at }
  const musicSent = new Set(); // guilds whose last report had a player
  let wordsMtime = 0;
  let backoff = SYNC_MS;
  let warned = false;
  let results = []; // outcomes of the panel's changes, reported on the next sync

  async function sync() {
    const now = Date.now();
    const guilds = [...client.guilds.cache.values()];

    const snapshots = [];
    const music = {};
    for (const guild of guilds) {
      gauge(guild.id, 'members', guild.memberCount);
      const snapshot = guildSnapshot(guild);
      const text = JSON.stringify(snapshot);
      const last = sentSnapshots.get(guild.id);
      if (!last || last.json !== text || now - last.at > REFRESH_MS) snapshots.push({ snapshot, text });

      const state = musicState(client, guild.id);
      if (state) music[guild.id] = state;
      else if (musicSent.has(guild.id)) music[guild.id] = null; // tell the panel it stopped
    }

    let wordlist;
    const wordsPath = wordsFile();
    if (existsSync(wordsPath)) {
      const mtime = statSync(wordsPath).mtimeMs;
      if (mtime !== wordsMtime) wordlist = readFileSync(wordsPath, 'utf8');
    }

    const pending = drain();
    const body = {
      status: {
        tag: client.user.tag,
        avatar: client.user.displayAvatarURL({ size: 128 }),
        startedAt: started,
        ping: client.ws.ping,
        guildCount: guilds.length,
        memberCount: guilds.reduce((n, g) => n + g.memberCount, 0),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        node: process.version,
        lavalink: client.lavalink ? { connected: client.lavalink.nodeManager.nodes.some((n) => n.connected) } : null,
        features: {
          serverLogs: process.env.ENABLE_SERVER_LOGS === 'true',
          wordFilter: process.env.ENABLE_WORD_FILTER === 'true',
          gameTracking: process.env.ENABLE_GAME_TRACKING === 'true',
          voiceTracking: process.env.ENABLE_VOICE_TRACKING === 'true',
          activityTracking: process.env.ENABLE_ACTIVITY_TRACKING === 'true',
          connectionTracking: process.env.ENABLE_CONNECTION_TRACKING === 'true',
          levels: process.env.ENABLE_LEVELS === 'true',
          music: process.env.ENABLE_MUSIC === 'true',
          messageQuotes: process.env.ENABLE_MESSAGE_QUOTES === 'true',
        },
      },
      guildIds: guilds.map((g) => g.id),
      snapshots: snapshots.map((s) => s.snapshot),
      music,
      stats: pending.stats,
      logs: pending.logs,
      wordlist,
      results,
    };

    let reply;
    try {
      const res = await fetch(`${base}/bot/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      reply = await res.json();
    } catch (err) {
      restore(pending);
      if (!warned) console.warn(`Control panel: can't reach ${base} (${err.message}). Retrying quietly.`);
      warned = true;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      return;
    }

    if (warned) console.log('Control panel: connected again.');
    warned = false;
    backoff = SYNC_MS;
    results = [];
    for (const s of snapshots) sentSnapshots.set(s.snapshot.id, { json: s.text, at: now });
    for (const [id, state] of Object.entries(music)) {
      if (state) musicSent.add(id);
      else musicSent.delete(id);
    }
    if (wordlist !== undefined) wordsMtime = statSync(wordsPath).mtimeMs;

    // Apply the panel's changes in order; their results go back on the next sync.
    for (const command of reply.commands ?? []) {
      results.push(await runPanelCommand(client, command));
      if (command.guildId) sentSnapshots.delete(command.guildId); // re-send the server right away
    }
    if (reply.commands?.length) backoff = 1_000; // answer quickly while someone is using the panel
  }

  async function loop() {
    await sync().catch((err) => console.error('Control panel sync failed:', err));
    setTimeout(loop, backoff).unref();
  }
  client.once(Events.ClientReady, () => {
    console.log(`Control panel: syncing with ${base}.`);
    loop();
  });
}
