import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  GuildVerificationLevel,
  OverwriteType,
  PermissionFlagsBits,
  time,
} from 'discord.js';
import { COLORS, logEvent } from '../utils/logging.js';
import { refuse } from '../utils/refused.js';
import { guildConfig, securityState } from '../utils/store.js';
import { BACKUP_EVERY_MS, latestBackup, takeBackup } from './backups.js';

const P = PermissionFlagsBits;

/**
 * Every protection a server can switch on in the control panel. `reaction` ones only act while a raid is
 * happening; the rest watch all the time. A raid starts when the join alarm sees a burst of joins, or when
 * anti-nuke catches someone deleting or banning too much.
 */
export const MODULES = {
  joinAlarm: { label: 'Join alarm', about: 'Starts raid mode when too many members join at once.' },
  lockdown: { label: 'Lockdown', reaction: true, about: 'During a raid: stops @everyone posting, raises the verification level and pauses invites. Undone when the raid ends.' },
  accountAge: { label: 'New account filter', reaction: true, about: 'During a raid: kicks accounts younger than the set age as they join.' },
  cleanup: { label: 'Raid cleanup', reaction: true, about: 'When a raid starts: offers staff a button to kick or ban everyone who joined in it, or does it straight away.' },
  joinGate: { label: 'Join gate', about: 'New members click a Verify button to get a role before they can see the server. The bot can set it all up, or use a role and channel you choose.' },
  flood: { label: 'Flood guard', about: 'Times out members who send messages too fast or paste the same message in several channels.' },
  mentions: { label: 'Mass mention guard', about: 'Deletes messages that mention too many members or roles, and times out the sender.' },
  links: { label: 'Link and invite filter', about: "Deletes invites to other servers and known scam links. Needs the bot's Message Content intent." },
  antiNuke: { label: 'Anti-nuke', about: 'Takes the roles away from anyone (or any bot) deleting channels or roles, banning or kicking too fast, and starts raid mode.' },
  permissionWatch: { label: 'Permission watch', about: 'Alerts when a bot is added, someone is given Administrator, or a webhook is made.' },
  backups: { label: 'Backups', reaction: true, about: 'Backs up channels, roles and permissions daily and as soon as a raid starts, so deleted ones can be restored.' },
  reports: { label: 'Raid reports', reaction: true, about: 'Posts a summary in the log channel when a raid ends.' },
};
/** What /setup full and the panel's full setup switch on. */
const FULL_SETUP_MODULES = ['joinAlarm', 'mentions', 'links', 'antiNuke', 'backups'];

const DEFAULT_LIMITS = {
  joinCount: 10, // joins...
  joinSeconds: 30, // ...within this many seconds start a raid
  raidMinutes: 15, // how long raid mode lasts after the last burst
  accountAgeDays: 7,
  cleanup: 'ask', // 'ask' | 'kick' | 'ban'
  floodCount: 6, // messages...
  floodSeconds: 5, // ...within this many seconds
  duplicateChannels: 3, // the same message in this many channels within 30 seconds
  mentionLimit: 5,
  nukeCount: 3, // destructive actions by one person...
  nukeSeconds: 60, // ...within this many seconds
};
const LIMIT_RANGES = {
  joinCount: [3, 100], joinSeconds: [5, 600], raidMinutes: [1, 240], accountAgeDays: [1, 365], floodCount: [3, 50], floodSeconds: [2, 60],
  duplicateChannels: [2, 20], mentionLimit: [2, 50], nukeCount: [2, 50], nukeSeconds: [10, 600],
};
const TIMEOUT_MS = 10 * 60_000;
const LOCKED_PERMISSIONS = [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads, P.AddReactions];

// ---------------------------------------------------------------------------
//   Settings and state
// ---------------------------------------------------------------------------

/**
 * { modules: { [key]: bool }, limits, trusted: { roles, users }, gateOptions, gate }
 *   gateOptions: how the join gate should be set up: { mode: 'auto' } (the bot makes a Verified role and #verify,
 *                and hides the server from @everyone) or { mode: 'manual', roleId, channelId } (yours, left as they are)
 *   gate:        the gate as it is while on: { mode, roleId, channelId, messageId }
 */
