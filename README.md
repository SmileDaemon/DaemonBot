# DaemonBot

A general-purpose Discord bot for moderation, custom embeds, announcements, support tickets, server logging, and music. Built on [discord.js](https://discord.js.org) v14, Node.js 20.11+.

## Commands

| Command | What it does | Who can use it by default |
|---|---|---|
| `/ban` `/unban` | Ban (optionally deleting recent messages) / lift a ban by user ID | Ban Members |
| `/kick` | Kick a member | Kick Members |
| `/timeout` `/untimeout` | Mute someone for `10m`, `2h`, `1d`, `1h30m`… (max 28d) | Moderate Members |
| `/warn` | Give a recorded warning (user is DMed) | Moderate Members |
| `/warnings view` / `clear` | See or wipe someone's warnings | Moderate Members |
| `/purge` | Bulk-delete up to 100 recent messages, optionally from one user | Manage Messages |
| `/channel lock` / `unlock` / `slowmode` | Lock a channel for @everyone or set slowmode | Manage Channels |
| `/embed create` | Opens a form to write an embed (title, text, color, image, footer) and posts it | Manage Messages |
| `/embed edit message_link:` | Paste a link to any embed or announcement the bot posted. The form opens pre-filled, and anything it doesn't cover (timestamp, footer icon, attached image) is kept. Also available by right-clicking the message → **Apps → Edit Embed** | Manage Messages |
| `/announce` | Pick a channel, optional role/@everyone ping, image and color, then write the text in a form. Auto-publishes in announcement channels | Manage Messages |
| `/ticket open` / `close` | Open a private support ticket, or close the one you're in | Everyone |
| `/ticket setup` | Choose the ticket channel, staff role and (optional) queue channel, and post the "Open a ticket" button | Manage Server |
| `/play` | Play a song by search (SoundCloud) or by SoundCloud, Bandcamp, Twitch, Vimeo or direct audio link | Everyone |
| `/music` | `skip`, `pause`, `stop`, `queue`, `nowplaying`, `shuffle`, `volume`, `loop` | Everyone in the bot's voice channel |
| `/games stats` / `top` | A member's games (time played, sessions, how often), or the server's most played games and each game's top players | Everyone |
| `/games privacy` | Opt yourself in or out of game tracking (opting out deletes your history in that server) | Everyone |
| `/config log` / `filter` / `games` / `view` | Pick the log channel, turn the word filter or game tracking on/off for this server | Manage Server |
| `/help` `/ping` | Command list / latency check | Everyone |

**Safety:** moderators can't act on people with an equal or higher role, the bot won't post or ping anywhere the person running the command couldn't, and message-link previews only quote from channels the poster can read.

You can change who can use each command per server in **Server Settings → Integrations → DaemonBot**.

### Tickets
1. A member clicks **Open a ticket** (or runs `/ticket open`) and fills in a subject and details.
2. The bot creates a **private thread** in the ticket channel named `[PENDING] #0001 · username · subject` and adds the member. Only they, staff who claim it, and admins can see it.
3. A card with a **Claim** button appears in the queue. When a staff member claims it, they're added to the thread and it becomes `[ACTIVE] …`.
4. The member who opened it, or the staff member who claimed it, can close it with the **Close ticket** button or `/ticket close`. It becomes `[ARCHIVED] …` and is locked: still readable, but no new messages.
5. Closed tickets stay in the ticket channel. Members find their old tickets under the channel's **Threads** list → **Archived**.

Each member can have up to 3 open tickets at a time. Set up a separate staff-only `queue_channel` if ticket subjects shouldn't be visible to everyone who can see the ticket channel.

### Logging
Run `/config log channel:#your-log-channel`. Everything below is posted there:
- **Bot actions:** every moderation command, word-filter deletions, purges (with a .txt of what was deleted), channel lock/unlock/slowmode, embeds posted or edited, announcements, ticket opened/claimed/closed, and settings changes.
- **Server events** (with `ENABLE_SERVER_LOGS=true`). Anything done through the bot's own commands is logged once by the command, not again here.
  - **Members:** joined (with which invite they used, who made it and its new use count), left, kicked, banned, unbanned, timed out / timeout removed, roles added or removed, nickname, username and display name changes, started or stopped boosting, bots added (and by whom).
  - **Messages:** edited (before and after), deleted (with its content if the bot saw it, and who deleted it when it wasn't the author), bulk-deleted (with a .txt).
  - **Invites:** created (by whom, channel, max uses, expiry) and deleted (how many times it was used, and who deleted it).
  - **Server:** channels created, deleted or changed (including permission changes), roles created, deleted or changed (including permissions), server settings changed, emojis and stickers added, changed or removed, webhooks created, changed or deleted, and Discord AutoMod actions.

"Who did it" comes from the audit log, so the bot needs **View Audit Log**. Invite tracking and AutoMod rule names need **Manage Server**. Edits and deletions of messages sent before the bot started can't show the old text.

### Word filter
Messages (and edits) containing anything in [`filter-words.txt`](filter-words.txt) are deleted, the user gets a short notice, and the removal is logged. Edit the file in any text editor; the bot picks up changes within a few seconds. Matching ignores capitals, accents, l33t-speak, stretched letters and dots between letters, but only matches whole words ("coon" won't hit "raccoon"). Members with the Administrator permission (and the server owner) are exempt, and the bot needs Manage Messages in a channel to filter it.

### Game tracking
With `ENABLE_GAME_TRACKING=true`, the bot records the games members show as **Playing** in their Discord status, per server:
- **For each member and game:** total time played, number of sessions, average session length, how many different days they played, sessions per week, and when they last played.
- `/games stats` shows a member's games (🟢 marks one they're playing right now). `/games top` shows the server's most played games, and `/games top game:` (with autocomplete) shows that game's top players.
- Sessions under a minute aren't counted. Time in progress is saved every 10 minutes and when the bot is stopped, so a crash loses at most 10 minutes.
- It only sees games people share: members who hide their activity in Discord's privacy settings, or play something Discord doesn't detect, aren't recorded.
- Admins turn it off per server with `/config games enabled:false`. Members opt out with `/games privacy track:false`, which also deletes what was recorded about them in that server.

### Message previews (optional)
With `ENABLE_MESSAGE_QUOTES=true`, pasting a link to a message in the same server makes the bot reply with a preview of it.

## Setup

### 1. Create the bot application
1. Go to https://discord.com/developers/applications and click **New Application**.
2. **General Information:** copy the **Application ID**.
3. **Bot:** click **Reset Token** and copy the token. Treat it like a password.
4. On the **Bot** page, turn on **Message Content Intent** (word filter, server logs, previews), **Server Members Intent** (server logs) and **Presence Intent** (game tracking).

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

## Music (Lavalink)
Music runs through **Lavalink**, a separate audio server the bot connects to. It needs **Java 17 or newer**.

1. Install Java 17+ (for example [Adoptium Temurin 21](https://adoptium.net)). Check with `java -version`.
2. Download `Lavalink.jar` (v4) from https://github.com/lavalink-devs/Lavalink/releases and put it in the [`lavalink/`](lavalink) folder.
3. If you change the password in [`lavalink/application.yml`](lavalink/application.yml), change `LAVALINK_PASSWORD` in `.env` to match.
4. Start Lavalink in its own terminal, then start the bot:
   ```bash
   npm run lavalink
   ```
   The bot keeps retrying every 15 seconds, so start order doesn't matter.

**Sources:** SoundCloud (also used for searches), Bandcamp, Twitch, Vimeo, and direct audio/radio-stream links. YouTube and Spotify are deliberately not supported because both would break those services' terms.

The bot leaves the voice channel 2 minutes after the queue ends, or right away when everyone else leaves.

## Keeping it online
The bot only runs while `npm start` is running (and music only while Lavalink is running too). For 24/7 uptime, run both on an always-on machine or a host (a small VPS, Railway, fly.io, etc.), ideally with a process manager like [pm2](https://pm2.keymetrics.io): `npm i -g pm2 && pm2 start src/index.js --name daemonbot`.

## Data
Warnings, tickets, game stats and per-server settings are saved as JSON in `data/`. Back that folder up if you move hosts.

## Adding commands
Drop a file in any folder under `src/commands/` exporting `default { data, execute }` (see `src/commands/general/ping.js`), then `npm run deploy`.

## Housekeeping
Run `npm run sweep` after any change. It checks that imports, commands, buttons, settings, docs and word lists all fit together, and that no token or leftover file is lying around. See [MAINTAINING.md](MAINTAINING.md).
