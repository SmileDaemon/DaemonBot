import {
  ChannelType,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { addStats, DEFAULT_STATS, MAX_STATS, statSettings } from '../../features/statChannels.js';
import { BOT_NEEDS as TEMP_VOICE_NEEDS, handleTempVoice, removeTempVoice, setupTempVoice, tempVoiceSettings } from '../../features/tempVoice.js';
import { parseTicketTypes, setupTicketSection, ticketSettings, ticketTypes } from '../../features/tickets.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral, notice } from '../../utils/replies.js';
import { guildConfig } from '../../utils/store.js';

const P = PermissionFlagsBits;
// To make the ticket section and each ticket's channel. The bot can only hand out permissions it has itself.
const BOT_NEEDS_FOR_TICKETS = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.ManageChannels, P.ManageRoles, P.ManageMessages];
const BOT_NEEDS_FOR_STATS = [P.ViewChannel, P.ManageChannels, P.Connect];
const BOT_NEEDS_IN_LOG_CHANNEL = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles];
const LOG_CHANNEL_NAME = 'bot-logs';

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};
const off = (flag) => process.env[flag] !== 'true';

// ---------------------------------------------------------------------------
//   Each part, at its default when run from /setup full
// ---------------------------------------------------------------------------

function checkTickets(guild) {
  if (!guild.members.me.permissions.has(BOT_NEEDS_FOR_TICKETS)) {
    refuse('For tickets I need: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages, Manage Channels, and Manage Roles.');
  }
}

async function setUpTickets(guild, user, options) {
  checkTickets(guild);
  const { section, channel, fresh } = await setupTicketSection(guild, options);
  await logEvent(guild, {
    title: fresh ? 'Ticket system set up' : 'Ticket system updated',
    color: COLORS.ticket,
    user,
    fields: [
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Staff role', value: options.staffRoleId ? `<@&${options.staffRoleId}>` : 'Admins only', inline: true },
      { name: 'Types', value: options.types.join(', ').slice(0, 1024) },
    ],
  });
  return { section, channel };
}

const ticketDefaults = (guild) => {
  const saved = ticketSettings(guild.id);
  return { staffRoleId: saved?.staffRoleId ?? null, queueChannelId: saved?.queueChannelId ?? null, pingStaff: saved?.pingStaff ?? false, types: ticketTypes(saved) };
};

async function setUpStats(guild, user, picks) {
  if (off('ENABLE_STAT_CHANNELS')) refuse("Server stats are turned off in the bot's .env.");
  if (!guild.members.me.permissions.has(BOT_NEEDS_FOR_STATS)) refuse('For server stats I need: View Channels, Manage Channels, and Connect.');
  const { added, skipped } = await addStats(guild, picks);
  await logEvent(guild, { title: 'Server stats set up', color: COLORS.info, user, fields: [{ name: 'Added', value: String(added), inline: true }] });
  return { added, skipped };
}

async function setUpTempVoice(guild, user) {
  if (off('ENABLE_TEMP_VOICE')) refuse("Temporary voice channels are turned off in the bot's .env.");
  if (!guild.members.me.permissions.has(TEMP_VOICE_NEEDS)) {
    refuse('For temporary voice channels I need: View Channels, Connect, Send Messages, Embed Links, Manage Channels, Manage Roles, and Move Members.');
  }
  const result = await setupTempVoice(guild);
  await logEvent(guild, { title: 'Temporary voice channels set up', color: COLORS.info, user, fields: [{ name: 'Join channel', value: `${result.hub}`, inline: true }] });
  return result;
}

/** Sets the log channel, or turns logging off. Logged before turning off and after turning on, so either way it's recorded. */
async function setLogChannel(guild, user, channel) {
  if (channel && !channel.permissionsFor(guild.members.me).has(BOT_NEEDS_IN_LOG_CHANNEL)) {
    refuse(`I need View Channel, Send Messages, Embed Links, and Attach Files in ${channel} first.`);
  }
  const entry = { title: `Log channel ${channel ? `set to #${channel.name}` : 'turned off'}`, color: COLORS.info, user };
  if (!channel) await logEvent(guild, entry);
  guildConfig.set(guild.id, { ...guildConfig.get(guild.id, {}), logChannelId: channel?.id ?? null });
  if (channel) await logEvent(guild, entry);
}

/** For /setup full: the log channel there is, or a new staff-only one. */
async function defaultLogChannel(guild, user) {
  const current = guild.channels.cache.get(guildConfig.get(guild.id, {}).logChannelId);
  if (current) return { channel: current, made: false };
  if (!guild.members.me.permissions.has([P.ManageChannels, P.ManageRoles, ...BOT_NEEDS_IN_LOG_CHANNEL])) refuse('For a log channel I need Manage Channels and Manage Roles.');
  const channel = await guild.channels.create({
    name: LOG_CHANNEL_NAME,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: guild.members.me.id, type: OverwriteType.Member, allow: BOT_NEEDS_IN_LOG_CHANNEL },
    ],
    reason: 'Log channel made by /setup full',
  });
  await setLogChannel(guild, user, channel);
  return { channel, made: true };
}