function securitySettings(guildId) {
  const saved = guildConfig.get(guildId, {}).security ?? {};
  return {
    modules: Object.fromEntries(Object.keys(MODULES).map((k) => [k, Boolean(saved.modules?.[k])])),
    limits: { ...DEFAULT_LIMITS, ...saved.limits },
    trusted: { roles: saved.trusted?.roles ?? [], users: saved.trusted?.users ?? [] },
    gateOptions: saved.gateOptions ?? { mode: 'auto' },
    gate: saved.gate ?? null,
  };
}
const on = (guildId, key) => process.env.ENABLE_SECURITY === 'true' && securitySettings(guildId).modules[key];

function saveSettings(guildId, settings) {
  guildConfig.set(guildId, { ...guildConfig.get(guildId, {}), security: settings });
}

/** { lockdown: { since, auto, prev } | null, raid: { id, kind, startedAt, until, joined, actions } | null, incidents } */
const stateOf = (guildId) => ({ lockdown: null, raid: null, incidents: [], ...securityState.get(guildId, {}) });
const saveState = (guildId, state) => securityState.set(guildId, state);

/** Whether any role sits above the bot's, which stops it acting on members with those roles. */
export function botRoleIsTop(guild) {
  const mine = guild.members.me.roles.highest;
  return !guild.roles.cache.some((r) => r.position > mine.position);
}
export const ROLE_HINT =
  'Move my role to the very top in Server Settings → Roles (drag it above every other role). I can only remove roles from, kick, ban or time out members whose roles are below mine, so raid protection depends on it.';

/** The server's other bots, trusted the first time protection is set up so anti-nuke doesn't catch them at their work. */
async function otherBots(guild) {
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  return [...members.filter((m) => m.user.bot && m.id !== guild.members.me.id).keys()];
}

