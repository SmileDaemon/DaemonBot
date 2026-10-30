-- The control panel's database. The bot is the source of truth for settings;
-- this holds what it last reported, what the panel has asked it to do, and history.

-- Signed-in panel users. The token itself is never stored, only its SHA-256.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar TEXT,
  guild_ids TEXT NOT NULL,          -- JSON array: servers this user can manage (Manage Server or Administrator)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Discord sign-in in progress, to reject forged callbacks.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- The bot's last heartbeat: one row.
CREATE TABLE bot_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- What the bot last reported about each server it is in.
CREATE TABLE guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  member_count INTEGER,
  snapshot TEXT NOT NULL,           -- channels, roles, settings, tickets, warnings, games
  music TEXT,                       -- now playing and queue, refreshed every sync
  updated_at INTEGER NOT NULL
);

-- Changes made in the panel, waiting for (or applied by) the bot.
CREATE TABLE commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,                    -- NULL for bot-wide changes (the word list)
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending, sent, done, failed
  result TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  done_at INTEGER
);
CREATE INDEX commands_status ON commands (status, created_at);

-- Daily counters: messages per channel, joins, commands used, log events by kind...
CREATE TABLE stats (
  guild_id TEXT NOT NULL,
  day TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  metric TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  PRIMARY KEY (guild_id, day, metric, key)
);

-- A copy of everything the bot logs, searchable from the panel. Kept 90 days.
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  title TEXT NOT NULL,
  color INTEGER,
  user TEXT,                        -- JSON { id, tag, avatar }
  description TEXT,
  fields TEXT                       -- JSON [{ name, value }]
);
CREATE INDEX logs_guild_at ON logs (guild_id, at DESC);

-- The word filter's list as the bot last reported it: one row.
CREATE TABLE wordlist (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
