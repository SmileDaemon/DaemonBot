/**
 * DaemonBot control panel relay.
 *
 * The panel (a static github.io site) and the bot never talk directly: the bot
 * runs on a home PC with nothing exposed, so it calls in here every few seconds
 * with what it knows and collects what the panel has asked it to do.
 *
 *   /auth/*   Discord sign-in for panel users
 *   /api/*    the panel's API (Bearer session token)
 *   /bot/sync the bot's heartbeat (Bearer BOT_SECRET)
 */

const DAY = 24 * 60 * 60 * 1000;
const SESSION_MS = 7 * DAY;
const OFFLINE_AFTER_MS = 60_000;
const RESEND_AFTER_MS = 60_000;
const DISCORD = 'https://discord.com/api/v10';

// Discord permission bits that let someone manage a server from the panel.
const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

/**
 * Every change the panel can ask for, and who may ask. The bot has the matching
 * handlers in src/panel/commands.js; `npm run sweep` checks the three lists agree.
 */
const COMMANDS = {
  'settings.update': 'guild',
  'tickets.update': 'guild',
  'warnings.clear': 'guild',
  'warnings.remove': 'guild',
  'music.pause': 'guild',
  'music.resume': 'guild',
  'music.skip': 'guild',
  'music.stop': 'guild',
  'music.shuffle': 'guild',
  'music.volume': 'guild',
  'music.loop': 'guild',
  'wordlist.set': 'owner',
  'optout.add': 'owner',
  'optout.remove': 'owner',
};

// Statistics are switched on and off at a server's request by email, like a member's opt-out, so only
// the owner can change these settings.
const TRACKERS = ['gameTracking', 'voiceTracking', 'activityTracking', 'connectionTracking'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const response = await route(request, env, url);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500, cors);
    }
  },

  // Daily cleanup (see [triggers] in wrangler.toml).
  async scheduled(_event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM logs WHERE at < ?').bind(now - 90 * DAY),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - DAY),
      env.DB.prepare('DELETE FROM commands WHERE created_at < ?').bind(now - 30 * DAY),
      env.DB.prepare('DELETE FROM stats WHERE day < ?').bind(dayOf(now - 400 * DAY)),
    ]);
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const isLocal = (url) => ['localhost', '127.0.0.1'].includes(url.hostname);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = [env.SITE_ORIGIN, ...(env.DEV_LOGIN === '1' ? ['http://localhost:8020', 'http://127.0.0.1:8020'] : [])];
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/') return json({ ok: true, service: 'DaemonBot control panel relay' });
  if (path === '/auth/login' && method === 'GET') return login(env, url);
  if (path === '/invite' && method === 'GET') return invite(env);
  if (path === '/auth/callback' && method === 'GET') return callback(env, url);
  if (path === '/auth/dev' && method === 'GET') return devLogin(env, url);
  if (path === '/auth/logout' && method === 'POST') return logout(request, env);
  if (path === '/bot/sync' && method === 'POST') return botSync(request, env);

  if (path.startsWith('/api/')) {
    const session = await requireSession(request, env);
    const parts = path.split('/').filter(Boolean); // ['api', ...]

    if (path === '/api/me' && method === 'GET') return me(env, session);
    if (path === '/api/wordlist' && method === 'GET') return getWordlist(env, session);
    if (path === '/api/search' && method === 'GET') return search(env, session, url);
    if (path === '/api/owner/servers' && method === 'GET') return ownerServers(env, session);
    if (path === '/api/owner/connections' && method === 'GET') return ownerConnections(env, session, url);
    if (parts[1] === 'commands' && parts[2] && method === 'GET') return getCommand(env, session, parts[2]);
    if (path === '/api/commands' && method === 'POST') return postCommand(request, env, session, null);

    if (parts[1] === 'guilds' && parts[2]) {
      const guildId = parts[2];
      requireGuild(session, guildId);
      const sub = parts[3] ?? '';
      if (sub === '' && method === 'GET') return getGuild(env, guildId);
      if (sub === 'stats' && method === 'GET') return getStats(env, guildId, url);
      if (sub === 'logs' && method === 'GET') return getLogs(env, guildId, url);
      if (sub === 'connections' && method === 'GET') return getConnections(env, guildId, url);
      if (sub === 'commands' && method === 'POST') return postCommand(request, env, session, guildId);
    }
  }
  throw new HttpError(404, 'Not found.');
}