/** Checks the role and channel picked for a join gate the server manages itself. */
function checkGateOptions(guild, options) {
  if (options.mode === 'auto') return { mode: 'auto' };
  if (options.mode !== 'manual') refuse('The join gate is either set up for you or uses your own role and channel.');
  const role = guild.roles.cache.get(options.roleId);
  const channel = guild.channels.cache.get(options.channelId);
  if (!role || role.id === guild.id || role.managed) refuse('Pick a role for verified members.');
  if (role.position >= guild.members.me.roles.highest.position) refuse(`I can't give out @${role.name}: it's above my role. ${ROLE_HINT}`);
  if (channel?.type !== ChannelType.GuildText) refuse('Pick a text channel for the Verify button.');
  if (!channel.permissionsFor(guild.members.me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) refuse(`I need View Channel, Send Messages and Embed Links in #${channel.name}.`);
  return { mode: 'manual', roleId: role.id, channelId: channel.id };
}

/** Checks and applies changes from the control panel: modules, limits, trusted roles and members, and the join gate's setup. */
export async function saveSecuritySettings(guild, changes) {
  const firstTime = !guildConfig.get(guild.id, {}).security;
  const current = securitySettings(guild.id);
  const next = { ...current, modules: { ...current.modules }, limits: { ...current.limits }, trusted: { ...current.trusted } };
  for (const [key, value] of Object.entries(changes.modules ?? {})) {
    if (!MODULES[key]) refuse(`There's no "${key}" protection.`);
    next.modules[key] = Boolean(value);
  }
  for (const [key, value] of Object.entries(changes.limits ?? {})) {
    if (key === 'cleanup') {
      if (!['ask', 'kick', 'ban'].includes(value)) refuse('Raid cleanup can ask, kick or ban.');
      next.limits.cleanup = value;
      continue;
    }
    const range = LIMIT_RANGES[key];
    const n = Number(value);
    if (!range) refuse(`There's no "${key}" setting.`);
    if (!Number.isInteger(n) || n < range[0] || n > range[1]) refuse(`${key} has to be a whole number from ${range[0]} to ${range[1]}.`);
    next.limits[key] = n;
  }
  if (changes.trusted) {
    const roles = (changes.trusted.roles ?? []).filter((id) => guild.roles.cache.has(id));
    const users = (changes.trusted.users ?? []).map((id) => String(id).trim()).filter((id) => /^\d{17,20}$/.test(id));
    next.trusted = { roles: [...new Set(roles)], users: [...new Set(users)].slice(0, 50) };
  }
  if (firstTime) next.trusted.users = [...new Set([...next.trusted.users, ...(await otherBots(guild))])].slice(0, 50);
  if (changes.gateOptions) next.gateOptions = checkGateOptions(guild, changes.gateOptions);
  // Changing how the gate is set up while it's on takes the old one down and puts the new one up.
  const gateChanged = JSON.stringify(next.gateOptions) !== JSON.stringify(current.gateOptions);
  if (current.modules.joinGate && current.gate && (!next.modules.joinGate || gateChanged)) {
    await closeGate(guild, current.gate);
    next.gate = null;
  }
  if (next.modules.joinGate && (!current.modules.joinGate || gateChanged || !current.gate)) next.gate = await openGate(guild, next.gateOptions);
  saveSettings(guild.id, next);
  if (next.modules.backups && !latestBackup(guild.id)) takeBackup(guild, 'scheduled');
  return next;
}

/** For full setup: the five protections everyone should have, and a first backup. The server's other bots become trusted. */
export async function enableDefaultSecurity(guild) {
  const before = securitySettings(guild.id).trusted.users.length;
  const settings = await saveSecuritySettings(guild, { modules: Object.fromEntries(FULL_SETUP_MODULES.map((k) => [k, true])) });
  return { settings, roleTop: botRoleIsTop(guild), botsTrusted: settings.trusted.users.length - before };
}

/** For Full Reset: every protection off and any lockdown lifted. Backups are kept. */
export async function resetSecurity(guild) {
  if (stateOf(guild.id).lockdown) await endLockdown(guild, null);
  await saveSecuritySettings(guild, { modules: Object.fromEntries(Object.keys(MODULES).map((k) => [k, false])) });
}

// ---------------------------------------------------------------------------
//   Alerts
// ---------------------------------------------------------------------------

const logChannel = (guild) => guild.channels.cache.get(guildConfig.get(guild.id, {}).logChannelId) ?? null;

function alert(guild, title, description, fields = []) {
  return logEvent(guild, { title: `🛡️ ${title}`, color: COLORS.delete, description, fields });
}

/** Whether the checks leave this member alone: the owner, the bot, and the server's trusted roles and members. */
function trusted(member, settings) {
  if (!member) return false;
  if (member.id === member.guild.ownerId || member.id === member.guild.members.me.id) return true;
  return settings.trusted.users.includes(member.id) || member.roles.cache.some((r) => settings.trusted.roles.includes(r.id));
}
/** Message checks also leave staff alone. */
const staff = (member, settings) => trusted(member, settings) || member.permissions.has(P.ManageMessages);

// ---------------------------------------------------------------------------
//   Raids: what starts one, what happens during it, and the report after
// ---------------------------------------------------------------------------

const recentJoins = new Map(); // guild ID -> [{ id, at }]

async function startRaid(guild, kind, detail) {
  const settings = securitySettings(guild.id);
  const state = stateOf(guild.id);
  const now = Date.now();
  const until = now + settings.limits.raidMinutes * 60_000;
  if (state.raid) {
    // Already in raid mode: another burst keeps it going.
    state.raid.until = until;
    saveState(guild.id, state);
    return state.raid;
  }
  const raid = { id: String(now), kind, startedAt: now, until, joined: detail.joined ?? [], actions: [], executorId: detail.executorId ?? null };
  state.raid = raid;
  saveState(guild.id, state);

  await alert(
    guild,
    kind === 'joins' ? 'Raid detected' : 'Nuke attempt stopped',
    kind === 'joins'
      ? `**${raid.joined.length}** members joined within ${settings.limits.joinSeconds} seconds. Raid mode is on until ${time(new Date(until), 'R')}.`
      : `<@${detail.executorId}> did ${detail.count} destructive actions within ${settings.limits.nukeSeconds} seconds. Raid mode is on until ${time(new Date(until), 'R')}.`,
    botRoleIsTop(guild) ? [] : [{ name: '⚠️ My role is not at the top', value: ROLE_HINT }],
  );

  if (on(guild.id, 'backups')) {
    takeBackup(guild, kind === 'joins' ? 'raid' : 'nuke');
    note(guild, 'Backed up channels and roles');
  }
  if (on(guild.id, 'lockdown')) await startLockdown(guild, { auto: true }).catch((err) => note(guild, `Lockdown failed: ${err.message}`));
  if (kind === 'joins') {
    if (on(guild.id, 'accountAge')) for (const id of raid.joined) await filterNewAccount(guild, id);
    if (on(guild.id, 'cleanup')) await offerCleanup(guild, raid);
  }
  return raid;
}

function note(guild, action) {
  const state = stateOf(guild.id);
  if (!state.raid) return;
  state.raid.actions.push({ at: Date.now(), action });
  saveState(guild.id, state);
}

async function endRaid(guild) {
  const state = stateOf(guild.id);
  const raid = state.raid;
  if (!raid) return;
  if (state.lockdown?.auto) await endLockdown(guild, null).catch(() => {});
  const ended = { ...stateOf(guild.id).raid, endedAt: Date.now() };
  const next = stateOf(guild.id);
  next.raid = null;
  next.incidents = [{ ...ended, joined: ended.joined.length, joinedIds: ended.joined.slice(0, 200) }, ...next.incidents].slice(0, 20);
  saveState(guild.id, next);
  if (on(guild.id, 'reports')) {
    const minutes = Math.max(1, Math.round((ended.endedAt - ended.startedAt) / 60_000));
    await logEvent(guild, {
      title: `🛡️ Raid report: ${ended.kind === 'joins' ? 'join raid' : 'nuke attempt'}`,
      color: COLORS.info,
      description: `Started ${time(new Date(ended.startedAt), 'f')} and lasted about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      fields: [
        { name: 'Members who joined during it', value: String(ended.joined.length), inline: true },
        ...(ended.executorId ? [{ name: 'Caught', value: `<@${ended.executorId}>`, inline: true }] : []),
        { name: 'What I did', value: ended.actions.length ? ended.actions.map((a) => `• ${a.action}`).join('\n').slice(0, 1024) : 'Nothing beyond the alert.' },
      ],
    });
  }
}

async function onJoin(member) {
  const { guild } = member;
  if (member.user.bot) return;
  const settings = securitySettings(guild.id);
  const state = stateOf(guild.id);
  if (state.raid) {
    state.raid.joined.push(member.id);
    saveState(guild.id, state);
    if (on(guild.id, 'accountAge')) await filterNewAccount(guild, member.id);
  }
  if (!on(guild.id, 'joinAlarm')) return;
  const now = Date.now();
  const window = settings.limits.joinSeconds * 1000;
  const joins = [...(recentJoins.get(guild.id) ?? []).filter((j) => now - j.at < window), { id: member.id, at: now }];
  recentJoins.set(guild.id, joins);
  if (joins.length >= settings.limits.joinCount) {
    recentJoins.set(guild.id, []);
    await startRaid(guild, 'joins', { joined: joins.map((j) => j.id) });
  }
}

async function filterNewAccount(guild, userId) {
  const { limits } = securitySettings(guild.id);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || trusted(member, securitySettings(guild.id))) return;
  const days = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  if (days >= limits.accountAgeDays || !member.kickable) return;
  await member.kick(`Raid: account under ${limits.accountAgeDays} days old`).catch(() => {});
  note(guild, `Kicked ${member.user.tag}, an account ${Math.floor(days)} day(s) old`);
}

async function offerCleanup(guild, raid) {
  const { limits } = securitySettings(guild.id);
  if (limits.cleanup !== 'ask') {
    const done = await cleanUp(guild, raid.id, limits.cleanup);
    return note(guild, `${limits.cleanup === 'ban' ? 'Banned' : 'Kicked'} ${done} raid account(s)`);
  }
  const channel = logChannel(guild);
  if (!channel) return note(guild, 'Raid cleanup skipped: there is no log channel to ask in');
  await channel
    .send({
      embeds: [new EmbedBuilder().setTitle('🛡️ Clean up this raid?').setColor(COLORS.delete).setDescription(`Kick or ban the **${raid.joined.length}** accounts that joined during the raid, and any more that join until it ends. Members who have left are skipped.`)],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`security:cleanup:${raid.id}:kick`).setLabel('Kick them').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`security:cleanup:${raid.id}:ban`).setLabel('Ban them').setStyle(ButtonStyle.Danger),
        ),
      ],
    })
    .catch(() => {});
}

/** Kicks or bans everyone who joined during a raid (the current one, or one in the history). Returns how many. */
export async function cleanUp(guild, raidId, how) {
  const state = stateOf(guild.id);
  const raid = state.raid?.id === raidId ? state.raid : state.incidents.find((i) => i.id === raidId);
  if (!raid) refuse("That raid isn't in my records anymore.");
  const ids = Array.isArray(raid.joined) ? raid.joined : raid.joinedIds ?? [];
  let done = 0;
  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member || trusted(member, securitySettings(guild.id))) continue;
    const reason = `Raid cleanup (${how})`;
    const ok = how === 'ban' ? member.bannable && (await member.ban({ reason }).then(() => true, () => false)) : member.kickable && (await member.kick(reason).then(() => true, () => false));
    if (ok) done += 1;
  }
  return done;
}

// ---------------------------------------------------------------------------
//   Lockdown
// ---------------------------------------------------------------------------

/** Stops @everyone posting, raises the verification level and pauses invites, remembering how they were. */
export async function startLockdown(guild, { auto = false, by = null } = {}) {
  const state = stateOf(guild.id);
  if (state.lockdown) return false;
  const everyone = guild.roles.everyone;
  const prev = {
    verificationLevel: guild.verificationLevel,
    everyone: everyone.permissions.bitfield.toString(),
    invitesDisabled: guild.features.includes('INVITES_DISABLED'),
  };
  state.lockdown = { since: Date.now(), auto, prev };
  saveState(guild.id, state);
  const reason = auto ? 'Raid lockdown' : `Lockdown started by ${by ?? 'staff'}`;
  const failed = [];
  await everyone.setPermissions(everyone.permissions.remove(LOCKED_PERMISSIONS), reason).catch(() => failed.push('stop @everyone posting'));
  if (guild.verificationLevel < GuildVerificationLevel.High) await guild.setVerificationLevel(GuildVerificationLevel.High, reason).catch(() => failed.push('raise the verification level'));
  if (!prev.invitesDisabled) await guild.disableInvites(true).catch(() => failed.push('pause invites'));
  note(guild, `Locked the server down${failed.length ? ` (couldn't ${failed.join(', ')})` : ''}`);
  await alert(guild, 'Lockdown on', `${auto ? 'Started by raid mode; it ends with the raid.' : `Started by ${by ?? 'staff'}.`} @everyone can't post, verification is High and invites are paused.${failed.length ? `\n⚠️ I couldn't ${failed.join(', ')}.` : ''}`);
  return true;
}

/** Puts back what a lockdown changed. */
export async function endLockdown(guild, by) {
  const state = stateOf(guild.id);
  const lockdown = state.lockdown;
  if (!lockdown) return false;
  const reason = by ? `Lockdown ended by ${by}` : 'Raid over';
  await guild.roles.everyone.setPermissions(BigInt(lockdown.prev.everyone), reason).catch(() => {});
  await guild.setVerificationLevel(lockdown.prev.verificationLevel, reason).catch(() => {});
  if (!lockdown.prev.invitesDisabled) await guild.disableInvites(false).catch(() => {});
  state.lockdown = null;
  saveState(guild.id, state);
  await alert(guild, 'Lockdown over', `${by ? `Ended by ${by}.` : 'The raid is over.'} Posting, verification and invites are back as they were.`);
  return true;
}

// ---------------------------------------------------------------------------
//   Join gate
// ---------------------------------------------------------------------------

const verifyMessage = (guild) => ({
  embeds: [new EmbedBuilder().setTitle(`Welcome to ${guild.name}`).setColor(COLORS.join).setDescription('Click the button to confirm you are a person and see the rest of the server.')],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('security:verify').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success))],
});

