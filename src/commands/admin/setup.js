import {
  ChannelType,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { DEFAULT_STATS, MAX_STATS, statSettings } from '../../features/statChannels.js';
import { handleTempVoice, removeTempVoice, tempVoiceSettings } from '../../features/tempVoice.js';
import { parseTicketTypes, ticketSettings, ticketTypes } from '../../features/tickets.js';
import {
  checkTickets,
  defaultPlan,
  runFullSetup,
  setLogChannel,
  setUpStats,
  setUpTempVoice,
  setUpTickets,
} from '../../features/fullSetup.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { refuse, Refused } from '../../utils/refused.js';
import { ephemeral, notice } from '../../utils/replies.js';

const P = PermissionFlagsBits;
const off = (flag) => process.env[flag] !== 'true';

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

/** Everything at its defaults, one after another. Runs once per server, until a Full Reset in the control panel. */
async function full(interaction) {
  const { guild, user } = interaction;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results = await runFullSetup(guild, user, defaultPlan(guild), 'discord');
  const lines = results.map((r) => `${r.ok ? '✅' : '⚠️'} **${r.name}:** ${r.text}`);
  lines.push('', '🔒 Full setup is now locked for this server. Change each part with its own /setup command or in the control panel, or use Full Reset in the control panel\'s Danger Zone to run it again.');
  const allGood = results.every((r) => r.ok);
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
    .addSubcommand((s) => s.setName('full').setDescription('Set up everything at its defaults, once per server: logs, tickets, temp voice and server stats'))
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