// ---------------------------------------------------------------------------
//   Sign-in
// ---------------------------------------------------------------------------

function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const redirectUri = (url) => `${url.origin}/auth/callback`;

// What the bot asks for when it's added to a server. MAINTAINING.md → "Invite the bot" lists what each is for.
const BOT_PERMISSIONS = '1460560719030';

/** Sends someone to Discord's "Add to server" page, where they pick a server they manage. */
function invite(env) {
  const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, scope: 'bot applications.commands', permissions: BOT_PERMISSIONS });
  return Response.redirect(`https://discord.com/oauth2/authorize?${params}`, 302);
}

async function login(env, url) {
  const state = randomToken(16);
  await env.DB.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?, ?)').bind(state, Date.now()).run();
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(url),
    scope: 'identify guilds',
    state,
    prompt: 'none',
  });
  return Response.redirect(`https://discord.com/oauth2/authorize?${params}`, 302);
}

async function callback(env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return backToSite(env, { error: 'Sign-in was cancelled.' });

  const known = await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? AND created_at > ? RETURNING state')
    .bind(state, Date.now() - 10 * 60_000)
    .first();
  if (!known) return backToSite(env, { error: 'Sign-in expired. Please try again.' });

  const tokenRes = await fetch(`${DISCORD}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(url),
    }),
  });
  if (!tokenRes.ok) return backToSite(env, { error: 'Discord refused the sign-in.' });
  const { access_token: accessToken } = await tokenRes.json();
  const auth = { Authorization: `Bearer ${accessToken}` };

  const [user, guilds] = await Promise.all([
    fetch(`${DISCORD}/users/@me`, { headers: auth }).then((r) => r.json()),
    fetch(`${DISCORD}/users/@me/guilds`, { headers: auth }).then((r) => r.json()),
  ]);
  if (!user?.id || !Array.isArray(guilds)) return backToSite(env, { error: "Couldn't read your Discord account." });

  const manageable = guilds
    .filter((g) => g.owner || (BigInt(g.permissions) & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n)
    .map((g) => g.id);
  const token = await createSession(env, {
    id: user.id,
    username: user.global_name || user.username,
    avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null,
    guildIds: manageable,
  });
  return backToSite(env, { token });
}

async function createSession(env, { id, username, avatar, guildIds }) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, username, avatar, guild_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(await sha256(token), id, username, avatar, JSON.stringify(guildIds), now, now + SESSION_MS)
    .run();
  return token;
}

/** The token travels in the URL fragment, which browsers never send to a server. */
function backToSite(env, params) {
  return Response.redirect(`${env.SITE_ORIGIN}${env.SITE_PATH ?? '/'}#${new URLSearchParams(params)}`, 302);
}

/**
 * Local testing only: signs in as a made-up user who manages every server the bot
 * reports. Refused unless DEV_LOGIN=1 (set in .dev.vars, never in production) AND
 * the request is to localhost.
 */
async function devLogin(env, url) {
  if (env.DEV_LOGIN !== '1' || !isLocal(url)) throw new HttpError(404, 'Not found.');
  const { results } = await env.DB.prepare('SELECT id FROM guilds').all();
  const token = await createSession(env, {
    id: url.searchParams.get('id') || '100000000000000001',
    username: url.searchParams.get('name') || 'Local tester',
    avatar: null,
    guildIds: results.map((r) => r.id),
  });
  return Response.redirect(`${url.searchParams.get('site') || 'http://localhost:8020/'}#token=${token}`, 302);
}

async function logout(request, env) {
  const token = bearer(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true });
}

