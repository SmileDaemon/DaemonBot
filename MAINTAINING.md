# Maintaining DaemonBot

How to set up and keep the bot healthy. [README.md](README.md) covers what the bot does.

## Setup

### 1. Create the bot application
1. Go to https://discord.com/developers/applications and click **New Application**.
2. **General Information:** copy the **Application ID**.
3. **Bot:** click **Reset Token** and copy the token. Treat it like a password.
4. On the **Bot** page, turn on **Message Content Intent** (word filter, server logs, previews), **Server Members Intent** (server logs, activity and connection trackers) and **Presence Intent** (game tracking).

### 2. Configure
```bash
copy .env.example .env
```
Open `.env` and fill in `DISCORD_TOKEN` and `CLIENT_ID`. While testing, also set `DEV_GUILD_ID` to your server's ID (enable Developer Mode in Discord → right-click the server → Copy Server ID) so commands show up instantly.

### 3. Invite the bot to your servers
Open this URL with your Application ID substituted in:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1460560719030
```

That requests: Manage Server (invite tracking and AutoMod rule names in the logs), View Channels, Send Messages (+ in threads), Create Private Threads, Manage Threads, Embed Links, Attach Files, Read Message History, Mention Everyone, Manage Messages, Manage Channels, Manage Roles (channel locks and ticket setup), Kick, Ban, Timeout Members, View Audit Log, Connect and Speak.

Then in **Server Settings → Roles**, drag the bot's role **above** any roles it should be able to moderate.

### 4. Register commands and start
```bash
npm install
npm run deploy
npm start
```
Re-run `npm run deploy` whenever you add or change a command's options. When you're done testing, clear `DEV_GUILD_ID` and deploy again to register globally for every server.

### Optional features
Set in `.env`: `ENABLE_SERVER_LOGS` (server events in the log channel), `ENABLE_MESSAGE_QUOTES` (message-link previews), and `ENABLE_GAME_TRACKING`, `ENABLE_VOICE_TRACKING`, `ENABLE_ACTIVITY_TRACKING`, `ENABLE_CONNECTION_TRACKING` (the control panel's trackers, each also switched on or off per server in the panel). Game and voice time in progress is saved every 10 minutes and when the bot stops.

### Keeping it online
The bot only runs while `npm start` is running. It's hosted on [Railway](https://railway.com) (Hobby plan, about $5/month), which redeploys it on every push to `main` that touches the bot's code. [`railway.json`](railway.json) holds the start command, the restart policy and which files trigger a redeploy. Setting it up (once):

1. Sign up at railway.com with your GitHub account and pick the Hobby plan.
2. **New Project → Deploy from GitHub repo →** `SmileDaemon/DaemonBot`. Let Railway's GitHub app see the repository if it asks.
3. Open the service → **Variables → Raw Editor**, paste your `.env` and click Update. Leave out `LAVALINK_*` while music is shelved.
4. Add a volume, so `data/` survives redeploys: right-click the project canvas → **Volume**, attach it to the service, and set the mount path to `/app/data`.
5. Stop the bot on your PC (Ctrl+C) before the first deploy. Two copies would both answer every command and keep separate data.
6. Deploy. The service's **Deployments → View logs** should show `Logged in as …` and `Control panel: syncing with …`. The bot needs no public domain, so leave Networking alone.

Register commands (`npm run deploy`) from your PC as before: that talks to Discord directly and doesn't need the host.

### Data
Warnings, tickets, game, voice, activity and connection stats, and per-server settings are saved as JSON in `data/`. Word list edits made in the control panel are saved as `data/filter-words.txt`, which takes over from the repo's `filter-words.txt` once it exists, so a redeploy can't undo them; delete it to go back to the repo's list. On Railway, `data/` is the volume. Back that folder up if you move hosts.

### Adding commands
Drop a file in any folder under `src/commands/` exporting `default { data, execute }` (see `src/commands/general/ping.js`), then `npm run deploy`.

### Music (shelved)
Music is switched off and its commands aren't registered until it works properly. SoundCloud, the only free song search Lavalink has, changed its audio formats in 2026 and Lavalink can't play them yet ([lavaplayer#202](https://github.com/lavalink-devs/lavaplayer/pull/202)), so `/play` could only take pasted links.

Everything is kept for later: the commands are in [`src/music/commands/`](src/music/commands), the Lavalink connection in [`src/music/`](src/music), and Lavalink's settings in [`lavalink/application.yml`](lavalink/application.yml). To bring it back: move the two command files to `src/commands/music/`, set `ENABLE_MUSIC=true`, put `Lavalink.jar` (v4, needs Java 17+) in `lavalink/`, run `npm run lavalink` in its own terminal, and `npm run deploy`.

### Terms and privacy
Fill in the bracketed placeholders in [TERMS.md](TERMS.md) and [PRIVACY.md](PRIVACY.md) (your name, contact, bot host, governing law) before publishing them. Discord asks for links to both in the Developer Portal (your app → General Information) before a bot can be verified.

## Housekeeping

`npm start` proves very little: a command whose file imports something that no longer exists only fails when that command loads, and a button with no handler only fails when someone clicks it. `scripts/sweep.js` checks everything else:

```bash
npm run sweep
```

It needs only Node and never contacts Discord. It prints OK or FAIL for each check and exits non-zero if anything fails. It checks:

- **the code:** every file parses; every import points at a file that exists, and every name imported is one that file exports; every export is used somewhere (these are candidates to review, not verdicts); every command file exports `{ data, execute }`, builds a valid definition and has a name of its own; every button and form custom ID names a command with a `handleButton` / `handleModal`; no `debugger`, `console.debug` or TODO left in `src/`; no stray control characters.
- **the settings and the docs:** every `process.env` setting the code reads is in `.env.example`, and the reverse; your `.env` (if there is one) has a token, an application ID and every setting; `lavalink/application.yml` and `.env.example` agree on the port and password; every command appears in the README; every npm script and every relative link in the docs points at a file that exists.
- **the data:** every file in `data/` is valid JSON and filed under server IDs; each word list names each entry once and blocks no ordinary word (raccoon, Scunthorpe, Japanese, retardant, and so on).
- **the control panel:** the worker, the bot and the site agree on which changes the panel can make; no secret is written in `worker/wrangler.toml`; the site points at an `https` worker.
- **safety:** no bot token and no personal email address in any file outside `.env`; `.gitignore` keeps `.env`, `data/` and `node_modules/` out of git.
- **leftovers:** Lavalink logs older than 30 days, temporary files in `data/`, and crash logs. These are listed but don't fail the run. To delete them:

  ```bash
  npm run sweep -- --clean
  ```

  `--clean` never touches code, settings or the data files themselves.

Run it after any change, and especially after hand-editing a word list or `.env`. **To add a rule**, write a `check(name, bad)` in the right section of the script. Give it a name that says what should be true, and pass a list of what isn't.

## Control panel

The panel is a website for managing the bot from any browser, including your phone. It has three parts:

| Part | Folder | Runs on |
|---|---|---|
| The site: pages, charts, forms | `panel/` | GitHub Pages (free) |
| The relay: Discord sign-in, the panel's API, a database of history | `worker/` | a Cloudflare Worker with a D1 database (free tier) |
| The bot's side: sends status, analytics and logs, applies changes | `src/panel/` | inside the bot |

The bot only makes outgoing requests to the worker, every 10 seconds, so nothing on your PC is opened to the internet. Changes made in the panel wait in the worker until the bot collects them, which usually takes a few seconds. If the bot is offline, the panel shows what it last reported and applies changes when the bot is back.

**Who can use it:** anyone who signs in with Discord can manage the servers where they have **Manage Server** or **Administrator**, and only those servers. People listed in `OWNER_IDS` can see every server the bot is in, plus the bot-wide word list. Each change made in the panel is posted in that server's log channel with the name of whoever made it.

**What's stored in Cloudflare:** a copy of every log entry, including the text of deleted messages, kept for 90 days. Also daily counts (messages per channel, joins, commands and so on) for 400 days, and each server's latest snapshot (settings, warnings, tickets, tracker totals).

### Setting it up (once)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and a GitHub account.

1. **Put the code on GitHub.** Create a repository named `DaemonBot` and push this folder to it. GitHub Pages is free only for **public** repositories. `.env`, `data/` and the worker's local secrets are kept out by `.gitignore`, and the sweep checks that no token is committed. Then, in the repository, go to **Settings → Pages → Source** and choose **GitHub Actions**. The site will be at `https://YOUR-GITHUB-NAME.github.io/DaemonBot/`.
2. **Create the worker's database:**
   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler d1 create daemonbot-panel
   ```
   Copy the `database_id` it prints into `worker/wrangler.toml`.
3. **Fill in the rest of `worker/wrangler.toml`:**
   - `SITE_ORIGIN`: `https://YOUR-GITHUB-NAME.github.io`
   - `SITE_PATH`: `/DaemonBot/`
   - `DISCORD_CLIENT_ID`: your bot's Application ID.