// ---------------------------------------------------------------------------
//   The subcommands
// ---------------------------------------------------------------------------

/** /setup tickets asks for the ticket types first. Its options ride along in the form's ID. */
function ticketsForm(interaction) {
  checkTickets(interaction.guild);
  const role = interaction.options.getRole('staff_role');
  const queue = interaction.options.getChannel('queue_channel');
  if (queue && !queue.permissionsFor(interaction.guild.members.me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
    refuse(`I need View Channel, Send Messages, and Embed Links in ${queue}.`);
  }
  const ping = interaction.options.getBoolean('ping_staff') ? 1 : 0;
  const types = new TextInputBuilder()
    .setCustomId('types')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(2000)
    .setValue(ticketTypes(ticketSettings(interaction.guild.id)).join('\n'));
  return interaction.showModal(
    new ModalBuilder()
      .setCustomId(`setup:tickets:${role?.id ?? '-'}:${queue?.id ?? '-'}:${ping}`)
      .setTitle('Set up tickets')
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Ticket types, one per line')
          .setDescription('These fill the dropdown in "Create A Ticket". Leave blank for just "Report A Problem".')
          .setTextInputComponent(types),
      ),
  );
}

async function ticketsSubmit(interaction) {
  const [, , role, queue, ping] = interaction.customId.split(':');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const types = parseTicketTypes(interaction.fields.getTextInputValue('types'));
  const staffRoleId = role === '-' ? null : role;
  const queueChannelId = queue === '-' ? null : queue;
  const { section, channel } = await setUpTickets(interaction.guild, interaction.user, { staffRoleId, queueChannelId, pingStaff: ping === '1', types });
  const notes = [
    `✅ Members open tickets from the dropdown in ${channel}, in **${section.name}**. Types: ${types.map((t) => `**${t}**`).join(', ')}.`,
    `Each ticket gets its own channel that only its creator and ${staffRoleId ? `<@&${staffRoleId}>` : 'admins'} can see. Closed tickets move to an archive, where the creator can read but not post.`,
    staffRoleId ? null : 'To let a staff role handle tickets too, run this again with `staff_role`.',
    queueChannelId ? `New tickets are also listed in <#${queueChannelId}>, with their details, so make sure only staff can see it.` : 'Staff claim each ticket from a button inside its channel.',
  ];
  await interaction.editReply(notice(notes.filter(Boolean).join('\n\n'), { tone: 'success', title: 'Tickets are set up' }));
}

/** /setup serverstats asks which stats to show besides members and bots. */
function statsForm(interaction) {
  if (off('ENABLE_STAT_CHANNELS')) refuse("Server stats are turned off in the bot's .env.");
  const shown = new Set(statSettings(interaction.guild).stats.map((s) => s.type));
  const extras = statSettings(interaction.guild).types.filter((t) => !t.role && !DEFAULT_STATS.includes(t.type));
  const modal = new ModalBuilder().setCustomId('setup:serverstats').setTitle('Set up server stats');
  if (extras.length) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Other stats to show')
        .setDescription('Members and bots are always added.')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('types')
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(extras.length)
            .addOptions(extras.map((t) => ({ label: t.label, value: t.type, default: shown.has(t.type) }))),
        ),
    );
  }
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('Roles to count')
      .setDescription(`Each gets a channel showing how many members have it (${MAX_STATS} channels at most).`)
      .setRoleSelectMenuComponent(new RoleSelectMenuBuilder().setCustomId('roles').setRequired(false).setMinValues(0).setMaxValues(8)),
  );
  return interaction.showModal(modal);
}

async function statsSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let types = [];
  try {
    types = interaction.fields.getStringSelectValues('types');
  } catch {} // no extra stats were offered
  const roleIds = [...(interaction.fields.getSelectedRoles('roles')?.keys() ?? [])];
  const { added, skipped } = await setUpStats(interaction.guild, interaction.user, { types: [...DEFAULT_STATS, ...types], roleIds });
  const now = statSettings(interaction.guild).stats.length;
  await interaction.editReply(
    notice(
      `${added ? `Added ${added} stat channel${added === 1 ? '' : 's'}` : 'Nothing new to add'}; ${now} in all, as locked voice channels everyone can see but not join. ` +
        "Counts update by themselves, though Discord allows a channel's name to change only twice every 10 minutes." +
        (skipped ? `\n\n⚠️ ${skipped} didn't fit: a server can have ${MAX_STATS}. Remove some in the control panel's Server Stats tab first.` : ''),
      { tone: skipped ? 'warn' : 'success', title: 'Server stats are set up' },
    ),
  );
}

async function logs(interaction) {
  const channel = interaction.options.getChannel('channel');
  await setLogChannel(interaction.guild, interaction.user, channel);
  await interaction.reply(ephemeral(channel ? `Logs will be posted in ${channel}.` : 'Logging turned off.', 'success'));
}