/**
 * Puts the join gate up. With the server's own role and channel, only the Verify button is posted: who sees
 * what stays theirs to set. Set up for them, it makes the role and #verify and hides the server from @everyone.
 */
async function openGate(guild, options = { mode: 'auto' }) {
  if (options.mode === 'manual') {
    const message = await guild.channels.cache.get(options.channelId).send(verifyMessage(guild));
    return { mode: 'manual', roleId: options.roleId, channelId: options.channelId, messageId: message.id };
  }
  const me = guild.members.me;
  if (!me.permissions.has([P.ManageRoles, P.ManageChannels])) refuse('For the join gate I need Manage Roles and Manage Channels.');
  const reason = 'Join gate turned on';
  const role = await guild.roles.create({ name: 'Verified', permissions: [P.ViewChannel], reason });
  const channel = await guild.channels.create({
    name: 'verify',
    type: ChannelType.GuildText,
    position: 0,
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions] },
      { id: role.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
    ],
    reason,
  });
  const message = await channel.send(verifyMessage(guild));
  // Everyone already here keeps seeing the server, then @everyone stops seeing it by default.
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  (async () => {
    for (const member of members.values()) await member.roles.add(role, reason).catch(() => {});
  })();
  const everyone = guild.roles.everyone;
  await everyone.setPermissions(everyone.permissions.remove(P.ViewChannel), reason).catch(() => {});
  return { mode: 'auto', roleId: role.id, channelId: channel.id, messageId: message.id };
}

