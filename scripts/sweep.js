/**
 * Housekeeping sweep: is anything in the bot broken, stale or left lying around?
 *
 *     npm run sweep                  report only
 *     npm run sweep -- --clean       also delete the leftovers it lists
 *
 * Every check prints OK or FAIL with what is wrong, and the run exits non-zero
 * if any check fails, so a pre-push hook or CI can run it. It never contacts
 * Discord and never changes code or settings; --clean only deletes the files
 * listed under LEFTOVERS.
 *
 * This exists because `npm start` proves very little. A command whose file
 * imports a name another file stopped exporting only fails when that command
 * is loaded; a button whose custom ID names no handler only fails when someone
 * clicks it; a setting the code reads but .env.example never mentions only
 * shows up as a feature that quietly does nothing. The checks here look at what
 * the files say and how they fit together.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLEAN = process.argv.includes('--clean');

let checks = 0;
let failures = 0;

/** Reports one check. `bad` lists what is wrong; empty means OK. */
function check(name, bad, note = '', limit = 12) {
  checks++;
  if (!bad.length) {
    console.log(`  OK    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}  (${bad.length})`);
  if (note) console.log(`        ${note}`);
  for (const b of bad.slice(0, limit)) console.log(`        - ${b}`);
  if (bad.length > limit) console.log(`        ... and ${bad.length - limit} more`);
}

const rel = (path) => relative(ROOT, path).replaceAll('\\', '/');
const read = (path) => readFileSync(path, 'utf8');
const lines = (path) => read(path).split(/\r?\n/);

// Never swept: installed packages, runtime data, logs, and the secrets file.
const SKIP = new Set(['node_modules', '.git', '.claude', 'data', 'lavalink/logs', '.env', 'worker/node_modules', 'worker/.wrangler', 'worker/.dev.vars']);

/** Every project file, so nothing installed or generated is swept. */
function files(dir = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIP.has(rel(path))) continue;
    if (entry.isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

const jsFiles = () => files().filter((p) => p.endsWith('.js'));
const srcFiles = () => jsFiles().filter((p) => rel(p).startsWith('src/'));

// ---------------------------------------------------------------------------
//   The code
// ---------------------------------------------------------------------------

const IMPORT_NAMED = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gs;
const IMPORT_DEFAULT = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](\.[^'"]+)['"]/g;
const IMPORT_BARE = /import\s*['"](\.[^'"]+)['"]/g;
const REEXPORT_NAMED = /export\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gs;
const REEXPORT_STAR = /export\s*\*\s*from\s*['"](\.[^'"]+)['"]/g;
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;
const DYNAMIC = /import\(\s*(?:['"](\.[^'"]+)['"]|new URL\(\s*['"](\.[^'"]+)['"],\s*import\.meta\.url\s*\))\s*\)/g;
const DESTRUCTURED = /\{([^}]*)\}\s*=\s*await\s+import\(\s*(?:['"](\.[^'"]+)['"]|new URL\(\s*['"](\.[^'"]+)['"],\s*import\.meta\.url\s*\))\s*\)/g;

/** '{ a, b as c }' -> [[a, a], [b, c]]: [name in the source, name here]. */
function namesIn(block) {
  return block
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const bits = part.split(/\s+as\s+/);
      return [bits[0].trim(), bits.at(-1).trim()];
    });
}

const exportCache = new Map();

/** Every name a module exports, following `export * from` chains. */
function exportsOf(path, seen = new Set()) {
  if (exportCache.has(path)) return exportCache.get(path);
  if (seen.has(path) || !existsSync(path)) return new Set();
  seen.add(path);
  const text = read(path);
  const names = new Set([...text.matchAll(EXPORT_DECL)].map((m) => m[1]));
  for (const m of text.matchAll(EXPORT_LIST)) for (const [, local] of namesIn(m[1])) names.add(local);
  for (const m of text.matchAll(REEXPORT_NAMED)) for (const [, local] of namesIn(m[1])) names.add(local);
  for (const m of text.matchAll(REEXPORT_STAR)) for (const n of exportsOf(resolve(dirname(path), m[1]), seen)) names.add(n);
  if (/^export\s+default\b/m.test(text)) names.add('default');
  exportCache.set(path, names);
  return names;
}

