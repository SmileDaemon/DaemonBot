/**
 * Housekeeping: what does this project no longer need, and what has drifted?
 *
 *     npm run housekeeping                    report only
 *     npm run housekeeping -- --clean         also delete regenerable leftovers
 *     npm run housekeeping -- --clean --all   and the set-aside items (shelved Lavalink, local worker database...)
 *     npm run housekeeping -- --verbose       list every finding
 *
 * It also runs by itself after a successful `npm run sweep`, `npm run deploy`
 * and `npm run legal` (the npm post-scripts).
 *
 * The sweep (scripts/sweep.js) asks "is anything broken?" and fails the push if
 * so. This asks the other question, the way the Library's `python -m library
 * housekeeping` and SillyTavern Connect's housekeeping.mjs do: what is dead,
 * duplicated, stale or out of step. It never fails a run; everything here is a
 * candidate to review, not a verdict. Four kinds of finding:
 *
 *   code     read from the source, never changed: top-level functions and
 *            constants nothing uses, imports a file never reads, function bodies
 *            written twice, packages nothing imports, panel CSS classes no page
 *            uses. (Unused exports are the sweep's job.)
 *   files    regenerable leftovers: the worker's bundles, Lavalink's logs and jar
 *            while music is shelved, data files no store reads.
 *   data     what data/ says, checked against what PRIVACY.md promises: opted-out
 *            members still counted, daily counts and transcripts past 30 days, tickets left open.
 *   config   places two files must agree: the worker the site talks to vs. the one
 *            the bot syncs with, the application ID in .env vs. wrangler.toml,
 *            the Pages address vs. the git remote; and settings nothing reads.
 *
 * `--clean` deletes files only, never code, settings or data/ records, and never
 * anything a running Lavalink or `wrangler dev` has open.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const CLEAN = args.has('--clean');
const ALL = args.has('--all');
const VERBOSE = args.has('--verbose') || args.has('-v');

const CODE_DIRS = ['src', 'panel', 'worker/src', 'scripts'];
const MIN_DUPLICATE_LINES = 12;
const DAY = 24 * 60 * 60 * 1000;

/** @type {{ area: string, kind: string, where: string, detail: string, file: string|null, size: number, setAside: boolean }[]} */
const findings = [];
function add(area, kind, where, detail = '', file = null, setAside = false) {
  findings.push({ area, kind, where, detail, file, size: file ? sizeOf(file) : 0, setAside });
}

