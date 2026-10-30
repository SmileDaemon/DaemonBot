# DaemonBot

A general-purpose Discord bot for moderation, custom embeds, announcements, support tickets and server logging. (Music is shelved for now; see below.) Built on [discord.js](https://discord.js.org) v14, Node.js 20.11+.

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
| `/config log` / `filter` / `view` | Pick the log channel, turn the word filter on/off for this server | Manage Server |
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

### Activity trackers (control panel only)
Four trackers record what members do. Their results are **only shown in the control panel**, with no Discord commands, and each one is switched on or off per server in the panel's settings. Time in progress is saved every 10 minutes and when the bot is stopped, so a crash loses at most 10 minutes.

- **Games** (`ENABLE_GAME_TRACKING=true`, needs **Presence Intent**): the games members show as **Playing** in their Discord status. There's one record per person, shared by every server they're in with the bot, so time isn't double-counted. For each game it keeps total time, sessions, average session length, days played, sessions per week, and first and last played. The panel shows the server's most played games, each game's top players, and each member's games. Members who hide their activity, or play something Discord doesn't detect, aren't recorded.
- **Voice** (`ENABLE_VOICE_TRACKING=true`): time each member spends in each voice channel, which server it's in, sessions, days and sessions per week, and **who they were in the channel with** (time spent together, per person). Records are per person; a server's panel shows only its own channels. The AFK channel and bots aren't counted.
- **Server activity** (`ENABLE_ACTIVITY_TRACKING=true`): per member and server, messages sent, reactions added, days active (in total and in the last 30), a day-by-day count for the last 30 days, their most-used channels, and voice time there. Only counts are kept, never message text.
- **Connections and groups** (`ENABLE_CONNECTION_TRACKING=true`): how strongly each pair of members is connected, scored from replies to each other (3 points), mentions (2), reactions to each other's messages (1), chatting back and forth in a channel within 2 minutes (1), and every 10 minutes spent together in voice or playing the same game (1; needs the voice and game trackers). The panel shows the strongest connections, each member's closest connections, and **groups**: clusters of 3 or more members who interact mostly with each other (found with the Louvain community method), with their size, how tightly knit they are, their voice and game time together and the games they play together. Connections are per server.

Game and voice sessions under a minute aren't counted. Turning a tracker off for a server keeps what was recorded so far.

### Message previews (optional)
With `ENABLE_MESSAGE_QUOTES=true`, pasting a link to a message in the same server makes the bot reply with a preview of it.

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

## Music (shelved)
Music is switched off and its commands aren't registered until it works properly. SoundCloud, the only free song search Lavalink has, changed its audio formats in 2026 and Lavalink can't play them yet ([lavaplayer#202](https://github.com/lavalink-devs/lavaplayer/pull/202)), so `/play` could only take pasted links.

Everything is kept for later: the commands are in [`src/music/commands/`](src/music/commands), the Lavalink connection in [`src/music/`](src/music), and Lavalink's settings in [`lavalink/application.yml`](lavalink/application.yml). To bring it back: move the two command files to `src/commands/music/`, set `ENABLE_MUSIC=true`, put `Lavalink.jar` (v4, needs Java 17+) in `lavalink/`, run `npm run lavalink` in its own terminal, and `npm run deploy`.

## Control panel
A website (on GitHub Pages) for managing the bot without Discord commands. Sign in with Discord to see every server where you have Manage Server:

- **Overview:** members, messages and active people today, joins this week, open tickets, recent log entries.
- **Analytics:** messages, active members, member count, joins and leaves, commands and songs over 7 days to a year; busiest channels; most-logged events.
- **Activity:** each member's messages, active days, voice time, channels, who they're in voice with, and games; voice channels; games and their top players.
- **Connections:** groups of members who mostly interact with each other, the strongest pairs and what they do together, and each member's closest connections.
- **Settings:** log channel, word filter, the trackers, and ticket staff role, queue channel and pings.
- **Moderation:** view and remove warnings; tickets by status.
- **Logs:** everything the bot logged in the last 90 days, searchable.
- **Bot status** (everyone): online or offline, uptime, latency, servers and features. **Bot owners** can also edit the word filter list here.

Setup takes about 15 minutes with free Cloudflare and GitHub accounts: see [MAINTAINING.md → Control panel](MAINTAINING.md#control-panel). The bot works the same without it.

## Keeping it online
The bot only runs while `npm start` is running. For 24/7 uptime, run it on an always-on machine or a host (a small VPS, Railway, fly.io, etc.), ideally with a process manager like [pm2](https://pm2.keymetrics.io): `npm i -g pm2 && pm2 start src/index.js --name daemonbot`.

## Data
Warnings, tickets, game, voice, activity and connection stats, and per-server settings are saved as JSON in `data/`. Back that folder up if you move hosts.

## Adding commands
Drop a file in any folder under `src/commands/` exporting `default { data, execute }` (see `src/commands/general/ping.js`), then `npm run deploy`.

## Housekeeping
Run `npm run sweep` after any change. It checks that imports, commands, buttons, settings, docs and word lists all fit together, and that no token or leftover file is lying around. See [MAINTAINING.md](MAINTAINING.md).