/** What each file asks of the files it imports: [{ from, target, names }]. */
function importsOf(path) {
  const text = read(path);
  const here = dirname(path);
  const wanted = [];
  const add = (spec, names) => wanted.push({ from: path, spec, target: resolve(here, spec), names });
  for (const m of text.matchAll(IMPORT_NAMED)) add(m[2], namesIn(m[1]).map(([src]) => src));
  for (const m of text.matchAll(REEXPORT_NAMED)) add(m[2], namesIn(m[1]).map(([src]) => src));
  for (const m of text.matchAll(IMPORT_DEFAULT)) add(m[2], ['default']);
  for (const m of text.matchAll(IMPORT_BARE)) add(m[1], []);
  for (const m of text.matchAll(REEXPORT_STAR)) add(m[1], []);
  for (const m of text.matchAll(DYNAMIC)) add(m[1] ?? m[2], []);
  for (const m of text.matchAll(DESTRUCTURED)) add(m[2] ?? m[3], namesIn(m[1]).map(([src]) => src.split(':')[0].trim()));
  return wanted;
}

async function sweepCode() {
  console.log('THE CODE');

  const unparsed = [];
  for (const path of jsFiles()) {
    const run = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (run.status !== 0) unparsed.push(`${rel(path)}  ${(run.stderr.match(/SyntaxError.*$/m) ?? ['syntax error'])[0]}`);
  }
  check('every file parses', unparsed);

  const missingFiles = [];
  const missingNames = [];
  const imported = new Map(); // file -> names other files import from it
  for (const path of jsFiles()) {
    for (const { spec, target, names } of importsOf(path)) {
      if (!existsSync(target)) {
        missingFiles.push(`${rel(path)} imports ${spec}`);
        continue;
      }
      const have = exportsOf(target);
      if (!imported.has(target)) imported.set(target, new Set());
      for (const name of names) {
        imported.get(target).add(name);
        if (!have.has(name)) missingNames.push(`${rel(path)} imports ${name} from ${spec}, which does not export it`);
      }
    }
  }
  check('every import points at a file that exists', missingFiles);
  check('every name imported is exported', missingNames, 'The file loads, then crashes the moment it is imported.');

  // Commands are found by loadCommands and their handlers by name, never by import.
  const reachedByName = new Set(['default', 'execute', 'handleButton', 'handleModal', 'data']);
  const unused = [];
  for (const path of srcFiles()) {
    const used = imported.get(path) ?? new Set();
    for (const name of exportsOf(path)) {
      if (!reachedByName.has(name) && !used.has(name)) unused.push(`${rel(path)}  ${name}`);
    }
  }
  check('every export is imported somewhere', unused, 'Candidates, not verdicts: drop the export, or the code if nothing uses it.');

  // The commands themselves: loaded the way deploy-commands.js loads them.
  const { loadCommands } = await import(new URL('../src/loadCommands.js', import.meta.url));
  const warn = console.warn;
  const skipped = [];
  console.warn = (msg) => skipped.push(String(msg));
  let commands = new Map();
  try {
    commands = await loadCommands();
  } catch (err) {
    skipped.push(`loading the commands threw: ${err.message}`);
  } finally {
    console.warn = warn;
  }
  check('every command file exports { data, execute }', skipped);

  const badDefs = [];
  for (const [name, command] of commands) {
    try {
      command.data.toJSON();
    } catch (err) {
      badDefs.push(`${name}: ${err.message.split('\n')[0]}`);
    }
  }
  const commandCount = commandFiles().length;
  if (commandCount !== commands.size + skipped.length) badDefs.push(`${commandCount} command files but ${commands.size} distinct names: two share a name`);
  check('every command builds and has its own name', badDefs, "Discord rejects the whole deploy if one command's definition is invalid.");

  // A button or form whose custom ID names no handler fails only when someone clicks it.
  const orphanIds = [];
  for (const path of srcFiles()) {
    lines(path).forEach((line, i) => {
      for (const m of line.matchAll(/(setCustomId|buildModal|embedModal)\(\s*[`'"](\w+):/g)) {
        const handler = m[1] === 'setCustomId' ? 'handleButton' : 'handleModal';
        if (!commands.get(m[2])?.[handler]) orphanIds.push(`${rel(path)}:${i + 1}  "${m[2]}:" but /${m[2]} has no ${handler}`);
      }
    });
  }
  check('every button and form has a handler', orphanIds, 'index.js routes custom IDs by the part before the first colon.');

  const debug = [];
  for (const path of srcFiles()) {
    lines(path).forEach((line, i) => {
      if (/\bdebugger\b|console\.debug\(|\b(TODO|FIXME|XXX)\b/.test(line)) debug.push(`${rel(path)}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  check('no debugging or TODOs left behind', debug);

  // A stray control character (an escape a script swallowed) reads as nothing in an editor.
  const control = [];
  for (const path of files().filter((p) => /\.(js|json|md|txt|yml|example)$/.test(p))) {
    lines(path).forEach((line, i) => {
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line)) control.push(`${rel(path)}:${i + 1}`);
    });
  }
  check('no stray control characters', control);

  return commands;
}

function commandFiles() {
  const dir = join(ROOT, 'src', 'commands');
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.js'));
}

// ---------------------------------------------------------------------------
//   The settings and the docs
// ---------------------------------------------------------------------------

/** KEY=value pairs from an env-style file. */
function envKeys(path) {
  const out = new Map();
  for (const line of lines(path)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

function sweepSettings(commands) {
  console.log('\nTHE SETTINGS AND THE DOCS');

  const example = envKeys(join(ROOT, '.env.example'));
  const read_ = new Set();
  for (const path of srcFiles()) {
    const text = read(path);
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read_.add(m[1]);
    for (const m of text.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*process\.env/g)) {
      for (const [name] of namesIn(m[1])) read_.add(name.split('=')[0].trim());
    }
  }
  check('every setting the code reads is in .env.example', [...read_].filter((k) => !example.has(k)),
    'Otherwise nobody setting the bot up knows it exists.');
  check('every setting in .env.example is read by the code', [...example.keys()].filter((k) => !read_.has(k)));

  const envPath = join(ROOT, '.env');
  // Your own .env only matters on this machine, so the pre-push hook skips it (SWEEP_SKIP_ENV=1).
  if (existsSync(envPath) && !process.env.SWEEP_SKIP_ENV) {
    const env = envKeys(envPath);
    const bad = ['DISCORD_TOKEN', 'CLIENT_ID'].filter((k) => !env.get(k));
    bad.push(...[...example.keys()].filter((k) => !env.has(k)).map((k) => `${k} is missing (the default applies)`));
    check('.env has a token, an application ID and every setting', bad, 'Compare it with .env.example.');
  }

  // Lavalink and the bot have to agree on where to meet.
  const yml = existsSync(join(ROOT, 'lavalink', 'application.yml')) ? read(join(ROOT, 'lavalink', 'application.yml')) : '';
  const bad = [];
  const password = yml.match(/password:\s*"?([^"\n]+)"?/)?.[1];
  const port = yml.match(/^\s*port:\s*(\d+)/m)?.[1];
  if (password !== example.get('LAVALINK_PASSWORD')) bad.push(`application.yml password "${password}" vs LAVALINK_PASSWORD "${example.get('LAVALINK_PASSWORD')}" in .env.example`);
  if (port !== example.get('LAVALINK_PORT')) bad.push(`application.yml port ${port} vs LAVALINK_PORT ${example.get('LAVALINK_PORT')} in .env.example`);
  check('Lavalink and .env.example agree on the port and password', bad);

  const readme = read(join(ROOT, 'README.md'));
  const undocumented = [...commands.values()]
    .map((c) => c.data)
    .filter((d) => !readme.includes(d.type && d.type !== 1 ? d.name : `/${d.name}`))
    .map((d) => d.name);
  check('every command is in the README', undocumented);

  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const scripts = Object.entries(pkg.scripts ?? {})
    .flatMap(([name, cmd]) => [...cmd.matchAll(/\bnode\s+([^\s&|;]+)/g)].map((m) => [name, m[1]]))
    .filter(([, file]) => !file.startsWith('-') && !existsSync(join(ROOT, file)))
    .map(([name, file]) => `npm run ${name} runs ${file}, which does not exist`);
  check('every npm script runs a file that exists', scripts);

  // Relative links in the docs, which the file pane and GitHub both follow.
  const links = [];
  for (const path of files().filter((p) => p.endsWith('.md'))) {
    for (const m of read(path).matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g)) {
      if (!existsSync(resolve(dirname(path), m[1].split('#')[0]))) links.push(`${rel(path)} links to ${m[1]}`);
    }
  }
  check('every link in the docs points at a file that exists', links);
}

// ---------------------------------------------------------------------------
//   The control panel
// ---------------------------------------------------------------------------

/**
 * The panel (panel/), its worker (worker/) and the bot (src/panel/) are three
 * programs that never share code, so nothing but this keeps their list of
 * changes in step. A change the panel sends that the worker doesn't allow, or
 * the bot can't handle, fails only when someone clicks it.
 */
async function sweepPanel() {
  console.log('\nTHE CONTROL PANEL');
  const workerPath = join(ROOT, 'worker', 'src', 'index.js');
  if (!existsSync(workerPath)) return;

  const block = read(workerPath).match(/const COMMANDS = \{([^}]*)\}/)?.[1] ?? '';
  const allowed = new Set([...block.matchAll(/'([\w.]+)':/g)].map((m) => m[1]));
  const { PANEL_COMMANDS } = await import(new URL('../src/panel/commands.js', import.meta.url));
  const handled = new Set(PANEL_COMMANDS);

  const sent = new Map(); // command -> where the panel sends it
  for (const path of files().filter((p) => rel(p).startsWith('panel/') && p.endsWith('.js'))) {
    lines(path).forEach((line, i) => {
      for (const m of line.matchAll(/(?:act\([^,]*,[^,]*,\s*|data-cmd="(?:\$\{[^}]*\?\s*)?|:\s*)'([a-z]+\.[a-z]+)'/g)) sent.set(m[1], `${rel(path)}:${i + 1}`);
      for (const m of line.matchAll(/data-cmd="([a-z]+\.[a-z]+)"/g)) sent.set(m[1], `${rel(path)}:${i + 1}`);
    });
  }

  check('the worker and the bot know the same panel changes', [
    ...[...allowed].filter((c) => !handled.has(c)).map((c) => `${c}: the worker allows it, the bot has no handler`),
    ...[...handled].filter((c) => !allowed.has(c)).map((c) => `${c}: the bot handles it, the worker refuses it`),
  ], 'COMMANDS in worker/src/index.js and HANDLERS in src/panel/commands.js.');
  check('every change the panel sends is one the worker allows',
    [...sent].filter(([c]) => !allowed.has(c)).map(([c, where]) => `${where}  ${c}`));

  const toml = existsSync(join(ROOT, 'worker', 'wrangler.toml')) ? read(join(ROOT, 'worker', 'wrangler.toml')) : '';
  check('no secret is written in wrangler.toml',
    [...toml.matchAll(/^\s*((DISCORD_CLIENT_SECRET|BOT_SECRET|OWNER_IDS|DEV_LOGIN)\s*=)/gm)].map((m) => m[2]),
    'Secrets go in with `npx wrangler secret put NAME`. DEV_LOGIN belongs only in worker/.dev.vars.');

  const config = read(join(ROOT, 'panel', 'config.js'));
  const api = config.match(/DEPLOYED_API = '([^']*)'/)?.[1] ?? '';
  check('the panel points at an https worker', /^https:\/\//.test(api) ? [] : [`DEPLOYED_API is "${api}"`]);
}

// ---------------------------------------------------------------------------
//   The data
// ---------------------------------------------------------------------------

// Ordinary words that share letters with a slur. A filter entry that blocks one of
// these deletes innocent messages.
const INNOCENT = `
  raccoon cocoon tycoon cocoons Scunthorpe Japan Japanese Niger Nigeria niggle snigger
  bigger trigger digger spice spicy chinchilla Chinook class assassin cocktail therapist
  Mongolia mongoose packing pakora Pakistan heebie Yiddish hydrant Sambuca
  retardant retardation spasm gypsum Saskatchewan Krauss squawk homogenous
`;

async function sweepData() {
  console.log('\nTHE DATA');

  const dataDir = join(ROOT, 'data');
  const bad = [];
  const ids = [];
  if (existsSync(dataDir)) {
    for (const name of readdirSync(dataDir).filter((n) => n.endsWith('.json'))) {
      try {
        const data = JSON.parse(read(join(dataDir, name)));
        for (const key of Object.keys(data)) if (!/^\d{17,20}$/.test(key)) ids.push(`${name}: "${key}" is not a server ID`);
      } catch (err) {
        bad.push(`data/${name}  ${err.message}`);
      }
    }
  }
  check('every data file is valid JSON', bad, 'A broken data file stops the bot starting. Restore it from a backup.');
  check('data is filed under server IDs', ids);

  const { parseWordList, findBlockedTerm } = await import(new URL('../src/features/wordFilter.js', import.meta.url));
  for (const file of ['filter-words.txt', 'filter-words.proposed.txt']) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const entries = lines(path).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const seen = new Set();
    const dupes = entries.filter((e) => seen.size === seen.add(e.toLowerCase()).size);
    check(`${file} lists each entry once`, dupes);

    let terms = [];
    try {
      terms = parseWordList(read(path));
    } catch (err) {
      check(`${file} parses`, [err.message]);
      continue;
    }
    const hits = INNOCENT.split(/\s+/)
      .filter(Boolean)
      .map((word) => [word, findBlockedTerm(word, terms)])
      .filter(([, hit]) => hit)
      .map(([word, hit]) => `"${word}" is blocked by ${hit}`);
    check(`${file} blocks no ordinary word`, hits, 'Narrow the entry, or drop a trailing * wildcard.');
  }
}

// ---------------------------------------------------------------------------
//   Safety
// ---------------------------------------------------------------------------

function sweepSafety() {
  console.log('\nSAFETY');

  // A bot token is three base64 parts; anyone holding one controls the bot.
  const token = /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/;
  const email = /[\w.+-]+@(gmail|yahoo|outlook|hotmail|icloud|proton)\.\w+/i;
  // Addresses meant to be public, and the only file each may appear in: the contact for opt-out requests.
  // (Joined at runtime so this line doesn't trip the check itself.)
  const publicEmails = Object.fromEntries(['PRIVACY.md', 'TERMS.md', 'panel/privacy.html', 'panel/terms.html'].map((f) => [f, [['smiledaemon77', 'gmail.com'].join('@')]]));
  const tokens = [];
  const emails = [];
  for (const path of files()) {
    if (/\.(png|jpe?g|gif|ico|jar)$/i.test(path)) continue;
    const allowed = publicEmails[rel(path).replace(/\\/g, '/')] ?? [];
    lines(path).forEach((line, i) => {
      if (token.test(line)) tokens.push(`${rel(path)}:${i + 1}`);
      const rest = allowed.reduce((text, address) => text.split(address).join(''), line);
      if (email.test(rest)) emails.push(`${rel(path)}:${i + 1}`);
    });
  }
  check('no bot token outside .env', tokens, 'Reset the token in the Developer Portal: one that has been copied anywhere is compromised.');
  check('no personal email address in the files', emails);

  const ignore = existsSync(join(ROOT, '.gitignore')) ? lines(join(ROOT, '.gitignore')).map((l) => l.trim()) : [];
  check('.gitignore keeps secrets, data and installs out of git',
    ['.env', 'data/', 'node_modules/'].filter((p) => !ignore.includes(p)));
}

// ---------------------------------------------------------------------------
//   Leftovers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** Files nothing needs any more. Listed always, deleted only with --clean. */
function sweepLeftovers() {
  console.log(`\nLEFTOVERS${CLEAN ? '  (cleaning)' : ''}`);
  const found = [];
  const logs = join(ROOT, 'lavalink', 'logs');
  if (existsSync(logs)) {
    for (const name of readdirSync(logs, { recursive: true })) {
      const path = join(logs, String(name));
      if (statSync(path).isFile() && Date.now() - statSync(path).mtimeMs > 30 * DAY) found.push([path, 'Lavalink log older than 30 days']);
    }
  }
  const data = join(ROOT, 'data');
  if (existsSync(data)) {
    for (const name of readdirSync(data).filter((n) => /\.(tmp|bak)$|~$/.test(n))) found.push([join(data, name), 'temporary data file']);
  }
  for (const name of readdirSync(ROOT).filter((n) => /^(npm-debug|yarn-error)\.log|\.log$/.test(n))) found.push([join(ROOT, name), 'crash log']);

  if (!found.length) console.log('  OK    nothing to clear');
  for (const [path, why] of found) {
    if (CLEAN) unlinkSync(path);
    console.log(`  ${CLEAN ? 'GONE' : 'TIDY'}  ${rel(path)}  (${why})`);
  }
  if (found.length && !CLEAN) console.log('        npm run sweep -- --clean  deletes these');
}

console.log(`\nHOUSEKEEPING SWEEP  -  ${files().length} files\n`);
const commands = await sweepCode();
sweepSettings(commands);
await sweepPanel();
await sweepData();
sweepSafety();
sweepLeftovers();
console.log(`\n${checks} checks, ${failures} failing\n`);
process.exit(failures ? 1 : 0);
