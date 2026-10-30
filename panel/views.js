import { api, sendCommand } from './api.js';
import { chart, rankTable } from './charts.js';
import { ago, dateTime, duration, esc, hex, hours, lastDays, num, toast } from './util.js';

// ---------------------------------------------------------------------------
//   Shared pieces
// ---------------------------------------------------------------------------

const loading = '<div class="empty">Loading…</div>';

function offlineBanner(bot) {
  if (bot?.online) return '';
  return `<div class="banner warn">The bot is offline${bot?.lastSeen ? ` (last seen ${esc(ago(bot.lastSeen))})` : ''}. What you see is from then, and changes are applied when it's back.</div>`;
}

const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

function channelOptions(guild, selected, none = 'Off') {
  let html = option('', none, !selected);
  let category;
  for (const c of guild.channels) {
    if (c.category !== category) {
      if (category !== undefined) html += '</optgroup>';
      category = c.category;
      html += `<optgroup label="${esc(category ?? 'No category')}">`;
    }
    html += option(c.id, `#${c.name}`, c.id === selected);
  }
  return html + (category !== undefined ? '</optgroup>' : '');
}

const channelName = (guild, id) => {
  const c = guild.channels.find((ch) => ch.id === id);
  return c ? `#${c.name}` : id ? 'a deleted channel' : 'none';
};