const rel = (path) => relative(ROOT, path).replaceAll('\\', '/') || '.';
const read = (path) => readFileSync(path, 'utf8').replace(/^﻿/, '');
const readJson = (path) => {
  try {
    return JSON.parse(read(path));
  } catch {
    return null;
  }
};
const mb = (n) => (n >= 104858 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const escape = (name) => name.replace(/[$]/g, '\\$');
// A name after a dot is a property, not a use; after a spread (...name) it is.
const wordCount = (text, name) => (text.replaceAll('...', '   ').match(new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`, 'g')) ?? []).length;

function sizeOf(path) {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((n, name) => n + sizeOf(join(path, name)), 0);
  } catch {
    return 0;
  }
}

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path, exts, out);
    } else if (exts.has(extname(entry.name))) out.push(path);
  }
  return out;
}

/** KEY=value pairs from an env-style file. */
function envOf(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  for (const line of read(path).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

function portInUse(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      done(false);
    });
  });
}

const env = envOf(join(ROOT, '.env'));
const example = envOf(join(ROOT, '.env.example'));
const setting = (key) => (env.has(key) ? env.get(key) : example.get(key) ?? '');

// ---------------------------------------------------------------------------
//   Code
// ---------------------------------------------------------------------------

/** Source with comments, strings and template text blanked (line structure kept), so names inside them don't count. */
function stripped(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Source with comments blanked only: a name read inside a template literal's ${} still counts. */
function withoutComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Top-level definitions that aren't exported (the sweep already checks exports). */
function localDefinitions(src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    const m = /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^class\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

/** Every function with a body (exported or not), for the duplicate check. */
function functionStarts(src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$/.exec(line)
      ?? /^  (?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/.exec(line);
    if (m && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

function checkCode() {
  const files = CODE_DIRS.flatMap((d) => walk(join(ROOT, d), new Set(['.js'])));
  const sources = new Map(files.map((f) => [f, read(f)]));
  const html = existsSync(join(ROOT, 'panel', 'index.html')) ? read(join(ROOT, 'panel', 'index.html')) : '';

  for (const [file, src] of sources) {
    const lines = src.split(/\r?\n/);
    const code = withoutComments(src);

    // Top-level functions and constants nothing in their own file reads. (Not exported, so nothing else can.)
    const exported = new Set([...src.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0])));
    for (const def of localDefinitions(src)) {
      if (exported.has(def.name)) continue;
      const uses = wordCount(code, def.name) - wordCount(lines[def.line - 1], def.name);
      if (uses <= 0 && !wordCount(html, def.name)) add('code', 'defined but never used', `${rel(file)}:${def.line}`, def.name);
    }

    // Imports the file never reads.
    lines.forEach((line, i) => {
      const m = /^import\s+(.+?)\s+from\s+['"]/.exec(line);
      if (!m) return;
      const names = [];
      const braces = /\{([^}]*)\}/.exec(m[1]);
      if (braces) names.push(...braces[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
      names.push(...m[1].replace(/\{[^}]*\}/, '').replace(/^\*\s+as\s+/, '').split(',').map((s) => s.trim()).filter(Boolean));
      const rest = code.split('\n').filter((_, j) => j !== i).join('\n');
      for (const name of names) if (!wordCount(rest, name)) add('code', 'unused import', `${rel(file)}:${i + 1}`, name);
    });
  }

  // The same body written twice, whatever its variables are called.
  const bodies = new Map();
  for (const [file, src] of sources) {
    const lines = stripped(src).split(/\r?\n/);
    for (const fn of functionStarts(src)) {
      let depth = 0;
      let end = -1;
      for (let i = fn.line - 1; i < lines.length && end < 0; i++) {
        for (const ch of lines[i]) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
        if (depth === 0 && lines[i].includes('}')) end = i;
      }
      if (end < 0 || end - fn.line < MIN_DUPLICATE_LINES) continue;
      const shape = lines.slice(fn.line, end).map((l) => l.replace(/[A-Za-z_$][\w$]*/g, '_').replace(/\s+/g, '')).join('');
      bodies.set(shape, [...(bodies.get(shape) ?? []), `${rel(file)}:${fn.line} ${fn.name}`]);
    }
  }
  for (const places of bodies.values()) {
    if (places.length > 1) add('code', 'duplicated body', places[0], `same as ${places.slice(1).join(', ')}`);
  }

  // Packages listed that nothing imports, and packages imported that aren't installed.
  for (const [pkgDir, codeDirs] of [['.', ['src', 'scripts']], ['worker', ['worker/src']]]) {
    const pkg = readJson(join(ROOT, pkgDir, 'package.json'));
    if (!pkg) continue;
    const text = codeDirs.flatMap((d) => walk(join(ROOT, d), new Set(['.js']))).map(read).join('\n');
    const scripts = Object.values(pkg.scripts ?? {}).join('\n');
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const imported = new RegExp(`from\\s+['"]${name}(?:/[^'"]*)?['"]|import\\(\\s*['"]${name}|import\\s+['"]${name}`).test(text);
      if (!imported && !scripts.includes(name)) add('code', 'package nothing imports', `${pkgDir}/package.json`, name);
    }
    for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
      // CI installs only what each job needs, so a missing package there means nothing.
      if (!process.env.CI && !existsSync(join(ROOT, pkgDir, 'node_modules', name))) {
        add('config', 'package listed but not installed', `${pkgDir}/package.json`, `${name}: run npm install${pkgDir === '.' ? '' : ` in ${pkgDir}/`}`);
      }
    }
  }

  // Panel styles no page uses. Class names are matched as whole words anywhere in the panel's
  // scripts and pages (the legal pages are built by scripts/build-legal.js). A numbered class
  // (.s2) counts when its stem is built from a number (`s${i + 1}`).
  const cssPath = join(ROOT, 'panel', 'style.css');
  if (existsSync(cssPath)) {
    const css = read(cssPath).replace(/\/\*[\s\S]*?\*\//g, '');
    const panel = [html, ...walk(join(ROOT, 'panel'), new Set(['.js'])).map(read), read(join(ROOT, 'scripts', 'build-legal.js'))].join('\n');
    const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)(?=[^{}]*\{)/g)].map((m) => m[1]));
    for (const name of classes) {
      const stem = name.match(/^(.*?)\d+$/)?.[1];
      if (new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(panel) || (stem && panel.includes(`${stem}\${`))) continue;
      add('code', 'panel style no page uses', 'panel/style.css', `.${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
//   Files
// ---------------------------------------------------------------------------

/** The store names src/utils/store.js creates: the only data/ files anything reads. */
function storeNames() {
  const path = join(ROOT, 'src', 'utils', 'store.js');
  return new Set([...read(path).matchAll(/createStore\(\s*'([\w-]+)'\s*\)/g)].map((m) => `${m[1]}.json`));
}

async function checkFiles() {
  const musicOn = setting('ENABLE_MUSIC') === 'true';
  const lavalinkUp = await portInUse(Number(setting('LAVALINK_PORT')) || 2333);
  const workerDevUp = await portInUse(8787);

  // Lavalink only matters while music is on; the sweep already clears logs older than 30 days.
  const logs = join(ROOT, 'lavalink', 'logs');
  if (!musicOn && !lavalinkUp && existsSync(logs)) {
    for (const name of readdirSync(logs)) add('files', 'Lavalink log while music is shelved', rel(join(logs, name)), '', join(logs, name));
  }
  const jar = join(ROOT, 'lavalink', 'Lavalink.jar');
  if (!musicOn && !lavalinkUp && existsSync(jar)) {
    add('files', 'Lavalink.jar while music is shelved', 'lavalink/Lavalink.jar', 'download it again when music comes back (MAINTAINING.md -> Music)', jar, true);
  }

  // wrangler dev rebuilds its bundles every start; the local database is the panel's test data.
  const wrangler = join(ROOT, 'worker', '.wrangler');
  if (!workerDevUp && existsSync(join(wrangler, 'tmp'))) {
    for (const name of readdirSync(join(wrangler, 'tmp'))) add('files', 'worker bundle from wrangler dev', `worker/.wrangler/tmp/${name}`, 'remade on the next npm run panel:api', join(wrangler, 'tmp', name));
  }
  if (!workerDevUp && existsSync(join(wrangler, 'state'))) {
    add('files', 'local test database for the panel', 'worker/.wrangler/state', 'only npm run panel:api uses it; remade empty', join(wrangler, 'state'), true);
  }

  const data = join(ROOT, 'data');
  if (existsSync(data)) {
    const stores = storeNames();
    for (const name of readdirSync(data).filter((n) => n.endsWith('.json'))) {
      if (!stores.has(name)) add('files', 'data file no store reads', `data/${name}`, 'left by a store that was renamed or removed', join(data, name), true);
    }
    const saved = join(data, 'filter-words.txt');
    if (existsSync(saved) && read(saved).trim() === read(join(ROOT, 'filter-words.txt')).trim()) {
      add('files', 'saved word list identical to the repo list', 'data/filter-words.txt', 'while it exists, edits to filter-words.txt have no effect', saved, true);
    }
  }

  // Terms and privacy pages are built in CI; local copies only feed the local preview.
  for (const [page, source] of [['panel/terms.html', 'TERMS.md'], ['panel/privacy.html', 'PRIVACY.md']]) {
    const path = join(ROOT, page);
    if (existsSync(path) && statSync(path).mtimeMs < statSync(join(ROOT, source)).mtimeMs) {
      add('files', 'built page older than its source', page, `${source} changed since; npm run legal rebuilds it`, path);
    }
  }
}

// ---------------------------------------------------------------------------
//   The bot's data, against what PRIVACY.md promises
// ---------------------------------------------------------------------------

function checkData() {
  const data = join(ROOT, 'data');
  if (!existsSync(data)) return;
  const store = (name) => readJson(join(data, `${name}.json`)) ?? {};

  // The live bot runs on the Oracle VM; a copy here goes stale the moment it's taken.
  const newest = Math.max(0, ...readdirSync(data).map((n) => statSync(join(data, n)).mtimeMs));
  if (newest && Date.now() - newest > 7 * DAY) {
    add('data', 'data/ here is an old copy', 'data/', `last written ${new Date(newest).toISOString().slice(0, 10)}; for the live data, run housekeeping on the VM`);
  }

  // Opting out deletes a member's statistics and XP in that server (PRIVACY.md 2.2). Anything left is a broken promise.
  const optouts = store('optouts');
  const activity = store('activity');
  const levels = store('levels');
  const connections = store('connections');
  const games = store('games');
  const voice = store('voice');
  for (const [guildId, members] of Object.entries(optouts)) {
    for (const userId of Object.keys(members)) {
      const left = [];
      if (activity[guildId]?.[userId]) left.push('activity');
      if (levels[guildId]?.[userId]) left.push('levels');
      if (games[userId]?.guilds?.[guildId]) left.push('games');
      if (Object.values(voice[userId]?.channels ?? {}).some((c) => c.guildId === guildId)) left.push('voice');
      if (Object.values(voice).some((u) => Object.values(u.channels ?? {}).some((c) => c.guildId === guildId && c.with?.[userId]))) left.push('voice (others\' time with them)');
      if (Object.keys(connections[guildId] ?? {}).some((key) => key.split('-').includes(userId))) left.push('connections');
      if (left.length) add('data', 'opted-out member still counted', `server ${guildId}`, `user ${userId} in ${left.join(', ')}; src/features/optOut.js should have deleted it`);
    }
  }

  // "Daily message counts: 30 days" (PRIVACY.md, section 8).
  const cutoff = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  for (const [guildId, members] of Object.entries(activity)) {
    let old = 0;
    for (const member of Object.values(members)) old += Object.keys(member.daily ?? {}).filter((day) => day < cutoff).length;
    if (old) add('data', 'daily message counts older than 30 days', `server ${guildId}`, `${old} day(s) kept past what PRIVACY.md promises`);
  }

  // "Ticket transcripts: up to 30 days" (PRIVACY.md, section 8). A server's transcripts are all deleted
  // together on its deleteAt, which src/features/transcripts.js sets 30 days after the first one closes.
  for (const [guildId, cycle] of Object.entries(store('transcripts'))) {
    const list = Object.values(cycle.list ?? {});
    if (!list.length) continue;
    const oldest = Math.min(...list.map((t) => t.closedAt ?? Date.now()));
    const old = list.filter((t) => Date.now() - (t.closedAt ?? Date.now()) > 30 * DAY);
    if (!cycle.deleteAt) add('data', 'transcripts with no delete date', `server ${guildId}`, `${list.length} transcript(s) that will never be deleted`);
    else if (cycle.deleteAt - oldest > 30 * DAY + DAY) add('data', 'transcripts set to be kept past 30 days', `server ${guildId}`, `delete date ${new Date(cycle.deleteAt).toISOString().slice(0, 10)} is ${Math.round((cycle.deleteAt - oldest) / DAY)} days after the oldest closed`);
    if (old.length) add('data', 'transcripts older than 30 days', `server ${guildId}`, `${old.map((t) => `#${t.number}`).join(', ')}; kept past what PRIVACY.md promises${cycle.deleteAt && cycle.deleteAt <= Date.now() ? ' (the delete date has passed: is the bot running?)' : ''}`);
  }

  // Tickets left open a month, and temporary voice rooms the bot still thinks exist.
  for (const [guildId, guild] of Object.entries(store('tickets'))) {
    const stale = Object.values(guild.byChannel ?? {}).filter((t) => t.status !== 'archived' && Date.now() - (t.createdAt ?? Date.now()) > 30 * DAY);
    if (stale.length) add('data', 'tickets open for 30+ days', `server ${guildId}`, stale.map((t) => `#${t.number}`).join(', '));
  }
  const rooms = Object.entries(store('tempvoice')).reduce((n, [, r]) => n + Object.keys(r).length, 0);
  if (rooms && newest && Date.now() - newest > DAY) add('data', 'temporary voice rooms recorded but untouched for a day', 'data/tempvoice.json', `${rooms} room(s); the bot tidies these when it starts`);
}

// ---------------------------------------------------------------------------
//   Configuration
// ---------------------------------------------------------------------------

function checkConfig() {
  const toml = existsSync(join(ROOT, 'worker', 'wrangler.toml')) ? read(join(ROOT, 'worker', 'wrangler.toml')) : '';
  const tomlVar = (name) => toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? '';
  const panelConfig = existsSync(join(ROOT, 'panel', 'config.js')) ? read(join(ROOT, 'panel', 'config.js')) : '';
  const deployedApi = panelConfig.match(/DEPLOYED_API = '([^']*)'/)?.[1]?.replace(/\/$/, '') ?? '';

  if (env.size) {
    const panelUrl = (env.get('PANEL_URL') ?? '').replace(/\/$/, '');
    if (panelUrl && deployedApi && panelUrl !== deployedApi && !/localhost|127\.0\.0\.1/.test(panelUrl)) {
      add('config', 'the bot syncs with a different worker than the site uses', '.env PANEL_URL', `${panelUrl} vs panel/config.js ${deployedApi}`);
    }
    if (panelUrl && !env.get('PANEL_SECRET')) add('config', 'PANEL_URL set without PANEL_SECRET', '.env', 'the worker refuses the bot without it');
    const clientId = env.get('CLIENT_ID');
    if (clientId && tomlVar('DISCORD_CLIENT_ID') && clientId !== tomlVar('DISCORD_CLIENT_ID')) {
      add('config', 'two different application IDs', 'worker/wrangler.toml', `DISCORD_CLIENT_ID ${tomlVar('DISCORD_CLIENT_ID')} vs .env CLIENT_ID ${clientId}`);
    }
    if (env.get('DEV_GUILD_ID')) add('config', 'commands go to one test server only', '.env DEV_GUILD_ID', 'clear it and npm run deploy to register them everywhere');
    if (env.get('ENABLE_MUSIC') === 'true') add('config', 'music switched on while it is shelved', '.env ENABLE_MUSIC', 'its commands are not registered (MAINTAINING.md -> Music)');
    const extra = [...env.keys()].filter((k) => !example.has(k));
    if (extra.length) add('config', 'settings in .env nothing reads', '.env', extra.join(', '));
  }

  // Pages publishes at OWNER.github.io/REPO/; the worker only accepts sign-ins from SITE_ORIGIN + SITE_PATH.
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const gh = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (gh && toml) {
    const expected = `https://${gh[1].toLowerCase()}.github.io/${gh[2]}/`;
    const actual = `${tomlVar('SITE_ORIGIN')}${tomlVar('SITE_PATH')}`;
    if (actual.toLowerCase() !== expected.toLowerCase()) add('config', 'the worker expects the site somewhere GitHub does not publish it', 'worker/wrangler.toml', `${actual} vs ${expected} (from the git remote)`);
  }

  // Migrations run in name order; a gap or a repeated number means one was renamed or lost.
  const migrations = existsSync(join(ROOT, 'worker', 'migrations')) ? readdirSync(join(ROOT, 'worker', 'migrations')).filter((n) => n.endsWith('.sql')).sort() : [];
  migrations.forEach((name, i) => {
    const n = Number(name.match(/^(\d+)/)?.[1]);
    if (n !== i + 1) add('config', 'worker migrations out of sequence', `worker/migrations/${name}`, `expected ${String(i + 1).padStart(4, '0')}_...`);
  });

  for (const doc of ['TERMS.md', 'PRIVACY.md']) {
    const placeholders = [...read(join(ROOT, doc)).matchAll(/\[(?:your|insert|todo|tbd)[^\]]*\]/gi)].map((m) => m[0]);
    if (placeholders.length) add('config', 'placeholder left in the legal pages', doc, [...new Set(placeholders)].join(', '));
  }

  // Branches already in main, and stashes nobody came back for.
  const merged = spawnSync('git', ['branch', '--merged', 'main', '--format=%(refname:short)'], { cwd: ROOT, encoding: 'utf8' }).stdout
    .split('\n').map((s) => s.trim()).filter((b) => b && b !== 'main');
  for (const branch of merged) add('config', 'branch already merged into main', branch, `git branch -d ${branch}`);
  const stashes = spawnSync('git', ['stash', 'list'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  if (stashes.length) add('config', 'stashed changes', 'git stash', `${stashes.length} stash(es); the oldest: ${stashes.at(-1)}`);
}

// ---------------------------------------------------------------------------

const steps = [['code', checkCode], ['files', checkFiles], ['data', checkData], ['config', checkConfig]];
for (const [name, step] of steps) {
  try {
    await step();
  } catch (err) {
    add('config', `${name} check could not run`, 'scripts/housekeeping.js', err.message);
  }
}

const TITLES = {
  code: 'CODE  (review by hand; nothing here is changed)',
  files: 'FILES',
  data: 'THE BOT\'S DATA  (review; records are never deleted here)',
  config: 'CONFIGURATION  (review by hand)',
};
console.log('\nHOUSEKEEPING');
for (const area of Object.keys(TITLES)) {
  const items = findings.filter((f) => f.area === area);
  if (!items.length) continue;
  const total = items.reduce((n, f) => n + f.size, 0);
  console.log(`\n${TITLES[area]}: ${items.length} finding(s)${total ? `, ${mb(total)}` : ''}`);
  const groups = new Map();
  for (const f of items) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
  for (const [kind, list] of groups) {
    const size = list.reduce((n, f) => n + f.size, 0);
    console.log(`  ${kind}: ${list.length}${size ? ` (${mb(size)})` : ''}${list.some((f) => f.setAside) ? '  [set aside]' : ''}`);
    const shown = VERBOSE || area !== 'files' ? list : list.slice(0, 5);
    for (const f of shown) console.log(`    ${f.where}${f.detail ? `  ${f.detail}` : ''}`);
    if (shown.length < list.length) console.log(`    ... and ${list.length - shown.length} more (--verbose lists them)`);
  }
}

const deletable = findings.filter((f) => f.file);
const now = deletable.filter((f) => !f.setAside);
const aside = deletable.filter((f) => f.setAside);
if (!findings.length) {
  console.log('\nNothing to tidy.');
} else if (CLEAN) {
  let n = 0;
  let size = 0;
  for (const f of deletable) {
    if (f.setAside && !ALL) continue;
    try {
      rmSync(f.file, { recursive: true, force: true });
      n++;
      size += f.size;
    } catch (err) {
      console.log(`  could not delete ${f.where}: ${err.message}`);
    }
  }
  console.log(`\nDeleted ${n} item(s), ${mb(size)}.${aside.length && !ALL ? ` Kept ${aside.length} set-aside item(s) (--clean --all deletes them).` : ''}`);
} else if (deletable.length) {
  console.log(`\n--clean would delete ${now.length} item(s), ${mb(now.reduce((s, f) => s + f.size, 0))}`
    + `${aside.length ? `; --clean --all another ${aside.length}, ${mb(aside.reduce((s, f) => s + f.size, 0))}` : ''}. Code, settings and data records are never changed.`);
}
console.log();
