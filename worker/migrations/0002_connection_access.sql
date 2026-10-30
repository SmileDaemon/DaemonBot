-- Servers whose admins may see their connection data (groups, pairs, closest connections). Off until the
-- bot's owner allows it from the Owner Panel; owners always see everything. Kept here rather than with the
-- bot, since the worker is what decides who sees what.
CREATE TABLE connection_access (
  guild_id TEXT PRIMARY KEY,
  granted_by TEXT NOT NULL,         -- the owner's Discord user ID
  granted_at INTEGER NOT NULL
);