4. **Set the worker's secrets.** Each command asks you for the value:
   ```bash
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put BOT_SECRET
   npx wrangler secret put OWNER_IDS
   ```
   - `DISCORD_CLIENT_SECRET`: Developer Portal → your app → **OAuth2** → Client Secret.
   - `BOT_SECRET`: make up a long random password. The bot uses it to prove it's your bot.
   - `OWNER_IDS`: your Discord user ID. To get it, turn on Developer Mode, right-click yourself and choose Copy User ID.
5. **Deploy the worker:**
   ```bash
   npm run deploy
   ```
   It prints the worker's address, such as `https://daemonbot-panel.YOUR-NAME.workers.dev`.
6. **Let Discord send sign-ins back to the worker.** In the Developer Portal, go to **OAuth2 → Redirects** and add the worker's address followed by `/auth/callback`.
7. **Point the site at the worker.** Put the worker's address in `DEPLOYED_API` in [`panel/config.js`](panel/config.js), then commit and push. GitHub publishes the site within a minute or two; the Actions tab shows progress.
8. **Connect the bot.** In the bot's `.env`, set `PANEL_URL` to the worker's address and `PANEL_SECRET` to the same `BOT_SECRET`, then restart the bot. It logs `Control panel: syncing with …`.

To update the worker later, run `npm run deploy` in `worker/`. Database changes go in new files in `worker/migrations/` and are applied by the same command. The site updates whenever `panel/` is pushed to `main`.

