import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
} from 'discord.js';
import { COLORS, logEvent } from '../utils/logging.js';
import { defaultColor } from '../utils/parse.js';
import { refuse, Refused } from '../utils/refused.js';
import { guildConfig } from '../utils/store.js';
import { defaultLogChannel, setLogChannel } from './fullSetup.js';

// A server that adds the bot has to accept the Terms of Service and Privacy Policy, in the control panel,
// before it can be set up. Until then its commands and the panel's changes are locked. Declining makes the
// bot leave. Servers the bot was already in when this started are treated as having accepted.

const REQUIRED_SINCE = Date.parse('2026-11-03T06:00:00Z');
const P = PermissionFlagsBits;

const termsOf = (guildId) => guildConfig.get(guildId, {}).terms ?? null;
function saveTerms(guildId, terms) {
  guildConfig.set(guildId, { ...guildConfig.get(guildId, {}), terms });
}

/** Whether a server is still waiting to accept: one the bot joined since this started, that hasn't accepted. */
export function termsLocked(guild) {
  if (termsOf(guild.id)?.acceptedAt) return false;
  return (guild.members.me?.joinedTimestamp ?? Date.now()) >= REQUIRED_SINCE;
}

/** For the control panel. */
export function termsStatus(guild) {
  const terms = termsOf(guild.id);
  return { accepted: !termsLocked(guild), acceptedAt: terms?.acceptedAt ?? null, by: terms?.by ?? null, logChannelSet: Boolean(guildConfig.get(guild.id, {}).logChannelId) };
}

/** Where the bot's link sends people: the worker passes it on to the panel's terms page for this server. */
const termsUrl = (guildId) => (process.env.PANEL_URL ? `${process.env.PANEL_URL.replace(/\/+$/, '')}/terms/${guildId}` : null);
export const LOCKED_MESSAGE = "This server hasn't accepted DaemonBot's Terms of Service and Privacy Policy yet. Someone with Manage Server can read and accept them in the control panel; until then the bot can't be set up.";

// ---------------------------------------------------------------------------
//   The steps: pick a log channel, then go to the panel to accept
// ---------------------------------------------------------------------------

function welcomeMessage(guild) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`Thanks for adding DaemonBot to ${guild.name}!`)
        .setColor(defaultColor)
        .setDescription(
          "Let's get started. **Step 1:** pick the channel where I should post logs and alerts, or let me make a staff-only #bot-logs.\n\n" +
            '**Step 2:** read and accept the Terms of Service and Privacy Policy in the control panel. Until then, I can\'t be set up.\n\n' +
            'Only members with **Manage Server** can do this.',
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('setup:welcome:log').setPlaceholder('Pick the log channel').addChannelTypes(ChannelType.GuildText),
      ),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:welcome:make').setLabel('Make #bot-logs for me').setEmoji('🛠️').setStyle(ButtonStyle.Secondary)),
    ],
  };
}

function termsPrompt(guild) {
  const url = termsUrl(guild.id);
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('One more step: the Terms of Service and Privacy Policy')
        .setColor(COLORS.info)
        .setDescription(
          `Before ${guild.name} can use DaemonBot, someone with Manage Server needs to read and accept the Terms of Service and Privacy Policy in the control panel. ` +
            "Sign in with Discord, scroll through each one, and choose **Agree** or **Decline**. Declining either one makes the bot leave the server.\n\n" +
            (url ? 'Use the button below.' : "Open the control panel and pick this server; you'll land on them."),
        ),
    ],
    components: url ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Read and accept').setEmoji('📜').setStyle(ButtonStyle.Link).setURL(url))] : [],
  };
}