async function tempVoice(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { category, hub, fresh } = await setUpTempVoice(interaction.guild, interaction.user);
  await interaction.editReply(
    notice(
      `Anyone who joins ${hub} gets their own voice channel in **${category.name}**, named after them, with buttons in its chat to manage it. ` +
        'Each channel disappears once everyone has left. Move or rename the category and join channel as you like.',
      { tone: 'success', title: fresh ? 'Temporary voice channels are set up' : 'Temporary voice channels checked' },
    ),
  );
}

async function removeTempVoiceCommand(interaction) {
  if (!tempVoiceSettings(interaction.guild.id)) refuse("Temporary voice channels aren't set up here.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { left } = await removeTempVoice(interaction.guild);
  await interaction.editReply(
    notice(
      `Temporary voice channels are off, and the join channel is gone.${left ? ` ${left} channel${left === 1 ? ' is' : 's are'} still in use and will disappear when ${left === 1 ? 'it empties' : 'they empty'}.` : ''}`,
      { tone: 'success' },
    ),
  );
  await logEvent(interaction.guild, { title: 'Temporary voice channels removed', color: COLORS.info, user: interaction.user });
}

/** Everything at its defaults, one after another. A part that can't be set up is reported, and the rest still run. */
async function full(interaction) {
  const { guild, user } = interaction;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const parts = [
    ['Log channel', async () => {
      const { channel, made } = await defaultLogChannel(guild, user);
      return made ? `${channel}, made for staff only` : `${channel}, kept as it was`;
    }],
    ['Tickets', async () => {
      const { channel } = await setUpTickets(guild, user, ticketDefaults(guild));
      return `dropdown in ${channel}${ticketSettings(guild.id).staffRoleId ? '' : '; admins only, so add a staff role with `/setup tickets`'}`;
    }],
    ['Temporary voice', async () => `join ${(await setUpTempVoice(guild, user)).hub} to make a channel`],
    ['Server stats', async () => {
      await setUpStats(guild, user, { types: DEFAULT_STATS });
      return `${statSettings(guild).stats.length} stat channel(s); add more with \`/setup serverstats\``;
    }],
  ];
  const lines = [];
  for (const [name, run] of parts) {
    try {
      lines.push(`✅ **${name}:** ${await run()}`);
    } catch (err) {
      if (!(err instanceof Refused)) console.error(`/setup full (${name}):`, err);
      lines.push(`⚠️ **${name}:** ${err instanceof Refused ? err.message : 'something went wrong; try its own /setup command.'}`);
    }
  }
  const allGood = lines.every((l) => l.startsWith('✅'));
  await interaction.editReply(notice(lines.join('\n'), { tone: allGood ? 'success' : 'warn', title: allGood ? 'Everything is set up' : 'Set up, with some gaps' }));
}

const RUN = { full, tickets: ticketsForm, serverstats: statsForm, logs, tempvoice: tempVoice, 'remove-tempvoice': removeTempVoiceCommand };

/** Replies with a refusal, whether or not the interaction was already deferred. */
async function report(interaction, err, what) {
  if (!(err instanceof Refused)) console.error(`/setup ${what}:`, err);
  const payload = ephemeral(err instanceof Refused ? err.message : 'Something went wrong setting that up.');
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
  else await interaction.reply(payload).catch(() => {});
}

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Admins: set up the bot\'s features')
    .addSubcommand((s) => s.setName('full').setDescription('Set up everything at its defaults: log channel, tickets, temporary voice and server stats'))
    .addSubcommand((s) =>
      s
        .setName('tickets')
        .setDescription('Make the Support Tickets section and its ticket dropdown (asks for the ticket types)')
        .addRoleOption((o) => o.setName('staff_role').setDescription('Role that can see and claim tickets (admins only if left out)'))
        .addChannelOption((o) =>
          o
            .setName('queue_channel')
            .setDescription('Optional staff-only channel listing new tickets (otherwise staff claim inside each ticket)')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((o) => o.setName('ping_staff').setDescription('Ping the staff role for each new ticket')),
    )
    .addSubcommand((s) => s.setName('serverstats').setDescription('Show member counts as locked voice channels (asks which stats to show)'))
    .addSubcommand((s) =>
      s
        .setName('logs')
        .setDescription('Set the channel where moderation, bot actions and server events are logged (empty = off)')
        .addChannelOption((o) => o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) => s.setName('tempvoice').setDescription('Create the Temp Voice Channels category and its "Join To Create" channel'))
    .addSubcommand((s) => s.setName('remove-tempvoice').setDescription('Remove the join channel; temporary channels in use disappear when they empty'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    try {
      await RUN[sub](interaction);
    } catch (err) {
      await report(interaction, err, sub);
    }
  },

  // The ticket and server stats forms, and the controls inside each temporary voice channel ("setup:tempvoice:<action>:<channel>").
  async handleModal(interaction) {
    const part = interaction.customId.split(':')[1];
    if (part === 'tempvoice') return handleTempVoice(interaction);
    try {
      await (part === 'tickets' ? ticketsSubmit : statsSubmit)(interaction);
    } catch (err) {
      await report(interaction, err, part);
    }
  },
  handleButton: handleTempVoice,
  handleSelect: handleTempVoice,
};
