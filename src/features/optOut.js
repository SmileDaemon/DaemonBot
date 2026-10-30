import { activityStats, connectionStats, optOuts, voiceStats } from '../utils/store.js';
import { forgetActivity } from './activityTracker.js';
import { forgetConnections } from './connectionTracker.js';
import { forgetGames } from './gameTracker.js';
import { forgetLevels } from './levels.js';
import { forgetVoice } from './voiceTracker.js';

// Members opt out by emailing the operator, once for each server (PRIVACY.md, section 7); the operator
// applies it from the control panel. There's deliberately no Discord command for it.

/**
 * Stops tracking someone in this server and deletes the statistics kept about them there.
 */
export function optOut(guild, userId) {
  const list = optOuts.get(guild.id, {});
  list[userId] ??= { at: Date.now() };
  optOuts.set(guild.id, list);

  // Time and counts not saved yet
  forgetVoice(guild.id, userId);
  forgetActivity(guild.id, userId);
  forgetConnections(guild, userId);
  forgetLevels(guild.id, userId);
  forgetGames(guild.id, userId);

  // Their own records in this server
  const activity = activityStats.get(guild.id, {});
  if (userId in activity) {
    delete activity[userId];
    activityStats.set(guild.id, activity);
  }
  const voice = voiceStats.get(userId, {});
  const channels = Object.entries(voice.channels ?? {});
  if (channels.some(([, rec]) => rec.guildId === guild.id)) {
    voice.channels = Object.fromEntries(channels.filter(([, rec]) => rec.guildId !== guild.id));
    if (Object.keys(voice.channels).length) voiceStats.set(userId, voice);
    else voiceStats.delete(userId);
  }

  // Other people's records in this server that mention them
  for (const otherId of voiceStats.keys()) {
    const data = voiceStats.get(otherId, {});
    let changed = false;
    for (const rec of Object.values(data.channels ?? {})) {
      if (rec.guildId === guild.id && rec.with && userId in rec.with) {
        delete rec.with[userId];
        changed = true;
      }
    }
    if (changed) voiceStats.set(otherId, data);
  }
  const pairs = connectionStats.get(guild.id, {});
  const keys = Object.keys(pairs).filter((key) => key.split('-').includes(userId));
  if (keys.length) {
    for (const key of keys) delete pairs[key];
    connectionStats.set(guild.id, pairs);
  }
}

/** Lets someone be tracked in this server again, from now on. Deleted statistics don't come back. */
export function optIn(guildId, userId) {
  const list = optOuts.get(guildId, {});
  delete list[userId];
  if (Object.keys(list).length) optOuts.set(guildId, list);
  else optOuts.delete(guildId);
}
