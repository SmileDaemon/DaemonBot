# DaemonBot

A general-purpose Discord bot for moderation, custom embeds, announcements, support tickets and server logging, with a web control panel. Built on [discord.js](https://discord.js.org) v14.

## What it does

- **Moderation:** `/ban`, `/unban`, `/kick`, `/timeout`, `/untimeout`, `/warn` and `/warnings` to view or clear them, `/purge` to bulk-delete messages, and `/channel` to lock, unlock or set slowmode. Moderators can't act on anyone with an equal or higher role.
- **Embeds and announcements:** `/embed` opens a form to write and post an embed, or edit one the bot already posted (also from a message's right-click menu: **Apps → Edit Embed**). `/announce` posts an announcement with an optional role ping and image.
- **Support tickets:** `/ticket setup` posts an "Open a ticket" button. Each ticket is a private thread that staff claim from a queue and close when it's done.
- **Logging:** moderation actions, ticket activity and settings changes, plus optional server events (joins and leaves, edited and deleted messages, role, channel and invite changes), posted to a log channel chosen with `/config`.
- **Word filter:** deletes messages containing blocked words, catching common disguises like l33t-speak and stretched letters while leaving innocent words alone.
- **Message previews:** pasting a link to a message in the same server can show a preview of it.
- **Control panel:** a website where server admins sign in with Discord to change settings, review warnings, tickets and logs, and check the bot's status.
- **Utilities:** `/help` lists the commands and `/ping` checks the bot's latency.

Server admins can change who may use each command in **Server Settings → Integrations → DaemonBot**.

## Running your own

Setup, hosting and maintenance are in [MAINTAINING.md](MAINTAINING.md).

## Terms and privacy

[Terms of Service](TERMS.md) · [Privacy Policy](PRIVACY.md)
