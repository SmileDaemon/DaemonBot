import { setTimeout as sleep } from 'node:timers/promises';
import { OverwriteType, PermissionsBitField } from 'discord.js';

export const truncate = (text, max = 1024) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Registers an event handler whose errors (sync or async) are logged instead of crashing the bot. */
export const listen = (client) => (event, handler) =>
  client.on(event, (...args) => Promise.resolve().then(() => handler(...args)).catch(console.error));

/**
 * Finds the recent audit log entry for an action, or null (e.g. without View Audit Log).
 * `match` is a target ID or a function. Discord writes audit entries a moment after the event fires, so this waits first.
 */
export async function findAuditEntry(guild, type, match, { wait = 1500, within = 15_000 } = {}) {
  if (wait) await sleep(wait);
  const logs = await guild.fetchAuditLogs({ ...(type != null && { type }), limit: 10 }).catch(() => null);
  const test = typeof match === 'function' ? match : (e) => e.targetId === match;
  return logs?.entries.find((e) => Date.now() - e.createdTimestamp < within && test(e)) ?? null;
}

/** True when the bot itself did it, i.e. a command already logged it with full details. */
export const byBot = (entry, client) => Boolean(entry) && entry.executorId === client.user.id;

/** "ManageMessages" → "Manage Messages" */
const permName = (perm) => perm.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/(Guild)/, 'Server');

/** Lists permissions gained and lost between two bitfields, or [] when unchanged. */
export function permissionChanges(before, after) {
  const added = new PermissionsBitField(before).missing(after, false);
  const removed = new PermissionsBitField(after).missing(before, false);
  return [...added.map((p) => `+ ${permName(p)}`), ...removed.map((p) => `- ${permName(p)}`)];
}

const overwriteState = (ow, perm) => (ow?.allow.has(perm) ? '✅' : ow?.deny.has(perm) ? '❌' : '➖');

/** Describes changes to a channel's permission overwrites, one line per role/member and permission. */
export function overwriteChanges(before, after, guild) {
  const lines = [];
  const ids = new Set([...before.permissionOverwrites.cache.keys(), ...after.permissionOverwrites.cache.keys()]);
  for (const id of ids) {
    const b = before.permissionOverwrites.cache.get(id);
    const a = after.permissionOverwrites.cache.get(id);
    const type = (a ?? b).type;
    const who = id === guild.id ? '@everyone' : type === OverwriteType.Role ? `<@&${id}>` : `<@${id}>`;
    if (!b) lines.push(`${who}: override added`);
    else if (!a) lines.push(`${who}: override removed`);
    const perms = new PermissionsBitField([b?.allow, b?.deny, a?.allow, a?.deny].filter(Boolean)).toArray();
    const changed = perms
      .filter((p) => overwriteState(b, p) !== overwriteState(a, p))
      .map((p) => `${permName(p)} ${overwriteState(b, p)}→${overwriteState(a, p)}`);
    if (changed.length) lines.push(`${who}: ${changed.join(', ')}`);
  }
  return lines;
}

const show = (value) =>
  value === null || value === undefined || value === '' ? '*none*' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);

/** Turns [label, before, after] rows into embed fields, skipping unchanged ones. */
export function diffFields(rows) {
  return rows
    .filter(([, before, after]) => show(before) !== show(after))
    .map(([name, before, after]) => ({ name, value: truncate(`${show(before)} → ${show(after)}`) }));
}

export const byField = (entry) =>
  entry ? [{ name: 'By', value: `${entry.executor ?? `<@${entry.executorId}>`}`, inline: true }] : [];
