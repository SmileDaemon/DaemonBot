<img src="images/DaemonBot.png" alt="DaemonBot" width="160">

# DaemonBot

A general-purpose Discord bot for moderation, custom embeds, announcements, support tickets and server logging, with a web control panel. Built on [discord.js](https://discord.js.org) v14.

## What it does

- **Moderation:** `/ban`, `/unban`, `/kick`, `/timeout`, `/untimeout`, `/warn` and `/warnings` to view or clear them, `/purge` to bulk-delete messages, and `/channel` to lock, unlock or set slowmode. Moderators can't act on anyone with an equal or higher role.
- **Embeds and announcements:** `/embed` opens a form to write and post an embed, or edit one the bot already posted (also from a message's right-click menu: **Apps → Edit Embed**). `/announce` posts an announcement with an optional role ping and image.
- **First run:** when the bot joins a server it asks for a log channel, then links to the control panel, where someone with Manage Server reads the Terms of Service and Privacy Policy (each unlocks Agree and Decline only once scrolled to the end) and accepts or declines. Until they accept, the bot's commands and the server's control panel are locked; declining makes it leave.
- **Setup:** `/setup full` sets up everything at its defaults: a staff-only log channel, tickets, temporary voice channels and server stats. The control panel's **Setup** tab does the same with every choice open (ticket types, which stats, levels, the word filter). Either one runs once per server, then locks until a **Full Reset** in the panel's Danger Zone. Or set each up on its own with `/setup tickets`, `/setup serverstats`, `/setup logs` and `/setup tempvoice` (and `/setup remove-tempvoice`). For members with Manage Server. `/config` turns the word filter on or off and shows the current settings.
- **Raid protection:** each part is switched on in the control panel's Security tab. Always watching: a join alarm, flood guard, mass mention guard, link and invite filter, anti-nuke (takes the roles away from anyone deleting or banning too fast) and permission watch, plus an optional join gate (#verify). When the join alarm or anti-nuke spots a raid, raid mode switches on whichever reactions are enabled: lockdown, new account filter, raid cleanup, an instant backup and a report when it's over. Backups of channels, roles and permissions are also taken daily; the panel shows them and restores anything deleted. `/security` handles lockdown, backups, restore and status from Discord. `/setup full` turns on the join alarm, mention guard, link filter, anti-nuke and backups. Move the bot's role to the top of the role list so it can act on anyone.
- **Update notes:** when the bot gets new features, a note goes to each server's log channel. Several on the same day (Eastern time) share one message, which is edited as more arrive. Servers can turn them off in the control panel's Settings.
- **Switching from other bots:** `/detect` lists the other bots in a server, says which of their features this bot can take over (and how to set each up) and what it can't, and gives step-by-step instructions for phasing them out. Recognises MEE6, Dyno, Carl-bot, YAGPDB, ProBot, Zeppelin, Ticket Tool, Tickets, Arcane, Tatsu, Amari, Lurkr, Statbot, ServerStats, VoiceMaster, TempVoice and Wick.
- **Support tickets:** `/setup tickets` makes a "Support Tickets" section with a "Create A Ticket" channel, and asks for the ticket types ("Report A Problem" by default) that fill its dropdown. Members pick a type there, or use `/ticket open`. Each ticket is a private channel that only its creator and staff can see. When it's closed it moves to an archive category, where the creator can still read it but not post, and a transcript is saved. A server's transcripts are all deleted together: the first one starts a 30-day countdown, and when it runs out they all go. `/ticket export` (or **Send to me** in the control panel) downloads them, and the server is reminded 7 days before, if there are any to lose.
- **Logging:** moderation actions, ticket activity and settings changes, plus optional server events (joins and leaves, edited and deleted messages, role, channel and invite changes), posted to a log channel chosen with `/setup logs`.
- **Stat channels:** public counts (all members, members without bots, bots, members with a role, members online, members in voice, boosts, channels, roles) shown as locked voice channels everyone can see but not join, in a "📊 Server Stats 📈" category. `/setup serverstats` adds members and bots, and asks which other stats and roles to show; the control panel's Server Stats tab can change them too; they keep themselves up to date, within Discord's limit of 2 renames per channel every 10 minutes.
- **Temporary voice channels:** `/setup tempvoice` (or the control panel) makes a "Join To Create" channel. Joining it gives the member their own voice channel, named after them, with buttons in its chat to rename it, set a user limit, lock it, make it private so only invited members can see and join, invite or remove people, and hand it to someone else. It disappears when everyone leaves.
- **Levels:** members earn XP for chatting and for time in voice with others, and level up. `/level` shows someone's level and rank, `/leaderboard` the top members. Admins use `/levels` to turn levels on or off, set how much XP messages and voice give, change the level-up message and where it's posted, give reward roles at chosen levels, and set a member's XP.
- **Word filter:** deletes messages containing blocked words, catching common disguises like l33t-speak and stretched letters while leaving innocent words alone.
- **Message previews:** pasting a link to a message in the same server can show a preview of it.
- **Control panel:** a website where server admins sign in with Discord to run the full setup, change settings (tickets and their types, levels, server stats, temporary voice), review warnings, tickets and logs, and check the bot's status.
- **Utilities:** `/help` lists the commands and `/ping` checks the bot's latency.

Server admins can change who may use each command in **Server Settings → Integrations → DaemonBot**.

## Running your own

Setup, hosting and maintenance are in [MAINTAINING.md](MAINTAINING.md).

## Terms and privacy

[Terms of Service](TERMS.md) · [Privacy Policy](PRIVACY.md)
