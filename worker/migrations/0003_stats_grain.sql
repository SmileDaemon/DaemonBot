-- Older statistics are rolled up to save room: daily rows for the last 90 days, then one row per week
-- (split at month ends, so weeks never cross months) up to 400 days, then one row per month, kept while
-- the bot is in the server. `day` is the first day each row covers; `grain` says how long it is.
CREATE TABLE stats_new (
  guild_id TEXT NOT NULL,
  grain TEXT NOT NULL DEFAULT 'd',  -- d: one day, w: a week (or the part of it in one month), m: a calendar month
  day TEXT NOT NULL,                -- YYYY-MM-DD, UTC: the first day covered
  metric TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  PRIMARY KEY (guild_id, grain, day, metric, key)
);
INSERT INTO stats_new (guild_id, grain, day, metric, key, value) SELECT guild_id, 'd', day, metric, key, value FROM stats;
DROP TABLE stats;
ALTER TABLE stats_new RENAME TO stats;
CREATE INDEX stats_guild_day ON stats (guild_id, day);
