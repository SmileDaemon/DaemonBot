import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { buildModal } from '../utils/embeds.js';
import { defaultColor } from '../utils/parse.js';
import { guildConfig, tempVoiceRooms as rooms } from '../utils/store.js';

const CATEGORY_NAME = 'Temp Voice Channels';
const HUB_NAME = 'Join To Create';

/** What the bot needs in the server to make and run temporary channels. */
export const BOT_NEEDS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MoveMembers,
];
const BOT_ALLOW = [...BOT_NEEDS.filter((p) => p !== PermissionFlagsBits.ManageRoles), PermissionFlagsBits.ReadMessageHistory];
// The owner can rename it, set a limit and disconnect people. Changing who may join goes through the buttons.
const OWNER_PERMISSIONS = ['ViewChannel', 'Connect', 'Speak', 'ManageChannels', 'MoveMembers'];
// The bot can only hand out permissions it has itself.
const ownerAllow = (me) => OWNER_PERMISSIONS.filter((p) => me.permissions.has(PermissionFlagsBits[p]));
const GUEST = { ViewChannel: true, Connect: true };

export const tempVoiceSettings = (guildId) => guildConfig.get(guildId, {}).tempVoice ?? null;
const roomsIn = (guildId) => rooms.get(guildId, {});
const roomOf = (guildId, channelId) => roomsIn(guildId)[channelId] ?? null;

function saveRoom(guildId, channelId, room) {
  const all = roomsIn(guildId);
  if (room) all[channelId] = room;
  else delete all[channelId];
  if (Object.keys(all).length) rooms.set(guildId, all);
  else rooms.delete(guildId);
}

/** One of the bot's temporary channels, or in their category? Their coming and going isn't server news. */
export function isTempVoiceChannel(channel) {
  const settings = tempVoiceSettings(channel.guild.id);
  return Boolean(roomOf(channel.guild.id, channel.id)) || Boolean(settings && channel.parentId === settings.categoryId && channel.id !== settings.hubId);
}

const humansIn = (channel) => channel.members.filter((m) => !m.user.bot);

// ---------------------------------------------------------------------------
//   Setup
// ---------------------------------------------------------------------------

/** Makes the category and the join channel, reusing any that already exist. */
export async function setupTempVoice(guild) {
  const saved = tempVoiceSettings(guild.id) ?? {};
  const existing = (id, type) => (guild.channels.cache.get(id)?.type === type ? guild.channels.cache.get(id) : null);
  const reason = 'Temporary voice channels set up';
  const category = existing(saved.categoryId, ChannelType.GuildCategory) ?? (await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, reason }));
  let hub = existing(saved.hubId, ChannelType.GuildVoice);
  if (!hub) hub = await guild.channels.create({ name: HUB_NAME, type: ChannelType.GuildVoice, parent: category.id, reason });
  else if (hub.parentId !== category.id) await hub.setParent(category.id, { lockPermissions: false });
  guildConfig.set(guild.id, { ...guildConfig.get(guild.id, {}), tempVoice: { categoryId: category.id, hubId: hub.id } });
  return { category, hub, fresh: !saved.hubId };
}

/** Removes the join channel and empty temporary channels. Ones in use disappear when they empty. */
export async function removeTempVoice(guild) {
  const saved = tempVoiceSettings(guild.id);
  if (!saved) return { removed: 0, left: 0 };
  const reason = 'Temporary voice channels removed';
  await guild.channels.cache.get(saved.hubId)?.delete(reason).catch(() => {});
  let removed = 0;
  for (const channelId of Object.keys(roomsIn(guild.id))) {
    const channel = guild.channels.cache.get(channelId);
    if (channel && humansIn(channel).size) continue;
    await channel?.delete(reason).catch(() => {});
    saveRoom(guild.id, channelId, null);
    removed += 1;
  }
  const category = guild.channels.cache.get(saved.categoryId);
  if (category && !guild.channels.cache.some((c) => c.parentId === category.id)) await category.delete(reason).catch(() => {});
  const config = { ...guildConfig.get(guild.id, {}) };
  delete config.tempVoice;
  guildConfig.set(guild.id, config);
  return { removed, left: Object.keys(roomsIn(guild.id)).length };
}

/** For the control panel. */
export function tempVoiceStatus(guild) {
  const saved = tempVoiceSettings(guild.id);
  return {
    setUp: Boolean(saved),
    hubName: saved ? (guild.channels.cache.get(saved.hubId)?.name ?? null) : null,
    categoryName: saved ? (guild.channels.cache.get(saved.categoryId)?.name ?? null) : null,
    active: Object.keys(roomsIn(guild.id)).length,
  };
}