/** Where the bot can talk on arrival: the server's system channel, or the first text channel it can post in. */
function arrivalChannel(guild) {
  const can = (c) => c?.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
  if (can(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.filter(can).sort((a, b) => a.rawPosition - b.rawPosition).first() ?? null;
}

/** The welcome: asks for a log channel, or goes straight to the terms if one is set. Falls back to messaging the owner. */
async function welcome(guild) {
  if (guildConfig.get(guild.id, {}).logChannelId) return promptForTerms(guild);
  const channel = arrivalChannel(guild);
  if (channel) {
    const message = await channel.send(welcomeMessage(guild)).catch(() => null);
    if (message) return saveTerms(guild.id, { ...termsOf(guild.id), welcomeChannelId: channel.id, welcomeMessageId: message.id });
  }
  // Nowhere to post: the owner gets the link, and can pick a log channel later.
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send(termsPrompt(guild)).catch(() => {});
  saveTerms(guild.id, { ...termsOf(guild.id), welcomeChannelId: null, welcomeMessageId: null, ownerMessaged: true });
}

async function promptForTerms(guild) {
  const channel = guild.channels.cache.get(guildConfig.get(guild.id, {}).logChannelId);
  const message = await channel?.send(termsPrompt(guild)).catch(() => null);
  saveTerms(guild.id, { ...termsOf(guild.id), promptChannelId: channel?.id ?? null, promptMessageId: message?.id ?? null });
}

/** Step 1 done: the log channel (picked, or made with `channel` null) is set, the welcome says so, and the terms prompt goes there. */
async function setWelcomeLogChannel(guild, user, channel) {
  if (!termsLocked(guild)) refuse('This server is already set up to use the bot. Change the log channel with `/setup logs`.');
  const logChannel = channel ? (await setLogChannel(guild, user, channel), channel) : (await defaultLogChannel(guild, user)).channel;
  const terms = termsOf(guild.id);
  const welcomeMsg = await guild.channels.cache.get(terms?.welcomeChannelId)?.messages.fetch(terms.welcomeMessageId).catch(() => null);
  await welcomeMsg
    ?.edit({
      embeds: [new EmbedBuilder().setTitle('Log channel set').setColor(COLORS.join).setDescription(`Logs and alerts go to ${logChannel}. Head there for the last step: the Terms of Service and Privacy Policy.`)],
      components: [],
    })
    .catch(() => {});
  await promptForTerms(guild);
  return logChannel;
}

/** Records that someone accepted both documents for this server, which unlocks it. */
export async function acceptTerms(guild, user, via) {
  if (!termsLocked(guild)) return false;
  const terms = termsOf(guild.id);
  saveTerms(guild.id, { acceptedAt: Date.now(), by: { id: user.id, username: user.username }, via });
  const prompt = await guild.channels.cache.get(terms?.promptChannelId)?.messages.fetch(terms.promptMessageId).catch(() => null);
  await prompt?.edit({ embeds: [new EmbedBuilder().setTitle('Terms accepted').setColor(COLORS.join).setDescription(`${user.username} accepted the Terms of Service and Privacy Policy. The bot is unlocked: run \`/setup full\`, or set things up in the control panel.`)], components: [] }).catch(() => {});
  await logEvent(guild, { title: 'Terms of Service and Privacy Policy accepted', color: COLORS.join, description: `By ${user.username} (${user.id}), in the ${via === 'panel' ? 'control panel' : 'server'}. Everything can be set up now.` });
  return true;
}

/** Someone declined: says why, then leaves the server. */
export async function declineTerms(guild, user, which) {
  const reason = `${user.username} declined the ${which === 'privacy' ? 'Privacy Policy' : 'Terms of Service'}, so DaemonBot is leaving the server. You can add it again any time.`;
  await logEvent(guild, { title: 'Terms declined', color: COLORS.leave, description: reason }).catch(() => {});
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner && owner.id !== user.id) await owner.send(`DaemonBot left **${guild.name}**: ${reason}`).catch(() => {});
  setTimeout(() => guild.leave().catch((err) => console.error(`Couldn't leave ${guild.id}:`, err.message)), 2_000).unref?.();
}

// ---------------------------------------------------------------------------
//   The welcome's menu and button (custom IDs "setup:welcome:<log|make>"), and when to welcome
// ---------------------------------------------------------------------------

export async function handleWelcome(interaction) {
  if (!interaction.memberPermissions?.has(P.ManageGuild)) {
    return interaction.reply({ content: 'Only members with Manage Server can do this.', flags: 64 });
  }
  await interaction.deferReply({ flags: 64 });
  try {
    const channel = interaction.isChannelSelectMenu() ? interaction.channels.first() : null;
    const logChannel = await setWelcomeLogChannel(interaction.guild, interaction.user, channel);
    await interaction.editReply({ content: `Logs will go to ${logChannel}. The last step is waiting there.` });
  } catch (err) {
    if (!(err instanceof Refused)) console.error('Welcome log channel:', err);
    await interaction.editReply({ content: err instanceof Refused ? err.message : 'Something went wrong. Check I can post in that channel.' });
  }
}

export function registerTerms(client) {
  client.on(Events.GuildCreate, (guild) => {
    if (client.isReady() && termsLocked(guild)) welcome(guild).catch((err) => console.error(`Welcome (${guild.id}):`, err.message));
  });
  // Servers that added the bot while it was offline, or before this ran, get their welcome now.
  client.once(Events.ClientReady, async () => {
    for (const guild of client.guilds.cache.values()) {
      const terms = termsOf(guild.id);
      if (termsLocked(guild) && !terms?.welcomeMessageId && !terms?.promptMessageId && !terms?.ownerMessaged) await welcome(guild).catch(() => {});
    }
  });
}