function bearer(request) {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

const ownerIds = (env) => (env.OWNER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function requireSession(request, env) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'Please sign in.');
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await sha256(token), Date.now())
    .first();
  if (!row) throw new HttpError(401, 'Your sign-in has expired. Please sign in again.');
  return {
    userId: row.user_id,
    username: row.username,
    avatar: row.avatar,
    guildIds: JSON.parse(row.guild_ids),
    isOwner: ownerIds(env).includes(row.user_id) || env.DEV_LOGIN === '1',
  };
}

function requireGuild(session, guildId) {
  if (!session.isOwner && !session.guildIds.includes(guildId)) {
    throw new HttpError(403, 'You need Manage Server in that server to manage it here.');
  }
}

// ---------------------------------------------------------------------------
//   The panel's API
// ---------------------------------------------------------------------------

async function botStatus(env) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM bot_status WHERE id = 1').first();
  if (!row) return { online: false, lastSeen: null };
  return { ...JSON.parse(row.data), online: Date.now() - row.updated_at < OFFLINE_AFTER_MS, lastSeen: row.updated_at };
}

async function me(env, session) {
  const { results } = await env.DB.prepare('SELECT id, name, icon, member_count, updated_at FROM guilds ORDER BY name').all();
  const guilds = results
    .filter((g) => session.isOwner || session.guildIds.includes(g.id))
    .map((g) => ({ id: g.id, name: g.name, icon: g.icon, memberCount: g.member_count }));
  return json({
    user: { id: session.userId, username: session.username, avatar: session.avatar, isOwner: session.isOwner },
    guilds,
    bot: await botStatus(env),
  });
}

async function getGuild(env, guildId) {
  const row = await env.DB.prepare('SELECT * FROM guilds WHERE id = ?').bind(guildId).first();
  if (!row) throw new HttpError(404, "The bot hasn't reported this server yet.");
  return json({
    ...JSON.parse(row.snapshot),
    music: row.music ? JSON.parse(row.music) : null,
    updatedAt: row.updated_at,
    bot: await botStatus(env),
  });
}

async function getStats(env, guildId, url) {
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
  const { results } = await env.DB.prepare('SELECT day, metric, key, value FROM stats WHERE guild_id = ? AND day >= ? ORDER BY day')
    .bind(guildId, dayOf(Date.now() - (days - 1) * DAY))
    .all();
  return json({ days, rows: results });
}

async function getLogs(env, guildId, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const q = (url.searchParams.get('q') ?? '').trim();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const { results } = await env.DB.prepare(
    `SELECT * FROM logs WHERE guild_id = ? AND id < ?
       ${q ? "AND (title LIKE ?3 ESCAPE '\\' OR description LIKE ?3 ESCAPE '\\' OR fields LIKE ?3 ESCAPE '\\' OR user LIKE ?3 ESCAPE '\\')" : ''}
     ORDER BY id DESC LIMIT ${limit}`,
  )
    .bind(guildId, before, ...(q ? [like] : []))
    .all();
  return json({
    entries: results.map((r) => ({
      id: r.id,
      at: r.at,
      title: r.title,
      color: r.color,
      user: r.user ? JSON.parse(r.user) : null,
      description: r.description,
      fields: r.fields ? JSON.parse(r.fields) : [],
    })),
  });
}

/**
 * Finds members by name or user ID in every server the viewer can see (the owner: all of them) and
 * gathers what each server has on them: activity, voice, games, connections, warnings, tickets and
 * recent log entries. A server's admins only ever get their own servers' records.
 */