// ---------------------------------------------------------------------------
//   The controls posted in each channel's chat
// ---------------------------------------------------------------------------

const access = (room) => (room.private ? '🔒 Private: only invited members can see and join' : room.locked ? '🔐 Locked: visible, but only invited members can join' : '🔓 Open to everyone');

function controls(channel, room) {
  const id = channel.id;
  const button = (action, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`setup:tempvoice:${action}:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);
  const embed = new EmbedBuilder()
    .setTitle(`🔊 ${channel.name}`)
    .setColor(defaultColor)
    .setDescription('Only the owner can use these buttons. The channel disappears when everyone has left.')
    .addFields(
      { name: 'Owner', value: `<@${room.ownerId}>`, inline: true },
      { name: 'User limit', value: channel.userLimit ? String(channel.userLimit) : 'None', inline: true },
      { name: 'Access', value: access(room) },
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        button('rename', 'Rename', '✏️'),
        button('limit', 'User limit', '👥'),
        button('lock', room.locked ? 'Unlock' : 'Lock', room.locked ? '🔓' : '🔐'),
        button('private', room.private ? 'Make public' : 'Make private', room.private ? '👁️' : '🙈'),
      ),
      new ActionRowBuilder().addComponents(
        button('invite', 'Invite', '➕', ButtonStyle.Success),
        button('remove', 'Remove', '➖', ButtonStyle.Danger),
        button('transfer', 'Transfer ownership', '👑'),
        button('claim', 'Claim', '🙋'),
      ),
    ],
  };
}

async function refreshControls(channel, room) {
  const message = room.messageId ? await channel.messages.fetch(room.messageId).catch(() => null) : null;
  if (message) return message.edit(controls(channel, room)).catch(() => {});
  const sent = await channel.send(controls(channel, room)).catch(() => null);
  if (sent) saveRoom(channel.guild.id, channel.id, { ...room, messageId: sent.id });
}

/** Who can see and join: everyone, everyone can see but not join, or nobody but those invited. */
function applyAccess(channel, room) {
  return channel.permissionOverwrites.edit(
    channel.guild.id,
    { ViewChannel: room.private ? false : null, Connect: room.private || room.locked ? false : null },
    { type: OverwriteType.Role, reason: 'Temporary voice channel access changed' },
  );
}

// ---------------------------------------------------------------------------
//   Making and removing channels
// ---------------------------------------------------------------------------

const creating = new Set();

async function createRoom(member, settings) {
  const { guild } = member;
  // Someone who already has a channel goes back to it instead of making another.
  const ownedId = Object.entries(roomsIn(guild.id)).find(([id, r]) => r.ownerId === member.id && guild.channels.cache.has(id))?.[0];
  if (ownedId) return member.voice.setChannel(ownedId).catch(() => {});
  if (creating.has(member.id)) return;
  creating.add(member.id);
  try {
    const category = guild.channels.cache.get(settings.categoryId);
    const me = guild.members.me;
    const inherited = category?.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })) ?? [];
    const channel = await guild.channels.create({
      name: member.displayName.slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: settings.categoryId,
      permissionOverwrites: [
        ...inherited.filter((o) => o.id !== member.id && o.id !== me.id),
        { id: me.id, type: OverwriteType.Member, allow: BOT_ALLOW },
        { id: member.id, type: OverwriteType.Member, allow: ownerAllow(me) },
      ],
      reason: `Temporary voice channel for ${member.user.tag}`,
    });
    const room = { ownerId: member.id, locked: false, private: false, messageId: null };
    saveRoom(guild.id, channel.id, room);
    const moved = await member.voice.setChannel(channel).then(() => true, () => false);
    if (!moved) return deleteRoom(channel); // they left the join channel before it was ready
    await refreshControls(channel, room);
  } finally {
    creating.delete(member.id);
  }
}

async function deleteRoom(channel) {
  saveRoom(channel.guild.id, channel.id, null);
  await channel.delete('Temporary voice channel is empty').catch(() => {});
}

export function registerTempVoice(client) {
  client.on(Events.VoiceStateUpdate, async (before, after) => {
    try {
      if (before.channelId === after.channelId) return; // muting, deafening, streaming
      const left = before.channel;
      if (left && roomOf(left.guild.id, left.id) && !humansIn(left).size) await deleteRoom(left);
      const settings = after.channel && tempVoiceSettings(after.guild.id);
      if (settings && after.channelId === settings.hubId && after.member && !after.member.user.bot) await createRoom(after.member, settings);
    } catch (err) {
      console.error('Temporary voice:', err.message);
    }
  });
  // A channel deleted by hand is simply gone.
  client.on(Events.ChannelDelete, (channel) => {
    if (channel.guild && roomOf(channel.guild.id, channel.id)) saveRoom(channel.guild.id, channel.id, null);
  });
  // Channels that emptied, or were deleted, while the bot was offline.
  client.once(Events.ClientReady, async () => {
    for (const guildId of rooms.keys()) {
      const guild = client.guilds.cache.get(guildId);
      for (const channelId of Object.keys(roomsIn(guildId))) {
        const channel = guild?.channels.cache.get(channelId);
        if (!channel) saveRoom(guildId, channelId, null);
        else if (!humansIn(channel).size) await deleteRoom(channel);
      }
    }
  });
}

// ---------------------------------------------------------------------------
//   The buttons, and the menus and forms they open
// ---------------------------------------------------------------------------

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};

/** The room a button or menu belongs to, checking it still exists and, unless `anyone`, that the owner is using it. */
function roomFor(interaction, channelId, { anyone = false } = {}) {
  const channel = interaction.guild.channels.cache.get(channelId);
  const room = channel && roomOf(interaction.guild.id, channelId);
  if (!room) refuse('This temporary channel is gone.');
  if (!anyone && interaction.user.id !== room.ownerId) refuse(`Only <@${room.ownerId}>, the channel's owner, can do that.`);
  return { channel, room };
}

async function giveOwnership(channel, room, newOwnerId) {
  const owner = Object.fromEntries(ownerAllow(channel.guild.members.me).map((p) => [p, true]));
  // The old owner keeps a way in, as if invited.
  await channel.permissionOverwrites.edit(room.ownerId, { ...GUEST, Speak: null, ManageChannels: null, MoveMembers: null }, { type: OverwriteType.Member }).catch(() => {});
  await channel.permissionOverwrites.edit(newOwnerId, owner, { type: OverwriteType.Member, reason: 'Temporary voice channel ownership transferred' });
  const next = { ...room, ownerId: newOwnerId };
  saveRoom(channel.guild.id, channel.id, next);
  await refreshControls(channel, next);
}

const userMenu = (action, channelId, placeholder) =>
  new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(`setup:tempvoice:${action}:${channelId}`).setPlaceholder(placeholder).setMinValues(1).setMaxValues(10),
  );