/** Takes the gate down: just the Verify button if the role and channel are the server's, everything if the bot made them. */
async function closeGate(guild, gate) {
  const reason = 'Join gate turned off';
  if (gate?.mode === 'manual') {
    await guild.channels.cache.get(gate.channelId)?.messages.delete(gate.messageId).catch(() => {});
    return;
  }
  const everyone = guild.roles.everyone;
  await everyone.setPermissions(everyone.permissions.add(P.ViewChannel), reason).catch(() => {});
  await guild.channels.cache.get(gate?.channelId)?.delete(reason).catch(() => {});
  await guild.roles.cache.get(gate?.roleId)?.delete(reason).catch(() => {});
}

// ---------------------------------------------------------------------------
//   Messages: floods, mass mentions, invites and scam links
// ---------------------------------------------------------------------------

const recentMessages = new Map(); // `${guildId}:${userId}` -> [{ at, channelId, content, message }]
const INVITE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([\w-]+)/gi;
// Lookalikes of Discord and Steam, and the usual "free Nitro" bait.
const SCAM = [
  /\b(?:d[il1|]sc[o0]rd|dlscord|disc0rd|discorcl|discordnitro|discord-?gift|nitro-?gift)[\w-]*\.(?!com\b|gg\b|media\b|new\b|dev\b)[a-z]{2,}/i,
  /\b(?:steamc[o0]mmun[il1]ty|steamcommunlty|steancommunity|stearncommunity|steam-?gift)[\w-]*\.[a-z]{2,}/i,
  /free\s+(?:discord\s+)?nitro.*https?:\/\//i,
];
const invitesCache = new Map(); // guild ID -> { codes: Set, at }