### Trying it locally

You can run the whole panel on this PC without Discord or Cloudflare accounts:

```bash
copy worker\.dev.vars.example worker\.dev.vars
npm run panel:api
```

Then, in a second terminal:

```bash
npm run panel
```

Open http://localhost:8020 and choose **Local test sign-in**, which signs you in as a made-up owner. The worker refuses local sign-in unless `DEV_LOGIN=1` is set in `worker/.dev.vars`, and even then only on localhost. That file is never deployed. To fill the local panel with real data, run the bot with `PANEL_URL=http://localhost:8787` and `PANEL_SECRET=local-test-secret` in `.env`.

### Adding something the panel can change

The site, the worker and the bot each need to know about the change. `npm run sweep` fails until all three do.

1. Add a handler to `HANDLERS` in [`src/panel/commands.js`](src/panel/commands.js). Validate the payload there: the bot is the last line of defense.
2. Allow it in `COMMANDS` in [`worker/src/index.js`](worker/src/index.js), as `'guild'` (anyone who manages that server) or `'owner'`.
3. Send it from [`panel/views.js`](panel/views.js) with `act(button, guildId, 'your.change', payload, reload)`.

To show new data, add it to `guildSnapshot` in [`src/panel/snapshot.js`](src/panel/snapshot.js). It reaches the panel as part of `GET /api/guilds/:id` without any change to the worker.

## Safeguards

### Pre-push hook

`.githooks/pre-push` runs before anything leaves this machine and refuses a push that would delete a branch on the remote, or one where the sweep fails. It only applies once the folder is a git repository. Hooks aren't carried by `git clone`, so enable them once per copy:

```bash
git config --local core.hooksPath .githooks
```

To push a deliberate exception:

```bash
ALLOW_DESTRUCTIVE=1 git push
```

### Backups

`data/` holds every server's settings, warnings, tickets and tracker records, and is not in git. The panel's history (logs and daily counts) lives in Cloudflare D1; export it with `npx wrangler d1 export daemonbot-panel --remote --output backup.sql` in `worker/`. Copy it somewhere safe before moving hosts or upgrading. If the sweep reports a broken data file, restore that file from a backup: the bot won't start with it.