/** A button was pressed. Returns a reply to show only to the person who pressed it, or nothing if a form opened. */
async function onButton(interaction, action, channelId) {
  const { channel, room } = roomFor(interaction, channelId, { anyone: action === 'claim' });
  switch (action) {
    case 'rename':
      return interaction.showModal(buildModal(`setup:tempvoice:rename:${channelId}`, 'Rename your channel', [{ id: 'name', label: 'Name', required: true, max: 100, value: channel.name }]));
    case 'limit':
      return interaction.showModal(
        buildModal(`setup:tempvoice:limit:${channelId}`, 'User limit', [
          { id: 'limit', label: 'Most people allowed in (0 for no limit)', required: true, max: 2, value: String(channel.userLimit ?? 0) },
        ]),
      );
    case 'lock':
    case 'private': {
      const next = { ...room, [action === 'lock' ? 'locked' : 'private']: !room[action === 'lock' ? 'locked' : 'private'] };
      // Whoever is already in keeps their place when it closes up.
      if ((next.private && !room.private) || (next.locked && !room.locked)) {
        for (const member of humansIn(channel).values()) {
          if (member.id !== room.ownerId) await channel.permissionOverwrites.edit(member.id, GUEST, { type: OverwriteType.Member });
        }
      }
      await applyAccess(channel, next);
      saveRoom(interaction.guild.id, channelId, next);
      await refreshControls(channel, next);
      return next.private
        ? 'The channel is private: only you and the people you invite can see it or join.'
        : next.locked
          ? 'The channel is locked: everyone can see it, but only people you invite can join.'
          : 'The channel is open to everyone again.';
    }
    case 'invite':
      return { components: [userMenu('invite', channelId, 'Who can see and join?')], text: 'Pick up to 10 people to let in.' };
    case 'remove':
      return { components: [userMenu('remove', channelId, 'Who should be removed?')], text: "Pick people to disconnect and keep out. Invite them again to let them back in." };
    case 'transfer': {
      const others = humansIn(channel).filter((m) => m.id !== room.ownerId);
      if (!others.size) refuse('Nobody else is in the channel to hand it to.');
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`setup:tempvoice:transfer:${channelId}`)
        .setPlaceholder('New owner')
        .addOptions(others.first(25).map((m) => ({ label: m.displayName.slice(0, 100), value: m.id })));
      return { components: [new ActionRowBuilder().addComponents(menu)], text: 'Who should own the channel? Only people in it can be picked.' };
    }
    case 'claim': {
      if (interaction.user.id === room.ownerId) refuse('You already own this channel.');
      if (channel.members.has(room.ownerId)) refuse(`<@${room.ownerId}> is still here, so the channel is theirs. They can transfer it to you.`);
      if (!channel.members.has(interaction.user.id)) refuse('Join the channel to claim it.');
      await giveOwnership(channel, room, interaction.user.id);
      return 'The channel is yours now.';
    }
  }
  refuse('That button is out of date.');
}