/** Runs a panel change with its button disabled, then calls `after`. */
async function act(button, guildId, type, payload, after) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Waiting for the bot…';
  }
  try {
    toast(await sendCommand(guildId, type, payload));
    await after?.();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function logEntry(e) {
  const fields = e.fields?.length
    ? `<div class="fields">${e.fields.map((f) => `<div><b>${esc(f.name)}</b>${esc(f.value)}</div>`).join('')}</div>`
    : '';
  return `<div class="log" style="border-left-color:${hex(e.color)}">
    <div class="meta">${e.user?.avatar ? `<img class="avatar" src="${esc(e.user.avatar)}" alt="">` : ''}
      <span class="title" style="color:var(--text)">${esc(e.title)}</span>
      ${e.user ? `<span>${esc(e.user.tag)}</span>` : ''}<span title="${esc(dateTime(e.at))}">${esc(ago(e.at))}</span></div>
    ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}${fields}</div>`;
}

/** Sums stats rows into { metric: { day: total } } and { metric: { key: total } }. */
function aggregate(rows) {
  const byDay = {};
  const byKey = {};
  for (const r of rows) {
    ((byDay[r.metric] ??= {})[r.day] ??= 0);
    byDay[r.metric][r.day] += r.value;
    ((byKey[r.metric] ??= {})[r.key] ??= 0);
    byKey[r.metric][r.key] += r.value;
  }
  return { byDay, byKey };
}

const seriesFor = (byDay, metric, days, fillGaps = false) => {
  let last = null;
  return days.map((d) => {
    const v = byDay[metric]?.[d];
    if (v != null) last = v;
    return v ?? (fillGaps ? last : 0);
  });
};

const ranked = (obj = {}) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

// ---------------------------------------------------------------------------
//   Overview
// ---------------------------------------------------------------------------

export async function overview(main, { guildId }) {
  main.innerHTML = loading;
  const [guild, stats, logs] = await Promise.all([
    api(`/api/guilds/${guildId}`),
    api(`/api/guilds/${guildId}/stats?days=30`),
    api(`/api/guilds/${guildId}/logs?limit=6`),
  ]);
  const days = lastDays(30);
  const { byDay } = aggregate(stats.rows);
  const today = days.at(-1);
  const week = days.slice(-7);
  const sum = (metric, range) => range.reduce((n, d) => n + (byDay[metric]?.[d] ?? 0), 0);
  const openTickets = (guild.tickets.counts.pending ?? 0) + (guild.tickets.counts.active ?? 0);

  const kpi = (label, value, note = '') => `<div class="card kpi"><div class="value">${esc(value)}</div><div class="label">${esc(label)}${note ? ` · ${esc(note)}` : ''}</div></div>`;

  main.innerHTML = `${offlineBanner(guild.bot)}
    <div class="grid kpis">
      ${kpi('Members', num(guild.memberCount))}
      ${kpi('Messages today', num(byDay.messages?.[today] ?? 0))}
      ${kpi('Active today', num(byDay.active_users?.[today] ?? 0), 'people')}
      ${kpi('Joined this week', num(sum('joins', week)), `${num(sum('leaves', week))} left`)}
      ${kpi('Open tickets', num(openTickets), `${num(guild.tickets.counts.pending ?? 0)} unclaimed`)}
      ${kpi('Warned members', num(guild.warnings.length))}
    </div>
    <div class="grid" style="margin-top:16px">
      <div class="card"><h2>Messages, last 30 days</h2>${chart({ labels: days, series: [{ name: 'messages', values: seriesFor(byDay, 'messages', days) }] })}</div>
      <div class="card"><h2>Members</h2>${chart({ labels: days, type: 'line', minZero: false, series: [{ name: 'members', values: seriesFor(byDay, 'members', days).map((v) => v || null) }] })}</div>
      <div class="card wide"><div class="header-row"><h2>Latest log entries</h2><span class="spacer" style="flex:1"></span><a href="#/g/${esc(guildId)}/logs">All logs →</a></div>
        ${logs.entries.length ? logs.entries.map(logEntry).join('') : '<div class="empty">No log entries yet.</div>'}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
//   Analytics
// ---------------------------------------------------------------------------

export async function analytics(main, { guildId, query }) {
  const range = [7, 30, 90, 365].includes(Number(query.get('days'))) ? Number(query.get('days')) : 30;
  main.innerHTML = loading;
  const [guild, stats] = await Promise.all([api(`/api/guilds/${guildId}`), api(`/api/guilds/${guildId}/stats?days=${range}`)]);
  const days = lastDays(range);
  const { byDay, byKey } = aggregate(stats.rows);
  const channelLabel = (id) => channelName(guild, id);

  const rangeLinks = [7, 30, 90, 365]
    .map((d) => `<a class="button${d === range ? ' primary' : ''}" href="#/g/${esc(guildId)}/analytics?days=${d}">${d === 365 ? '1 year' : `${d} days`}</a>`)
    .join('');

  main.innerHTML = `${offlineBanner(guild.bot)}
    <div class="row" style="margin-bottom:16px">${rangeLinks}</div>
    <div class="grid">
      <div class="card wide"><h2>Messages per day</h2>${chart({ labels: days, wide: true, series: [{ name: 'messages', values: seriesFor(byDay, 'messages', days) }] })}</div>
      <div class="card"><h2>Active members per day</h2><p class="muted small">Different people who sent at least one message.</p>${chart({ labels: days, type: 'line', series: [{ name: 'people', values: seriesFor(byDay, 'active_users', days) }] })}</div>
      <div class="card"><h2>Member count</h2>${chart({ labels: days, type: 'line', minZero: false, series: [{ name: 'members', values: seriesFor(byDay, 'members', days).map((v) => v || null) }] })}</div>
      <div class="card"><h2>Joins and leaves</h2>${chart({ labels: days, series: [{ name: 'joined', values: seriesFor(byDay, 'joins', days) }, { name: 'left', values: seriesFor(byDay, 'leaves', days) }] })}</div>
      <div class="card"><h2>Bot commands used</h2>${chart({ labels: days, series: [{ name: 'commands', values: seriesFor(byDay, 'commands', days) }] })}</div>
      <div class="card"><h2>Busiest channels</h2>${rankTable(ranked(byKey.messages).map(([id, v]) => [channelLabel(id), v]), { label: 'Channel', value: 'Messages' })}</div>
      <div class="card"><h2>Commands</h2>${rankTable(ranked(byKey.commands).map(([k, v]) => [`/${k}`, v]), { label: 'Command', value: 'Uses' })}</div>
      <div class="card"><h2>Logged events</h2>${rankTable(ranked(byKey.events), { label: 'Event', value: 'Times', limit: 15 })}</div>
      <div class="card"><h2>Songs played</h2>${chart({ labels: days, series: [{ name: 'songs', values: seriesFor(byDay, 'tracks', days) }] })}</div>
    </div>
    <p class="muted small">Games, voice and each member's activity are on the <a href="#/g/${esc(guildId)}/activity">Activity</a> tab.</p>`;
}

// ---------------------------------------------------------------------------
//   Activity: games, voice and each member, from the bot's trackers
// ---------------------------------------------------------------------------

const trackerOff = (guild, feature, label) =>
  !guild.features[feature]
    ? `${label} is off in the bot's .env.`
    : guild.settings[feature] === false
      ? `${label} is turned off for this server.`
      : null;

/** A row of tiny bars, one per day. */
function sparkline(daily) {
  const max = Math.max(...daily.map((d) => d.count), 1);
  const w = 4;
  const bars = daily
    .map((d, i) => {
      const h = d.count ? Math.max((d.count / max) * 20, 1) : 0;
      return `<rect x="${i * (w + 1)}" y="${20 - h}" width="${w}" height="${h}" class="s1"><title>${esc(d.day)}: ${num(d.count)}</title></rect>`;
    })
    .join('');
  return `<span class="chart"><svg viewBox="0 0 ${daily.length * (w + 1)} 20" style="width:${daily.length * 5}px;height:20px;display:inline-block;vertical-align:middle">${bars}</svg></span>`;
}

function gamesSection(guild) {
  const off = trackerOff(guild, 'gameTracking', 'Game tracking');
  const games = guild.games ?? [];
  if (!games.length) return `<div class="card wide"><h2>Games</h2><div class="empty">${esc(off ?? 'No games recorded yet.')}</div></div>`;
  const members = guild.gameMembers ?? [];
  const playingNow = members.filter((m) => m.playingNow?.length);
  const topPlayers = (g) => (g.topPlayers ?? []).map((p) => `${esc(p.username)} <span class="muted">${esc(hours(p.ms))}</span>`).join(' · ');

  return `
    <div class="card wide"><h2>Games</h2><p class="muted small">From what members show as Playing in Discord. Members who opted out aren't included. Click a game for its top players.${off ? ` ${esc(off)}` : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Game</th><th class="num">Time played</th><th class="num">Players</th><th class="num">Sessions</th></tr></thead><tbody>${games
        .map((g) => `<tr><td><details><summary>${esc(g.game)}</summary><div class="small" style="margin-top:4px">${topPlayers(g) || '<span class="muted">—</span>'}</div></details></td>
          <td class="num">${esc(hours(g.ms))}</td><td class="num">${num(g.players)}</td><td class="num">${num(g.sessions)}</td></tr>`)
        .join('')}</tbody></table></div></div>
    <div class="card"><h2>Playing now</h2>${playingNow.length
      ? `<div class="table-wrap"><table><tbody>${playingNow.map((m) => `<tr><td>${esc(m.username)}</td><td>${esc(m.playingNow.join(', '))}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Nobody is playing anything right now.</div>'}</div>
    <div class="card"><h2>Most time in games</h2>${rankTable(members.map((m) => [m.username, m.ms]), { label: 'Member', value: 'Time', format: hours })}</div>`;
}

function voiceSection(guild) {
  const off = trackerOff(guild, 'voiceTracking', 'Voice tracking');
  const voice = guild.voice ?? { channels: [], members: [] };
  if (!voice.channels.length) return `<div class="card wide"><h2>Voice</h2><div class="empty">${esc(off ?? 'No voice time recorded yet.')}</div></div>`;
  const inVoice = voice.members.filter((m) => m.inChannelNow);
  return `
    <div class="card"><h2>Voice channels</h2>${off ? `<p class="muted small">${esc(off)}</p>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Channel</th><th class="num">Time</th><th class="num">Members</th><th class="num">Sessions</th></tr></thead><tbody>${voice.channels
        .map((c) => `<tr><td>🔊 ${esc(c.channelName)}</td><td class="num">${esc(hours(c.ms))}</td><td class="num">${num(c.members)}</td><td class="num">${num(c.sessions)}</td></tr>`)
        .join('')}</tbody></table></div></div>
    <div class="card"><h2>In voice now</h2>${inVoice.length
      ? `<div class="table-wrap"><table><tbody>${inVoice.map((m) => `<tr><td>${esc(m.username)}</td><td>🔊 ${esc(m.inChannelNow)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Nobody is in a voice channel.</div>'}</div>
    <div class="card"><h2>Most time in voice</h2>${rankTable(voice.members.map((m) => [m.username, m.ms]), { label: 'Member', value: 'Time', format: hours })}</div>`;
}

/** Everything known about one member, shown when their row is opened. */
function memberDetail(m, voice, games) {
  const parts = [];
  if (m.daily) parts.push(`<div><b>Messages, last 30 days</b>${sparkline(m.daily)}</div>`);
  if (m.topChannels?.length) parts.push(`<div><b>Most-used channels</b>${m.topChannels.map((c) => `#${esc(c.channelName)} <span class="muted">${num(c.count)}</span>`).join(' · ')}</div>`);
  if (voice?.channels.length) {
    parts.push(`<div><b>Voice</b>${voice.channels
      .map((c) => `🔊 ${esc(c.channelName)} <span class="muted">${esc(hours(c.ms))} · ${num(c.sessions)} sessions · ${esc(c.perWeek)}/week</span>${
        c.with?.length ? `\n<span class="muted small">With: ${c.with.map((w) => `${esc(w.username)} (${esc(hours(w.ms))})`).join(', ')}</span>` : ''}`)
      .join('\n')}</div>`);
  }
  if (games?.games?.length) {
    parts.push(`<div><b>Games</b>${games.games
      .map((g) => `${esc(g.game)} <span class="muted">${esc(hours(g.ms))} · ${num(g.sessions)} sessions · ${esc(g.perWeek)}/week · last ${esc(ago(g.last))}</span>`)
      .join('\n')}</div>`);
  }
  return parts.length
    ? `<div class="log" style="border-left-color:var(--accent);margin-top:6px"><div class="fields" style="grid-template-columns:1fr">${parts.join('')}</div></div>`
    : '<p class="muted small">Nothing else recorded.</p>';
}

function membersSection(guild, query) {
  const off = trackerOff(guild, 'activityTracking', 'Activity tracking');
  const voiceBy = new Map((guild.voice?.members ?? []).map((m) => [m.userId, m]));
  const gamesBy = new Map((guild.gameMembers ?? []).map((m) => [m.userId, m]));

  // Everyone any tracker knows about, most active first.
  const rows = new Map((guild.activity ?? []).map((a) => [a.userId, a]));
  for (const m of [...voiceBy.values(), ...gamesBy.values()]) {
    if (!rows.has(m.userId)) {
      rows.set(m.userId, { userId: m.userId, username: m.username, messages: 0, reactions: 0, activeDaysLast30: 0, last30: 0, voiceMs: voiceBy.get(m.userId)?.ms ?? 0, last: null });
    }
  }
  if (!rows.size) return `<div class="card wide"><h2>Members</h2><div class="empty">${esc(off ?? 'No member activity recorded yet.')}</div></div>`;
  const q = (query.get('member') ?? '').toLowerCase();
  const list = [...rows.values()].filter((m) => !q || m.username.toLowerCase().includes(q));

  return `<div class="card wide"><h2>Members</h2>
    <p class="muted small">Message and reaction counts only, never message text. Click a member for their channels, voice and games.${off ? ` ${esc(off)}` : ''}</p>
    <form class="row" id="membersearch" style="margin-bottom:10px"><input type="search" name="member" placeholder="Find a member…" value="${esc(query.get('member') ?? '')}"><button>Find</button></form>
    ${list.length
      ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Messages (30 d)</th><th class="num">Active days (30 d)</th><th class="num">Messages (all)</th><th class="num">Reactions</th><th class="num">Voice</th><th>Last active</th></tr></thead><tbody>${list
          .slice(0, 100)
          .map((m) => `<tr><td><details><summary>${esc(m.username)}</summary>${memberDetail(m, voiceBy.get(m.userId), gamesBy.get(m.userId))}</details></td>
            <td class="num">${num(m.last30)}</td><td class="num">${num(m.activeDaysLast30)}</td><td class="num">${num(m.messages)}</td><td class="num">${num(m.reactions)}</td>
            <td class="num">${m.voiceMs ? esc(hours(m.voiceMs)) : '—'}</td><td>${m.last ? esc(ago(m.last)) : '—'}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<div class="empty">No member matches that.</div>'}</div>`;
}

export async function activity(main, { guildId, query }) {
  main.innerHTML = loading;
  const guild = await api(`/api/guilds/${guildId}`);
  main.innerHTML = `${offlineBanner(guild.bot)}<div class="grid">${membersSection(guild, query)}${voiceSection(guild)}${gamesSection(guild)}</div>`;
  main.querySelector('#membersearch')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = e.target.elements.member.value.trim();
    location.hash = `#/g/${guildId}/activity${value ? `?member=${encodeURIComponent(value)}` : ''}`;
  });
}

// ---------------------------------------------------------------------------
//   Connections: who talks, plays and hangs out with whom
// ---------------------------------------------------------------------------

const pct = (n) => `${Math.round(n * 100)}%`;

/** What a pair's or group's score is made of, skipping parts that are zero. */
function breakdown(x) {
  return [
    x.replies && `${num(x.replies)} replies`,
    x.mentions && `${num(x.mentions)} mentions`,
    x.messages && `${num(x.messages)} messages`,
    x.reactions && `${num(x.reactions)} reactions`,
    x.chats && `${num(x.chats)} back-and-forths`,
    x.voiceMs && `${hours(x.voiceMs)} in voice`,
    x.gameMs && `${hours(x.gameMs)} gaming`,
  ].filter(Boolean).map(esc).join(' · ') || '—';
}

const gameList = (games) => (games ?? []).map((g) => `${esc(g.game)} <span class="muted">${esc(hours(g.ms))}</span>`).join(' · ');

function groupsSection(c, off, groupNo) {
  if (!c.groups.length) {
    return `<div class="card wide"><h2>Groups</h2><div class="empty">${esc(off ?? 'No groups yet. A group is 3 or more members who mostly interact with each other.')}</div></div>`;
  }
  return `<div class="card wide"><h2>Groups</h2>
    <p class="muted small">Members who mostly interact with each other. Tightness is how many of the group's members are connected to each other. Click a group for its members.</p>
    <div class="table-wrap"><table><thead><tr><th>Group</th><th class="num">Members</th><th class="num">Score</th><th class="num">Tightness</th><th>Last active</th></tr></thead><tbody>${c.groups
      .map((g) => `<tr><td><details><summary>Group ${groupNo.get(g.id)} <span class="muted">${esc(g.members.slice(0, 3).map((m) => m.username).join(', '))}${g.size > 3 ? ` +${g.size - 3}` : ''}</span></summary>
          <div class="log" style="border-left-color:var(--accent);margin-top:6px"><div class="fields" style="grid-template-columns:1fr">
            <div><b>Members</b>${g.members.map((m) => `${esc(m.username)} <span class="muted">${num(m.score)}</span>`).join(' · ')}</div>
            <div><b>Together</b>${breakdown(g)}</div>
            ${g.topGames?.length ? `<div><b>Games they play together</b>${gameList(g.topGames)}</div>` : ''}
          </div></div></details></td>
        <td class="num">${num(g.size)}</td><td class="num">${num(g.score)}</td><td class="num">${esc(pct(g.cohesion))}</td><td>${g.last ? esc(ago(g.last)) : '—'}</td></tr>`)
      .join('')}</tbody></table></div></div>`;
}

function pairsSection(c, off) {
  if (!c.pairs.length) return `<div class="card wide"><h2>Strongest pairs</h2><div class="empty">${esc(off ?? 'No connections recorded yet.')}</div></div>`;
  return `<div class="card wide"><h2>Strongest pairs</h2>
    <p class="muted small">Click a pair for what they do together.</p>
    <div class="table-wrap"><table><thead><tr><th>Pair</th><th class="num">Score</th><th>Since</th><th>Last</th></tr></thead><tbody>${c.pairs
      .slice(0, 50)
      .map((p) => `<tr><td><details><summary>${esc(p.a.username)} ↔ ${esc(p.b.username)}</summary>
          <div class="small" style="margin-top:4px">${breakdown(p)}${p.topGames?.length ? `<br>Games: ${gameList(p.topGames)}` : ''}</div></details></td>
        <td class="num">${num(p.score)}</td><td>${p.first ? esc(ago(p.first)) : '—'}</td><td>${p.last ? esc(ago(p.last)) : '—'}</td></tr>`)
      .join('')}</tbody></table></div></div>`;
}

function connectedMembersSection(c, groupNo) {
  if (!c.members.length) return '';
  return `<div class="card wide"><h2>Closest connections</h2>
    <p class="muted small">Each member's strongest connections. Click a member to see them.</p>
    <div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Score</th><th class="num">Connections</th><th>Group</th></tr></thead><tbody>${c.members
      .map((m) => `<tr><td><details><summary>${esc(m.username)}</summary>
          <div class="small" style="margin-top:4px">${m.top.map((t) => `${esc(t.username)} <span class="muted">${num(t.score)}</span>`).join(' · ') || '<span class="muted">—</span>'}</div></details></td>
        <td class="num">${num(m.score)}</td><td class="num">${num(m.connections)}</td><td>${m.groupId && groupNo.has(m.groupId) ? `Group ${groupNo.get(m.groupId)}` : '—'}</td></tr>`)
      .join('')}</tbody></table></div></div>`;
}

/** Groups, pairs and members for one server's connections, or the part of them a search matched. */
function connectionsGrid(c, empty) {
  // A search result carries each group's number from the server's full list.
  const groupNo = c.groupNumbers ? new Map(Object.entries(c.groupNumbers)) : new Map(c.groups.map((g, i) => [g.id, i + 1]));
  return `<div class="grid">${groupsSection(c, empty, groupNo)}${pairsSection(c, empty)}${connectedMembersSection(c, groupNo)}</div>`;
}

/** A search box that puts the search in the page's address as ?q=, so it survives refreshes. */
function searchForm(base, q, placeholder) {
  return `<form class="row" id="connsearch" style="margin-bottom:12px" data-base="${esc(base)}">
    <input type="search" name="q" placeholder="${esc(placeholder)}" value="${esc(q)}" style="flex:1;min-width:200px">
    <button class="primary">Search</button>${q ? `<a class="button" href="${esc(base)}">Clear</a>` : ''}</form>`;
}

function wireSearchForm(main) {
  main.querySelector('#connsearch')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = e.target.elements.q.value.trim();
    location.hash = `${e.target.dataset.base}${value ? `?q=${encodeURIComponent(value)}` : ''}`;
  });
}

export async function connections(main, { guildId, query }) {
  const q = query.get('q') ?? '';
  main.innerHTML = loading;
  // A search only ever looks at this server; the worker checks the viewer may see it.
  const [guild, found] = await Promise.all([
    api(`/api/guilds/${guildId}`),
    q ? api(`/api/guilds/${guildId}/connections?q=${encodeURIComponent(q)}`) : null,
  ]);
  const c = found ?? guild.connections ?? { pairs: [], members: [], groups: [] };
  const off = trackerOff(guild, 'connectionTracking', 'Connection tracking');
  main.innerHTML = `${offlineBanner(guild.bot)}${off && guild.connections?.pairs?.length ? `<div class="banner warn">${esc(off)} What was recorded so far is still shown.</div>` : ''}
    <p class="muted small">Scores: a reply is 3 points, a mention 2, a reaction 1, a back-and-forth chat 1, and every 10 minutes together in voice or the same game 1. Only counts are kept, never message text.</p>
    ${searchForm(`#/g/${guildId}/connections`, q, 'Find a member by name or user ID…')}
    ${q ? `<p class="muted small">Groups, pairs and connections involving "${esc(q)}" in this server.</p>` : ''}
    ${connectionsGrid(c, q ? `Nothing involving "${q}".` : off)}`;
  wireSearchForm(main);
}

// ---------------------------------------------------------------------------
//   Settings
// ---------------------------------------------------------------------------

export async function settings(main, ctx) {
  const { guildId } = ctx;
  main.innerHTML = loading;
  const guild = await api(`/api/guilds/${guildId}`);
  const s = guild.settings;
  const t = s.tickets;
  const offNote = (feature) => (guild.features[feature] ? '' : ` <span class="muted small">(disabled in the bot's .env, so this has no effect)</span>`);
  // Statistics are switched off by emailed request (Privacy Policy, section 7), so only the owner can change them.
  const owner = ctx.me.user.isOwner;
  const tracker = (key, label) =>
    `<label class="switch"><input type="checkbox" name="${key}"${s[key] ? ' checked' : ''}${owner ? '' : ' disabled'}> ${label}${offNote(key)}</label>`;

  main.innerHTML = `${offlineBanner(guild.bot)}
    <div class="grid">
      <form class="card" id="general">
        <h2>General</h2>
        <label class="field"><span>Log channel</span>
          <select name="logChannelId">${channelOptions(guild, s.logChannelId)}</select>
          <span class="muted small">Moderation, bot actions and server events are posted here. The panel's log history works either way.</span></label>
        <label class="switch"><input type="checkbox" name="wordFilter"${s.wordFilter ? ' checked' : ''}> Word filter${offNote('wordFilter')}</label>
        <label class="switch"><input type="checkbox" name="levels"${s.levels !== false ? ' checked' : ''}> Levels <span class="muted small">(XP and levels from activity)</span>${offNote('levels')}</label>
        <h3>Statistics</h3>
        ${tracker('gameTracking', 'Game tracking')}${tracker('voiceTracking', 'Voice tracking')}${tracker('activityTracking', 'Activity tracking')}${tracker('connectionTracking', 'Connection tracking')}
        ${owner ? '' : `<p class="muted small" style="margin:0 0 10px">To turn statistics off for this server, email the bot's operator (Privacy Policy, section 7).</p>`}
        <button class="primary" type="submit">Save</button>
      </form>
      <form class="card" id="tickets">
        <h2>Tickets</h2>
        ${t
          ? `<p class="muted small">Ticket channel: ${esc(channelName(guild, t.channelId))}. To move it, run <code>/ticket setup</code> in Discord.</p>
            <label class="field"><span>Staff role</span><select name="staffRoleId">${guild.roles.map((r) => option(r.id, `@${r.name}`, r.id === t.staffRoleId)).join('')}</select></label>
            <label class="field"><span>Queue channel</span><select name="queueChannelId">${channelOptions(guild, t.queueChannelId, 'The ticket channel')}</select>
              <span class="muted small">A staff-only channel keeps ticket details private.</span></label>
            <label class="switch"><input type="checkbox" name="pingStaff"${t.pingStaff ? ' checked' : ''}> Ping the staff role for new tickets</label>
            <button class="primary" type="submit">Save</button>`
          : '<p class="muted">Tickets aren\'t set up here yet. Run <code>/ticket setup</code> in Discord to choose the ticket channel; then the rest can be changed here.</p>'}
      </form>
    </div>`;

  main.querySelector('#general').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const payload = {};
    if ((f.logChannelId.value || null) !== s.logChannelId) payload.logChannelId = f.logChannelId.value || null;
    for (const key of ['wordFilter', 'levels', 'gameTracking', 'voiceTracking', 'activityTracking', 'connectionTracking']) {
      if (!f[key].disabled && f[key].checked !== (s[key] !== false)) payload[key] = f[key].checked;
    }
    if (!Object.keys(payload).length) return toast('Nothing changed.');
    act(e.submitter, guildId, 'settings.update', payload, () => settings(main, ctx));
  });

  main.querySelector('#tickets').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const payload = {};
    if (f.staffRoleId.value !== t.staffRoleId) payload.staffRoleId = f.staffRoleId.value;
    if ((f.queueChannelId.value || null) !== (t.queueChannelId ?? null)) payload.queueChannelId = f.queueChannelId.value || null;
    if (f.pingStaff.checked !== Boolean(t.pingStaff)) payload.pingStaff = f.pingStaff.checked;
    if (!Object.keys(payload).length) return toast('Nothing changed.');
    act(e.submitter, guildId, 'tickets.update', payload, () => settings(main, ctx));
  });
}

// ---------------------------------------------------------------------------
//   Moderation
// ---------------------------------------------------------------------------

export async function moderation(main, ctx) {
  const { guildId, query } = ctx;
  main.innerHTML = loading;
  const guild = await api(`/api/guilds/${guildId}`);
  const filter = query.get('tickets') ?? 'open';
  const tickets = guild.tickets.list.filter((t) => (filter === 'all' ? true : filter === 'open' ? t.status !== 'archived' : t.status === filter));
  const c = guild.tickets.counts;

  const warningRows = guild.warnings
    .map(
      (w) => `<tr><td><b>${esc(w.username)}</b><div class="muted small">${esc(w.userId)}</div></td>
        <td>${w.warnings
          .map((x) => `<div class="row" style="justify-content:space-between;margin-bottom:4px"><span>${esc(x.reason || 'No reason given')} <span class="muted small">· ${esc(x.moderator)} · ${esc(ago(x.at))}</span></span>
            <button class="small" data-remove="${esc(w.userId)}" data-at="${esc(x.at)}">Remove</button></div>`)
          .join('')}</td>
        <td class="num">${w.warnings.length}</td>
        <td><button class="small danger" data-clear="${esc(w.userId)}" data-name="${esc(w.username)}">Clear all</button></td></tr>`,
    )
    .join('');

  const tabs = [['open', `Open (${(c.pending ?? 0) + (c.active ?? 0)})`], ['pending', `Unclaimed (${c.pending ?? 0})`], ['active', `Claimed (${c.active ?? 0})`], ['archived', `Closed (${c.archived ?? 0})`], ['all', 'All']]
    .map(([k, label]) => `<a class="button${k === filter ? ' primary' : ''}" href="#/g/${esc(guildId)}/moderation?tickets=${k}">${esc(label)}</a>`)
    .join('');

  main.innerHTML = `${offlineBanner(guild.bot)}
    <div class="stack">
      <div class="card"><h2>Warnings</h2>
        ${guild.warnings.length
          ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Warnings</th><th class="num">Count</th><th></th></tr></thead><tbody>${warningRows}</tbody></table></div>`
          : '<div class="empty">Nobody has been warned.</div>'}
      </div>
      <div class="card"><h2>Tickets</h2>
        ${guild.settings.tickets
          ? `<div class="row" style="margin-bottom:12px">${tabs}</div>
            ${tickets.length
              ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Subject</th><th>Status</th><th>Opened by</th><th>Claimed by</th><th>Opened</th><th>Closed</th></tr></thead><tbody>${tickets
                  .map((t) => `<tr><td>${String(t.number).padStart(4, '0')}</td><td>${esc(t.subject)}</td><td><span class="tag ${esc(t.status)}">${esc(t.status.toUpperCase())}</span></td>
                    <td>${esc(t.opener)}</td><td>${esc(t.claimer ?? '—')}</td><td title="${esc(dateTime(t.createdAt))}">${esc(ago(t.createdAt))}</td><td>${t.closedAt ? esc(ago(t.closedAt)) : '—'}</td></tr>`)
                  .join('')}</tbody></table></div>
                <p class="muted small">Tickets are handled in their Discord threads; this list is read-only.</p>`
              : '<div class="empty">No tickets here.</div>'}`
          : '<div class="empty">Tickets aren\'t set up in this server.</div>'}
      </div>
    </div>`;

  main.querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm(`Clear all warnings for ${b.dataset.name}?`)) return;
      act(b, guildId, 'warnings.clear', { userId: b.dataset.clear }, () => moderation(main, ctx));
    }),
  );
  main.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => act(b, guildId, 'warnings.remove', { userId: b.dataset.remove, at: Number(b.dataset.at) }, () => moderation(main, ctx))),
  );
}

// ---------------------------------------------------------------------------
//   Logs
// ---------------------------------------------------------------------------

export async function logs(main, { guildId, query }) {
  const q = query.get('q') ?? '';
  main.innerHTML = `<form class="row" id="search" style="margin-bottom:16px">
      <input type="search" name="q" placeholder="Search titles, names, messages…" value="${esc(q)}" style="flex:1;min-width:200px">
      <button class="primary">Search</button></form>
    <p class="muted small">Everything the bot logged, kept for 90 days. Deleted-message transcripts stay in the Discord log channel.</p>
    <div id="entries">${loading}</div><div class="row" style="justify-content:center"><button id="more" class="hidden">Load more</button></div>`;

  main.querySelector('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = e.target.elements.q.value.trim();
    location.hash = `#/g/${guildId}/logs${value ? `?q=${encodeURIComponent(value)}` : ''}`;
  });

  const list = main.querySelector('#entries');
  const more = main.querySelector('#more');
  let before = '';
  let first = true;
  async function page() {
    more.disabled = true;
    const { entries } = await api(`/api/guilds/${guildId}/logs?limit=50${before ? `&before=${before}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    if (first) list.innerHTML = entries.length ? '' : `<div class="empty">${q ? 'Nothing matches that search.' : 'No log entries yet.'}</div>`;
    first = false;
    list.insertAdjacentHTML('beforeend', entries.map(logEntry).join(''));
    before = entries.at(-1)?.id ?? before;
    more.classList.toggle('hidden', entries.length < 50);
    more.disabled = false;
  }
  more.addEventListener('click', () => page().catch((err) => toast(err.message, true)));
  await page();
}

// ---------------------------------------------------------------------------
//   Music
// ---------------------------------------------------------------------------

export async function music(main, ctx) {
  const { guildId } = ctx;
  if (!main.querySelector('#music')) main.innerHTML = loading;
  const guild = await api(`/api/guilds/${guildId}`);
  const m = guild.music;

  if (!guild.features.music) {
    main.innerHTML = `<div class="card"><div class="empty">Music is turned off in the bot's .env.</div></div>`;
    return;
  }
  if (!m?.current) {
    main.innerHTML = `${offlineBanner(guild.bot)}<div class="card" id="music"><div class="empty">Nothing is playing. Start something with <code>/play</code> in Discord.</div></div>`;
    return;
  }

  const position = m.paused ? m.position : m.position + (Date.now() - m.at);
  const pct = m.current.duration ? Math.min(100, (position / m.current.duration) * 100) : 100;
  main.innerHTML = `${offlineBanner(guild.bot)}
    <div class="stack" id="music">
      <div class="card"><div class="now">
        ${m.current.artwork ? `<img src="${esc(m.current.artwork)}" alt="">` : '<img alt="">'}
        <div style="flex:1;min-width:0">
          <div class="muted small">${m.paused ? 'Paused' : 'Now playing'}${m.voiceChannel ? ` in 🔊 ${esc(m.voiceChannel)}` : ''}</div>
          <h2 style="margin:2px 0"><a href="${esc(m.current.uri)}" target="_blank" rel="noopener">${esc(m.current.title)}</a></h2>
          <div class="muted">${esc(m.current.author)}</div>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="muted small">${esc(duration(position))} / ${esc(duration(m.current.duration))}</div>
        </div></div>
        <div class="row" style="margin-top:14px">
          <button data-cmd="${m.paused ? 'music.resume' : 'music.pause'}">${m.paused ? '▶ Resume' : '⏸ Pause'}</button>
          <button data-cmd="music.skip">⏭ Skip</button>
          <button data-cmd="music.shuffle">🔀 Shuffle</button>
          <button data-cmd="music.stop" class="danger">⏹ Stop</button>
          <label class="row small">Volume <input type="range" id="volume" min="1" max="150" value="${esc(m.volume)}"> <span id="vol">${esc(m.volume)}%</span></label>
          <label class="row small">Loop <select id="loop">${['off', 'track', 'queue'].map((k) => option(k, k, k === m.repeat)).join('')}</select></label>
        </div>
      </div>
      <div class="card"><h2>Up next (${num(m.queueLength)})</h2>
        ${m.queue.length
          ? `<div class="table-wrap"><table><tbody>${m.queue.map((t, i) => `<tr><td class="muted" style="width:2.5em">${i + 1}</td><td>${esc(t.title)}<div class="muted small">${esc(t.author)}</div></td><td class="num">${esc(duration(t.duration))}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty">The queue is empty.</div>'}
      </div>
    </div>`;

  const reload = () => music(main, ctx);
  main.querySelectorAll('[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.cmd === 'music.stop' && !confirm('Stop the music and leave the voice channel?')) return;
      act(b, guildId, b.dataset.cmd, {}, reload);
    }),
  );
  const volume = main.querySelector('#volume');
  volume.addEventListener('input', () => (main.querySelector('#vol').textContent = `${volume.value}%`));
  volume.addEventListener('change', () => act(null, guildId, 'music.volume', { volume: Number(volume.value) }, reload));
  main.querySelector('#loop').addEventListener('change', (e) => act(null, guildId, 'music.loop', { mode: e.target.value }, reload));
}

// ---------------------------------------------------------------------------
//   The bot itself
// ---------------------------------------------------------------------------

/** One server's records on a searched member. */
function searchServer(s, me) {
  const a = s.activity;
  const parts = [];
  if (a) {
    parts.push(`<div><b>Activity</b>${num(a.last30)} messages in the last 30 days · ${num(a.messages)} in all · ${num(a.reactions)} reactions · active ${num(a.activeDaysLast30)} of the last 30 days${a.last ? ` · last active ${esc(ago(a.last))}` : ''}</div>`);
  }
  const detail = memberDetail(a ?? {}, s.voice, s.games);
  if (s.connection) {
    parts.push(`<div><b>Closest connections</b>${s.connection.top.map((t) => `${esc(t.username)} <span class="muted">${num(t.score)}</span>`).join(' · ') || '—'}${s.connection.group ? ` <span class="muted">· Group ${num(s.connection.group)}</span>` : ''}</div>`);
  }
  if (s.warnings.length) {
    parts.push(`<div><b>Warnings (${num(s.warnings.length)})</b>${s.warnings.map((w) => `${esc(w.reason)} <span class="muted">· by ${esc(w.moderator)} · ${esc(dateTime(w.at))}</span>`).join('\n')}</div>`);
  }
  if (s.tickets.length) {
    parts.push(`<div><b>Tickets (${num(s.tickets.length)})</b>${s.tickets.map((t) => `#${num(t.number)} ${esc(t.subject)} <span class="muted">· ${esc(t.status)} · ${esc(dateTime(t.createdAt))}</span>`).join('\n')}</div>`);
  }
  const link = me.guilds.some((g) => g.id === s.guild.id) ? `<a href="#/g/${esc(s.guild.id)}/overview">${esc(s.guild.name)}</a>` : esc(s.guild.name);
  return `<div class="card"><h3>${link}</h3>
    ${parts.length ? `<div class="log" style="border-left-color:var(--accent)"><div class="fields" style="grid-template-columns:1fr">${parts.join('')}</div></div>` : ''}
    ${detail.includes('Nothing else recorded') ? '' : detail}
    ${s.logs.length ? `<details style="margin-top:8px"><summary>Recent log entries (${num(s.logs.length)})</summary>${s.logs.map(logEntry).join('')}</details>` : ''}
  </div>`;
}

export async function search(main, { me, query }) {
  const q = query.get('q') ?? '';
  const scope = me.user.isOwner ? 'every server the bot is in' : 'the servers you manage';
  main.innerHTML = `<h1>Find a member</h1>
    <p class="muted small">Search by name or Discord user ID across ${esc(scope)}. Shows what each server has on them: activity, voice, games, connections, warnings, tickets and log entries.</p>
    <form class="row" id="usersearch" style="margin-bottom:16px">
      <input type="search" name="q" placeholder="Name or user ID…" value="${esc(q)}" style="flex:1;min-width:200px" autofocus>
      <button class="primary">Search</button>
    </form>
    <div id="results"></div>`;
  main.querySelector('#usersearch').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = e.target.elements.q.value.trim();
    location.hash = `#/search${value ? `?q=${encodeURIComponent(value)}` : ''}`;
  });
  if (!q) return;

  const box = main.querySelector('#results');
  box.innerHTML = loading;
  const { people, servers } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (!people.length) {
    box.innerHTML = `<div class="empty">Nobody matching "${esc(q)}" in ${num(servers)} server${servers === 1 ? '' : 's'}. Only members with recorded statistics, warnings or log entries can be found.</div>`;
    return;
  }
  box.innerHTML = people
    .map((p) => `<div class="card" style="margin-bottom:16px"><h2>${esc(p.username)} <span class="muted small">${esc(p.userId)}</span></h2>
      <div class="grid">${p.servers.map((s) => searchServer(s, me)).join('')}</div></div>`)
    .join('');
}

export async function bot(main) {
  main.innerHTML = loading;
  const { bot: b } = await api('/api/me');
  const uptime = b.startedAt ? ago(b.startedAt).replace(' ago', '') : '—';
  const feature = (on, label) => `<span class="pill ${on ? 'good' : ''}">${esc(label)}</span>`;
  const f = b.features ?? {};

  main.innerHTML = `<div class="stack">
    <div class="card"><div class="header-row">${b.avatar ? `<img class="avatar lg" src="${esc(b.avatar)}" alt="">` : ''}
      <div><h1 style="margin:0">${esc(b.tag ?? 'DaemonBot')}</h1>
      <span class="pill ${b.online ? 'good' : 'bad'}">${b.online ? 'Online' : `Offline · last seen ${esc(ago(b.lastSeen))}`}</span></div></div></div>
    <div class="grid kpis">
      <div class="card kpi"><div class="value">${esc(b.online ? uptime : '—')}</div><div class="label">Running for</div></div>
      <div class="card kpi"><div class="value">${b.ping >= 0 ? `${num(b.ping)} ms` : '—'}</div><div class="label">Discord latency</div></div>
      <div class="card kpi"><div class="value">${num(b.guildCount)}</div><div class="label">Servers</div></div>
      <div class="card kpi"><div class="value">${num(b.memberCount)}</div><div class="label">Members across them</div></div>
      <div class="card kpi"><div class="value">${num(b.memoryMb)} MB</div><div class="label">Memory</div></div>
    </div>
    <div class="card"><h2>Features</h2><div class="row">
      ${feature(f.serverLogs, 'Server logs')}${feature(f.wordFilter, 'Word filter')}${feature(f.gameTracking, 'Game tracking')}${feature(f.voiceTracking, 'Voice tracking')}${feature(f.activityTracking, 'Activity tracking')}${feature(f.connectionTracking, 'Connection tracking')}${feature(f.levels, 'Levels')}
      ${feature(f.music, 'Music')}${feature(f.messageQuotes, 'Message previews')}
      ${b.lavalink ? `<span class="pill ${b.lavalink.connected ? 'good' : 'bad'}">Lavalink ${b.lavalink.connected ? 'connected' : 'not connected'}</span>` : ''}
    </div><p class="muted small">Turned on and off in the bot's .env file; restart the bot after changing it. Node ${esc(b.node ?? '')}.</p></div>
  </div>`;
}

// ---------------------------------------------------------------------------
//   Owner panel (the bot's owners only; the worker refuses everyone else)
// ---------------------------------------------------------------------------

const onOff = (on) => `<span class="pill ${on ? 'good' : ''}">${on ? 'On' : 'Off'}</span>`;

function serversCard(servers) {
  if (!servers.length) return '<div class="card wide"><h2>All servers</h2><div class="empty">The bot hasn\'t reported any servers yet.</div></div>';
  const total = (key) => servers.reduce((n, s) => n + s.counts[key], 0);
  const row = (s) => `<tr>
      <td><a href="#/g/${esc(s.id)}/overview">${esc(s.name)}</a><div class="muted small">${esc(s.id)}</div></td>
      <td class="num">${num(s.memberCount)}</td>
      <td class="num">${num(s.counts.activity)}</td><td class="num">${num(s.counts.voice)}</td><td class="num">${num(s.counts.games)}</td>
      <td class="num">${num(s.counts.pairs)}<span class="muted"> / ${num(s.counts.groups)}</span></td>
      <td class="num">${num(s.counts.warnings)}</td><td class="num">${num(s.counts.tickets)}</td>
      <td class="num">${num(s.counts.logs)}</td><td class="num">${num(s.counts.statDays)}</td>
      <td>${s.updatedAt ? esc(ago(s.updatedAt)) : '—'}</td>
      <td><button class="small" data-raw="${esc(s.id)}">Raw data</button></td></tr>
    <tr class="rawrow" data-for="${esc(s.id)}" hidden><td colspan="12"><div class="small muted">Statistics:
      activity ${onOff(s.settings.activityTracking)} voice ${onOff(s.settings.voiceTracking)} games ${onOff(s.settings.gameTracking)}
      connections ${onOff(s.settings.connectionTracking)} levels ${onOff(s.settings.levels)}</div><div class="rawbox"></div></td></tr>`;
  return `<div class="card wide"><h2>All servers</h2>
    <p class="muted small">Everything the panel holds for each server the bot is in. Click a server to open its pages; you can open every server's pages. Raw data is the server's full latest report from the bot. Members with stats: activity · voice · games. Connections: pairs / groups (the 100 strongest pairs are kept). Logs: entries in the last 90 days. Stats: days of server totals.</p>
    <div class="table-wrap"><table><thead><tr><th>Server</th><th class="num">Members</th><th class="num">Activity</th><th class="num">Voice</th><th class="num">Games</th><th class="num">Connections</th><th class="num">Warnings</th><th class="num">Tickets</th><th class="num">Logs</th><th class="num">Stats</th><th>Last report</th><th></th></tr></thead>
    <tbody>${servers.map(row).join('')}
      <tr><td><b>All ${num(servers.length)} servers</b></td><td class="num">${num(servers.reduce((n, s) => n + (s.memberCount ?? 0), 0))}</td>
      <td class="num">${num(total('activity'))}</td><td class="num">${num(total('voice'))}</td><td class="num">${num(total('games'))}</td>
      <td class="num">${num(total('pairs'))}<span class="muted"> / ${num(total('groups'))}</span></td><td class="num">${num(total('warnings'))}</td><td class="num">${num(total('tickets'))}</td>
      <td class="num">${num(total('logs'))}</td><td></td><td></td><td></td></tr></tbody></table></div></div>`;
}

/** Shows (and offers to download) one server's latest report, loaded when first opened. */
function wireRawData(main) {
  main.querySelectorAll('[data-raw]').forEach((button) =>
    button.addEventListener('click', async () => {
      const id = button.dataset.raw;
      const row = main.querySelector(`.rawrow[data-for="${CSS.escape(id)}"]`);
      row.hidden = !row.hidden;
      if (row.hidden) return delete row.dataset.dirty;
      row.dataset.dirty = '1'; // keeps the page from refreshing while it's open
      const box = row.querySelector('.rawbox');
      if (box.dataset.loaded) return;
      box.innerHTML = loading;
      try {
        const data = await api(`/api/guilds/${id}`);
        delete data.bot;
        const text = JSON.stringify(data, null, 2);
        const href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        box.innerHTML = `<div class="row" style="margin:8px 0"><a class="button small" href="${href}" download="daemonbot-${esc(id)}.json">Download JSON</a></div>
          <pre style="max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(text)}</pre>`;
        box.dataset.loaded = '1';
      } catch (err) {
        box.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
      }
    }),
  );
}

async function ownerConnectionResults(box, q) {
  box.innerHTML = loading;
  const { servers, searched } = await api(`/api/owner/connections?q=${encodeURIComponent(q)}`);
  box.innerHTML = servers.length
    ? servers
        .map((s) => `<div class="card wide" style="margin-bottom:16px"><h2><a href="#/g/${esc(s.guild.id)}/connections?q=${encodeURIComponent(q)}">${esc(s.guild.name)}</a></h2>${connectionsGrid(s, `Nothing involving "${q}".`)}</div>`)
        .join('')
    : `<div class="empty">Nothing involving "${esc(q)}" in the connections of ${num(searched)} server${searched === 1 ? '' : 's'}.</div>`;
}

function wireOptOuts(main) {
  const optBox = main.querySelector('#optouts');
  const optId = optBox.querySelector('#optoutid');
  optId.addEventListener('input', () => (optId.dataset.dirty = '1')); // keeps the page from refreshing over the entry
  const clearId = () => {
    optId.value = '';
    delete optId.dataset.dirty;
  };
  const optGuild = optBox.querySelector('#optoutguild');
  for (const [button, type] of [['#optoutadd', 'optout.add'], ['#optoutremove', 'optout.remove']]) {
    optBox.querySelector(button).addEventListener('click', (e) => {
      if (!optGuild.value) return toast('Pick the server first.', true);
      act(e.target, optGuild.value, type, { userId: optId.value.trim() }, clearId);
    });
  }
}

async function loadWordList(box) {
  const { text, updatedAt } = await api('/api/wordlist');
  if (text == null) {
    box.innerHTML = '<h2>Word filter list</h2><div class="empty">The bot hasn\'t sent its word list yet.</div>';
    return;
  }
  box.innerHTML = `<h2>Word filter list</h2>
    <p class="muted small">One word or phrase per line; <code>#</code> starts a comment; a trailing <code>*</code> also matches longer words. Applies to every server. Last read from the bot ${esc(ago(updatedAt))}.</p>
    <textarea id="wordtext" spellcheck="false">${esc(text)}</textarea>
    <div class="row" style="margin-top:10px"><button class="primary" id="savewords">Save word list</button></div>`;
  const area = box.querySelector('#wordtext');
  area.addEventListener('input', () => (area.dataset.dirty = '1')); // keeps the page from refreshing over the edit
  box.querySelector('#savewords').addEventListener('click', (e) =>
    act(e.target, null, 'wordlist.set', { text: area.value }, () => delete area.dataset.dirty),
  );
}

export async function owner(main, { me, query }) {
  const q = query.get('q') ?? '';
  main.innerHTML = loading;
  const { servers } = await api('/api/owner/servers');
  main.innerHTML = `<h1>Owner Panel</h1>
    <p class="muted small">Only the bot's owners see this page. Server admins only ever see their own servers.</p>
    <div class="grid">
      ${serversCard(servers)}
      <div class="card wide" id="ownerconn"><h2>Search connections in every server</h2>
        <p class="muted small">Groups, pairs and closest connections involving a member, in every server the bot is in. Each server's admins can only search their own server's connections.</p>
        ${searchForm('#/owner', q, 'Name or user ID…')}<div id="connresults"></div></div>
      <div class="card wide" id="optouts"><h2>Statistics opt-outs</h2>
        <p class="muted small">For members who emailed to opt out (Privacy Policy, section 7). Each server is requested separately: opting out deletes their activity, voice, game, connection and level statistics in the chosen server and stops collecting them there. Check that the request comes from the account's owner first. When a server's administrators ask to turn statistics off for the whole server, switch them off in that server's Settings.</p>
        <div class="row"><select id="optoutguild"><option value="">Server…</option>${me.guilds.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>
        <input type="text" id="optoutid" inputmode="numeric" placeholder="Discord user ID" autocomplete="off">
        <button class="primary" id="optoutadd">Opt out</button><button id="optoutremove">Undo opt-out</button></div></div>
      <div class="card wide" id="words"><h2>Word filter list</h2><div class="empty">Loading…</div></div>
    </div>`;
  wireRawData(main);
  wireSearchForm(main);
  wireOptOuts(main);
  await Promise.all([q ? ownerConnectionResults(main.querySelector('#connresults'), q) : null, loadWordList(main.querySelector('#words'))]);
}