async function search(env, session, url) {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters of a name, or a user ID.');
  const { results } = await env.DB.prepare('SELECT id, name, icon, snapshot FROM guilds ORDER BY name').all();
  const guilds = results.filter((g) => session.isOwner || session.guildIds.includes(g.id));
  const ids = JSON.stringify(guilds.map((g) => g.id));

  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const { results: logRows } = await env.DB.prepare(
    `SELECT * FROM logs WHERE guild_id IN (SELECT value FROM json_each(?)) AND user LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 300`,
  )
    .bind(ids, like)
    .all();

  const people = new Map(); // userId -> { userId, username, servers: [] }
  for (const g of guilds) {
    const s = JSON.parse(g.snapshot);
    const found = new Map(); // userId -> name, for this server
    const consider = (userId, username) => {
      if (userId && (userId === q || username?.toLowerCase().includes(q))) found.set(userId, username);
    };
    for (const m of s.activity ?? []) consider(m.userId, m.username);
    for (const m of s.voice?.members ?? []) consider(m.userId, m.username);
    for (const m of s.gameMembers ?? []) consider(m.userId, m.username);
    for (const m of s.connections?.members ?? []) consider(m.userId, m.username);
    for (const w of s.warnings ?? []) consider(w.userId, w.username);
    const logs = logRows.filter((r) => r.guild_id === g.id).map((r) => ({ ...r, user: JSON.parse(r.user) }));
    for (const r of logs) if (r.user?.id && !found.has(r.user.id)) consider(r.user.id, r.user.tag);

    for (const [userId, username] of [...found].slice(0, 25)) {
      const groupNo = new Map((s.connections?.groups ?? []).map((grp, i) => [grp.id, i + 1]));
      const connection = s.connections?.members?.find((m) => m.userId === userId) ?? null;
      const person = people.get(userId) ?? { userId, username, servers: [] };
      person.servers.push({
        guild: { id: g.id, name: g.name, icon: g.icon },
        activity: s.activity?.find((m) => m.userId === userId) ?? null,
        voice: s.voice?.members?.find((m) => m.userId === userId) ?? null,
        games: s.gameMembers?.find((m) => m.userId === userId) ?? null,
        connection: connection && { ...connection, group: connection.groupId ? groupNo.get(connection.groupId) ?? null : null },
        warnings: s.warnings?.find((w) => w.userId === userId)?.warnings ?? [],
        tickets: (s.tickets?.list ?? []).filter((t) => t.opener === username),
        logs: logs
          .filter((r) => r.user?.id === userId)
          .slice(0, 15)
          .map((r) => ({ id: r.id, at: r.at, title: r.title, color: r.color, user: r.user, description: r.description, fields: r.fields ? JSON.parse(r.fields) : [] })),
      });
      people.set(userId, person);
    }
  }
  return json({ query: q, servers: guilds.length, people: [...people.values()].slice(0, 25) });
}

// ---------------------------------------------------------------------------
//   Connections search and the owner panel
// ---------------------------------------------------------------------------

const searchTerm = (url) => {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters of a name, or a user ID.');
  return q;
};

/**
 * The part of one server's connections that involves anyone matching `q` (a name or user ID): groups
 * with a matching member, pairs with one on either side, and members who match or are close to one.
 * groupNumbers keeps each group's number from the full list, so "Group 3" means the same everywhere.
 */
function filterConnections(c, q) {
  const hit = (u) => Boolean(u) && (u.userId === q || (u.username ?? '').toLowerCase().includes(q));
  const groups = c?.groups ?? [];
  return {
    groupNumbers: Object.fromEntries(groups.map((g, i) => [g.id, i + 1])),
    groups: groups.filter((g) => g.members.some(hit)),
    pairs: (c?.pairs ?? []).filter((p) => hit(p.a) || hit(p.b)),
    members: (c?.members ?? []).filter((m) => hit(m) || m.top.some(hit)),
  };
}

const hasMatches = (c) => c.groups.length + c.pairs.length + c.members.length > 0;

/** Searches one server's connections. requireGuild has already checked the viewer may see this server. */
async function getConnections(env, guildId, url) {
  const q = searchTerm(url);
  const row = await env.DB.prepare('SELECT snapshot FROM guilds WHERE id = ?').bind(guildId).first();
  if (!row) throw new HttpError(404, "The bot hasn't reported this server yet.");
  return json({ query: q, ...filterConnections(JSON.parse(row.snapshot).connections, q) });
}