async function onModal(interaction, action, channelId) {
  const { channel, room } = roomFor(interaction, channelId);
  if (action === 'rename') {
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name) refuse('The name can\'t be blank.');
    await channel.setName(name.slice(0, 100), `Renamed by ${interaction.user.tag}`);
    await refreshControls(channel, room);
    return `Renamed to **${channel.name}**. Discord allows 2 renames every 10 minutes.`;
  }
  if (action === 'limit') {
    const limit = Number(interaction.fields.getTextInputValue('limit').trim());
    if (!Number.isInteger(limit) || limit < 0 || limit > 99) refuse('The limit has to be a whole number from 0 to 99.');
    await channel.setUserLimit(limit);
    await refreshControls(channel, room);
    return limit ? `At most ${limit} people can be in the channel.` : 'No user limit.';
  }
  refuse('That form is out of date.');
}

async function onSelect(interaction, action, channelId) {
  const { channel, room } = roomFor(interaction, channelId);
  const me = interaction.guild.members.me;
  const picked = interaction.values.filter((id) => id !== room.ownerId && id !== me.id);
  if (action === 'invite') {
    if (!picked.length) refuse('Pick someone other than yourself.');
    for (const id of picked) await channel.permissionOverwrites.edit(id, GUEST, { type: OverwriteType.Member, reason: `Invited by ${interaction.user.tag}` });
    await channel.send({ content: `${picked.map((id) => `<@${id}>`).join(' ')}: <@${room.ownerId}> invited you to this channel.`, allowedMentions: { users: picked } }).catch(() => {});
    return `Invited ${picked.map((id) => `<@${id}>`).join(', ')}.`;
  }
  if (action === 'remove') {
    if (!picked.length) refuse('Pick someone other than yourself.');
    for (const id of picked) {
      await channel.permissionOverwrites.edit(id, { ViewChannel: room.private ? false : null, Connect: false }, { type: OverwriteType.Member, reason: `Removed by ${interaction.user.tag}` });
      const member = channel.members.get(id);
      if (member) await member.voice.disconnect(`Removed by ${interaction.user.tag}`).catch(() => {});
    }
    return `Removed ${picked.map((id) => `<@${id}>`).join(', ')}. They can't join again unless you invite them.`;
  }
  if (action === 'transfer') {
    const [id] = interaction.values;
    if (!channel.members.has(id)) refuse('They left the channel. Only people in it can be picked.');
    await giveOwnership(channel, room, id);
    return `<@${id}> owns the channel now.`;
  }
  refuse('That menu is out of date.');
}

/** Runs a button, form or menu for a temporary channel, replying only to whoever used it. */
export async function handleTempVoice(interaction) {
  const [action, channelId] = interaction.customId.split(':').slice(-2); // "setup:tempvoice:<action>:<channel>"
  const opensForm = interaction.isButton() && (action === 'rename' || action === 'limit');
  const quick = interaction.isButton() && ['invite', 'remove', 'transfer'].includes(action);
  try {
    if (!opensForm && !quick) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const run = interaction.isButton() ? onButton : interaction.isModalSubmit() ? onModal : onSelect;
    const result = await run(interaction, action, channelId);
    if (opensForm) return;
    const reply = typeof result === 'string' ? { content: result } : { content: result.text, components: result.components };
    if (quick) await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    else await interaction.editReply({ ...reply, allowedMentions: { parse: [] } });
  } catch (err) {
    if (!(err instanceof Refused)) console.error(`Temporary voice ${action}:`, err);
    const content = err instanceof Refused ? err.message : 'Something went wrong. Check that I still have Manage Channels, Manage Roles and Move Members.';
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  }
}