async function ownInvites(guild) {
  const cached = invitesCache.get(guild.id);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.codes;
  const codes = new Set((await guild.invites.fetch().catch(() => new Map())).keys());
  if (guild.vanityURLCode) codes.add(guild.vanityURLCode);
  invitesCache.set(guild.id, { codes, at: Date.now() });
  return codes;
}

async function punish(message, why, { timeout = true } = {}) {
  await message.delete().catch(() => {});
  if (timeout && message.member?.moderatable) await message.member.timeout(TIMEOUT_MS, why).catch(() => {});
  const notice = await message.channel.send({ content: `${message.author}, ${why.toLowerCase()}.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 8_000).unref?.();
  await logEvent(message.guild, {
    title: `🛡️ ${why}`,
    color: COLORS.filter,
    user: message.author,
    fields: [
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Action', value: timeout ? 'Deleted, timed out 10 minutes' : 'Deleted', inline: true },
      ...(message.content ? [{ name: 'Message', value: message.content.slice(0, 1000) }] : []),
    ],
  });
}

async function onMessage(message) {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const { guild } = message;
  if (process.env.ENABLE_SECURITY !== 'true') return;
  const settings = securitySettings(guild.id);
  const { modules, limits } = settings;
  if (!modules.flood && !modules.mentions && !modules.links) return;
  if (staff(message.member, settings)) return;

  if (modules.mentions) {
    const count = new Set(message.mentions.users.keys()).size + message.mentions.roles.size;
    if (count >= limits.mentionLimit) return punish(message, `Mentioning ${count} members or roles at once isn't allowed`);
  }
  if (modules.links && message.content) {
    if (SCAM.some((re) => re.test(message.content))) return punish(message, 'That looks like a scam link');
    const codes = [...message.content.matchAll(INVITE)].map((m) => m[1]);
    if (codes.length) {
      const own = await ownInvites(guild);
      if (codes.some((c) => !own.has(c))) return punish(message, 'Invites to other servers aren\'t allowed here', { timeout: false });
    }
  }
  if (modules.flood) {
    const key = `${guild.id}:${message.author.id}`;
    const now = Date.now();
    const list = [...(recentMessages.get(key) ?? []).filter((m) => now - m.at < 30_000), { at: now, channelId: message.channelId, content: message.content, message }];
    recentMessages.set(key, list);
    const fast = list.filter((m) => now - m.at < limits.floodSeconds * 1000).length >= limits.floodCount;
    const same = message.content && new Set(list.filter((m) => m.content === message.content).map((m) => m.channelId)).size >= limits.duplicateChannels;
    if (fast || same) {
      recentMessages.delete(key);
      for (const m of list) if (m.message !== message) await m.message.delete().catch(() => {});
      return punish(message, fast ? 'Sending messages that fast counts as spam' : 'Posting the same message in several channels counts as spam');
    }
  }
}

// ---------------------------------------------------------------------------
//   Anti-nuke and permission watch, from the audit log
// ---------------------------------------------------------------------------

const DESTRUCTIVE = new Set([AuditLogEvent.ChannelDelete, AuditLogEvent.RoleDelete, AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick, AuditLogEvent.MemberPrune, AuditLogEvent.WebhookCreate]);
const recentActions = new Map(); // `${guildId}:${userId}` -> [at]
const isAdmin = (bits) => (BigInt(bits ?? 0) & P.Administrator) === P.Administrator;

async function onAuditEntry(entry, guild) {
  if (process.env.ENABLE_SECURITY !== 'true' || !entry.executorId || entry.executorId === guild.members.me.id) return;
  const settings = securitySettings(guild.id);

  if (settings.modules.permissionWatch) {
    const madeAdmin =
      (entry.action === AuditLogEvent.RoleUpdate && entry.changes.some((c) => c.key === 'permissions' && isAdmin(c.new) && !isAdmin(c.old))) ||
      (entry.action === AuditLogEvent.MemberRoleUpdate && entry.changes.some((c) => c.key === '$add' && c.new?.some((r) => isAdmin(guild.roles.cache.get(r.id)?.permissions.bitfield))));
    const what =
      entry.action === AuditLogEvent.BotAdd ? `added the bot <@${entry.targetId}>`
        : entry.action === AuditLogEvent.WebhookCreate ? 'made a webhook'
          : madeAdmin ? (entry.action === AuditLogEvent.RoleUpdate ? `gave the role <@&${entry.targetId}> Administrator` : `gave <@${entry.targetId}> an Administrator role`)
            : null;
    if (what) await alert(guild, 'Permission watch', `<@${entry.executorId}> ${what}.`);
  }

  if (!settings.modules.antiNuke || !DESTRUCTIVE.has(entry.action)) return;
  const executor = await guild.members.fetch(entry.executorId).catch(() => null);
  if (trusted(executor, settings)) return;
  const key = `${guild.id}:${entry.executorId}`;
  const now = Date.now();
  const list = [...(recentActions.get(key) ?? []).filter((at) => now - at < settings.limits.nukeSeconds * 1000), now];
  recentActions.set(key, list);
  if (list.length < settings.limits.nukeCount) return;
  recentActions.delete(key);

  let stopped = false;
  if (executor?.manageable) {
    const keep = executor.roles.cache.filter((r) => r.managed || r.id === guild.id).map((r) => r.id);
    stopped = await executor.roles.set(keep, 'Anti-nuke: too many destructive actions').then(() => true, () => false);
    if (executor.user.bot && executor.kickable) await executor.kick('Anti-nuke: too many destructive actions').catch(() => {});
  }
  await startRaid(guild, 'nuke', { executorId: entry.executorId, count: list.length });
  note(guild, stopped ? `Took the roles away from <@${entry.executorId}>` : `Couldn't take the roles away from <@${entry.executorId}>: their role is above mine`);
  if (!stopped) await alert(guild, 'Anti-nuke could not act', `<@${entry.executorId}> has a role above mine, so I couldn't stop them. Remove their roles yourself.`, [{ name: 'Fix', value: ROLE_HINT }]);
}

// ---------------------------------------------------------------------------
//   Buttons, the panel's view, and the timers
// ---------------------------------------------------------------------------

/** The Verify button for the join gate. Returns the reply text. */
export async function verifyMember(member) {
  const settings = securitySettings(member.guild.id);
  const role = member.guild.roles.cache.get(settings.gate?.roleId);
  if (!settings.modules.joinGate || !role) refuse("The join gate isn't on anymore.");
  if (stateOf(member.guild.id).raid && settings.modules.accountAge) {
    const days = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (days < settings.limits.accountAgeDays) refuse(`The server is dealing with a raid, so accounts under ${settings.limits.accountAgeDays} days old have to wait. Try again later.`);
  }
  if (member.roles.cache.has(role.id)) return "You're already verified.";
  await member.roles.add(role, 'Verified through the join gate');
  return `Welcome! You can see the rest of ${member.guild.name} now.`;
}

/** Everything the control panel's Security tab shows. */
export function securityStatus(guild) {
  const settings = securitySettings(guild.id);
  const state = stateOf(guild.id);
  return {
    ...settings,
    modulesInfo: Object.entries(MODULES).map(([key, m]) => ({ key, label: m.label, about: m.about, reaction: Boolean(m.reaction), fullSetup: FULL_SETUP_MODULES.includes(key) })),
    lockdown: state.lockdown ? { since: state.lockdown.since, auto: state.lockdown.auto } : null,
    raid: state.raid ? { kind: state.raid.kind, startedAt: state.raid.startedAt, until: state.raid.until, joined: state.raid.joined.length } : null,
    incidents: state.incidents.slice(0, 10).map((i) => ({ id: i.id, kind: i.kind, startedAt: i.startedAt, endedAt: i.endedAt, joined: i.joined, actions: i.actions.length })),
    roleTop: botRoleIsTop(guild),
    botRole: guild.members.me.roles.highest.name,
    hasLogChannel: Boolean(logChannel(guild)),
  };
}

export function registerSecurity(client) {
  client.on(Events.GuildMemberAdd, (member) => onJoin(member).catch((err) => console.error('Security (join):', err)));
  client.on(Events.MessageCreate, (message) => onMessage(message).catch((err) => console.error('Security (message):', err)));
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => onAuditEntry(entry, guild).catch((err) => console.error('Security (audit log):', err)));
  // Ends raids whose time is up, including ones that were running when the bot stopped, and takes daily backups.
  const tick = async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const raid = stateOf(guild.id).raid;
        if (raid && Date.now() >= raid.until) await endRaid(guild);
        if (on(guild.id, 'backups') && Date.now() - (latestBackup(guild.id)?.at ?? 0) >= BACKUP_EVERY_MS) takeBackup(guild, 'scheduled');
      } catch (err) {
        console.error(`Security (${guild.id}):`, err.message);
      }
    }
  };
  client.once(Events.ClientReady, () => {
    tick();
    setInterval(tick, 60_000).unref();
  });
}