function requireOwner(session) {
  if (!session.isOwner) throw new HttpError(403, "Only the bot's owner can see that.");
}

/** Searches the connections of every server the bot is in. Owners only. */
async function ownerConnections(env, session, url) {
  requireOwner(session);
  const q = searchTerm(url);
  const { results } = await env.DB.prepare('SELECT id, name, icon, snapshot FROM guilds ORDER BY name').all();
  const servers = results
    .map((g) => ({ guild: { id: g.id, name: g.name, icon: g.icon }, ...filterConnections(JSON.parse(g.snapshot).connections, q) }))
    .filter(hasMatches);
  return json({ query: q, searched: results.length, servers });
}

/** Every server the bot is in, with how much of each kind of data is kept for it. Owners only. */
async function ownerServers(env, session) {
  requireOwner(session);
  const [{ results: guilds }, { results: logCounts }, { results: statCounts }] = await Promise.all([
    env.DB.prepare('SELECT id, name, icon, member_count, updated_at, snapshot FROM guilds ORDER BY name').all(),
    env.DB.prepare('SELECT guild_id, COUNT(*) AS n, MIN(at) AS oldest FROM logs GROUP BY guild_id').all(),
    env.DB.prepare('SELECT guild_id, COUNT(DISTINCT day) AS days FROM stats GROUP BY guild_id').all(),
  ]);
  const logsBy = new Map(logCounts.map((r) => [r.guild_id, r]));
  const statsBy = new Map(statCounts.map((r) => [r.guild_id, r.days]));
  return json({
    servers: guilds.map((g) => {
      const s = JSON.parse(g.snapshot);
      return {
        id: g.id,
        name: g.name,
        icon: g.icon,
        memberCount: g.member_count,
        updatedAt: g.updated_at,
        settings: s.settings ?? {},
        counts: {
          activity: s.activity?.length ?? 0,
          voice: s.voice?.members?.length ?? 0,
          games: s.gameMembers?.length ?? 0,
          pairs: s.connections?.pairs?.length ?? 0,
          groups: s.connections?.groups?.length ?? 0,
          warnings: (s.warnings ?? []).reduce((n, w) => n + (w.warnings?.length ?? 0), 0),
          tickets: s.tickets?.list?.length ?? 0,
          logs: logsBy.get(g.id)?.n ?? 0,
          statDays: statsBy.get(g.id) ?? 0,
        },
        oldestLog: logsBy.get(g.id)?.oldest ?? null,
      };
    }),
  });
}

async function getWordlist(env, session) {
  if (!session.isOwner) throw new HttpError(403, "Only the bot's owner can see the word list.");
  const row = await env.DB.prepare('SELECT text, updated_at FROM wordlist WHERE id = 1').first();
  return json({ text: row?.text ?? null, updatedAt: row?.updated_at ?? null });
}

async function postCommand(request, env, session, guildId) {
  const body = await request.json().catch(() => null);
  const type = body?.type;
  const scope = COMMANDS[type];
  if (!scope) throw new HttpError(400, `Unknown change "${type}".`);
  if (scope === 'owner' && !session.isOwner) throw new HttpError(403, "Only the bot's owner can do that.");
  if (scope === 'guild' && !guildId) throw new HttpError(400, 'That change needs a server.');
  if (type === 'settings.update' && !session.isOwner && TRACKERS.some((key) => key in (body.payload ?? {}))) {
    throw new HttpError(403, "To turn statistics off for this server, email the bot's operator (Privacy Policy, section 7).");
  }
  const payload = JSON.stringify(body.payload ?? {});
  if (payload.length > 100_000) throw new HttpError(413, 'That is too large.');

  const row = await env.DB.prepare(
    'INSERT INTO commands (guild_id, type, payload, user_id, username, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(guildId, type, payload, session.userId, session.username, Date.now())
    .first();
  return json({ id: row.id, status: 'pending' }, 202);
}

async function getCommand(env, session, id) {
  const row = await env.DB.prepare('SELECT * FROM commands WHERE id = ?').bind(Number(id)).first();
  if (!row || (row.guild_id ? !(session.isOwner || session.guildIds.includes(row.guild_id)) : !session.isOwner)) {
    throw new HttpError(404, 'Not found.');
  }
  return json({ id: row.id, type: row.type, status: row.status, result: row.result ? JSON.parse(row.result) : null });
}

// ---------------------------------------------------------------------------
//   The bot's heartbeat
// ---------------------------------------------------------------------------

/** Compares without leaking how much of the secret matched. */
function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function botSync(request, env) {
  if (!env.BOT_SECRET || !sameSecret(bearer(request), env.BOT_SECRET)) throw new HttpError(401, 'Bad bot secret.');
  const body = await request.json();
  const now = Date.now();
  const writes = [];

  if (body.status) {
    writes.push(
      env.DB.prepare('INSERT INTO bot_status (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(
        JSON.stringify(body.status),
        now,
      ),
    );
  }

  // Servers the bot has left disappear from the panel.
  if (Array.isArray(body.guildIds)) {
    writes.push(env.DB.prepare('DELETE FROM guilds WHERE id NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(body.guildIds)));
  }

  for (const g of body.snapshots ?? []) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO guilds (id, name, icon, member_count, snapshot, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, member_count = excluded.member_count,
           snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
      ).bind(g.id, g.name, g.icon ?? null, g.memberCount ?? null, JSON.stringify(g), now),
    );
  }

  for (const [guildId, music] of Object.entries(body.music ?? {})) {
    writes.push(env.DB.prepare('UPDATE guilds SET music = ? WHERE id = ?').bind(music ? JSON.stringify({ ...music, at: now }) : null, guildId));
  }

  for (const s of body.stats ?? []) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO stats (guild_id, day, metric, key, value) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(guild_id, day, metric, key) DO UPDATE SET value =
           CASE ?6 WHEN 'max' THEN max(value, excluded.value) WHEN 'set' THEN excluded.value ELSE value + excluded.value END`,
      ).bind(s.guildId, s.day, s.metric, s.key ?? '', s.value, s.op ?? 'add'),
    );
  }

  for (const l of body.logs ?? []) {
    writes.push(
      env.DB.prepare('INSERT INTO logs (guild_id, at, title, color, user, description, fields) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        l.guildId,
        l.at ?? now,
        String(l.title).slice(0, 256),
        l.color ?? null,
        l.user ? JSON.stringify(l.user) : null,
        l.description ?? null,
        l.fields?.length ? JSON.stringify(l.fields) : null,
      ),
    );
  }

  if (typeof body.wordlist === 'string') {
    writes.push(
      env.DB.prepare('INSERT INTO wordlist (id, text, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at').bind(
        body.wordlist,
        now,
      ),
    );
  }

  for (const r of body.results ?? []) {
    writes.push(
      env.DB.prepare('UPDATE commands SET status = ?, result = ?, done_at = ? WHERE id = ?').bind(
        r.ok ? 'done' : 'failed',
        JSON.stringify({ message: r.message ?? null }),
        now,
        r.id,
      ),
    );
  }

  // D1 batches are transactions; keep each one a reasonable size.
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));

  // Hand over waiting changes. One the bot was sent but never answered (it restarted) is sent again.
  const { results } = await env.DB.prepare(
    `UPDATE commands SET status = 'sent', sent_at = ?1
     WHERE id IN (SELECT id FROM commands WHERE status = 'pending' OR (status = 'sent' AND sent_at < ?2) ORDER BY id LIMIT 25)
     RETURNING id, guild_id, type, payload, user_id, username`,
  )
    .bind(now, now - RESEND_AFTER_MS)
    .all();

  return json({
    commands: results
      .sort((a, b) => a.id - b.id)
      .map((c) => ({ id: c.id, guildId: c.guild_id, type: c.type, payload: JSON.parse(c.payload), user: { id: c.user_id, username: c.username } })),
  });
}
