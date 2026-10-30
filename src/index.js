import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { loadCommands } from './loadCommands.js';
import { handleMessageQuotes } from './features/messageQuotes.js';
import { registerActivityTracker } from './features/activityTracker.js';
import { registerConnectionTracker } from './features/connectionTracker.js';
import { registerGameTracker } from './features/gameTracker.js';
import { registerServerLogs } from './features/serverLogs.js';
import { registerVoiceTracker } from './features/voiceTracker.js';
import { handleWordFilter, startWordFilter } from './features/wordFilter.js';
import { setupMusic } from './music/lavalink.js';
import { startPanel } from './panel/sync.js';
import { ephemeral } from './utils/replies.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const quotesEnabled = process.env.ENABLE_MESSAGE_QUOTES === 'true';
const filterEnabled = process.env.ENABLE_WORD_FILTER === 'true';
const serverLogsEnabled = process.env.ENABLE_SERVER_LOGS === 'true';
const musicEnabled = process.env.ENABLE_MUSIC === 'true';
const gamesEnabled = process.env.ENABLE_GAME_TRACKING === 'true';
const voiceEnabled = process.env.ENABLE_VOICE_TRACKING === 'true';
const activityEnabled = process.env.ENABLE_ACTIVITY_TRACKING === 'true';
const connectionsEnabled = process.env.ENABLE_CONNECTION_TRACKING === 'true';
const panelEnabled = Boolean(process.env.PANEL_URL && process.env.PANEL_SECRET);

const intents = new Set([GatewayIntentBits.Guilds]);
const partials = [];
// Message Content and Server Members are privileged intents, so only request them when a feature needs them.
if (quotesEnabled || filterEnabled || serverLogsEnabled) {
  intents.add(GatewayIntentBits.GuildMessages).add(GatewayIntentBits.MessageContent);
}
if (serverLogsEnabled) {
  intents
    .add(GatewayIntentBits.GuildMembers)
    .add(GatewayIntentBits.GuildModeration)
    .add(GatewayIntentBits.GuildInvites)
    .add(GatewayIntentBits.GuildExpressions)
    .add(GatewayIntentBits.GuildWebhooks)
    .add(GatewayIntentBits.AutoModerationExecution);
  // Lets deletes and leaves be logged even for messages/members the bot hadn't cached yet.
  partials.push(Partials.Message, Partials.GuildMember);
}
if (musicEnabled || voiceEnabled) intents.add(GatewayIntentBits.GuildVoiceStates);
// Counting messages doesn't need their content, so activity tracking alone needs no privileged intent.
// The trackers show each server's own members in the control panel, so they need the member list.
if (voiceEnabled || activityEnabled || connectionsEnabled) intents.add(GatewayIntentBits.GuildMembers);
// Replies and mentions arrive without Message Content, so connection tracking needs no extra privileged intent.
if (activityEnabled || connectionsEnabled) {
  intents.add(GatewayIntentBits.GuildMessages).add(GatewayIntentBits.GuildMessageReactions);
  // Reactions to messages sent before the bot started only arrive with these partials.
  partials.push(Partials.Message, Partials.Reaction, Partials.User);
}
// The control panel counts messages per channel; that doesn't need their content.
if (panelEnabled) intents.add(GatewayIntentBits.GuildMessages);
// Presence (what someone is playing) is a privileged intent too.
if (gamesEnabled) intents.add(GatewayIntentBits.GuildPresences).add(GatewayIntentBits.GuildMembers);

const client = new Client({ intents: [...intents], partials: [...new Set(partials)] });
client.commands = await loadCommands();
if (musicEnabled) setupMusic(client);
if (panelEnabled) startPanel(client);

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}, serving ${c.guilds.cache.size} server(s).`);
  // Server logs and game tracking fetch member lists themselves; the other trackers need them too.
  if ((voiceEnabled || activityEnabled || connectionsEnabled) && !serverLogsEnabled && !gamesEnabled) {
    for (const guild of c.guilds.cache.values()) guild.members.fetch().catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await client.commands.get(interaction.commandName)?.autocomplete?.(interaction);
    } else if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
      await client.commands.get(interaction.commandName)?.execute(interaction);
    } else if (interaction.isModalSubmit() || interaction.isButton()) {
      // Custom IDs are prefixed with the owning command's name, e.g. "embed:create:123" or "ticket:claim:456".
      const command = client.commands.get(interaction.customId.split(':')[0]);
      await (interaction.isButton() ? command?.handleButton?.(interaction) : command?.handleModal?.(interaction));
    }
  } catch (err) {
    console.error(`Error handling interaction ${interaction.customId ?? interaction.commandName}:`, err);
    if (!interaction.isRepliable()) return;
    const payload = ephemeral('Something went wrong running that command.');
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

if (filterEnabled) {
  startWordFilter();
  client.on(Events.MessageCreate, (message) => handleWordFilter(message).catch(console.error));
  // Catch people editing a slur into a message after sending it.
  client.on(Events.MessageUpdate, (before, after) => {
    if (!after.partial && before.content !== after.content) handleWordFilter(after).catch(console.error);
  });
}

if (quotesEnabled) {
  client.on(Events.MessageCreate, (message) => handleMessageQuotes(message).catch(console.error));
}

if (serverLogsEnabled) registerServerLogs(client);
if (gamesEnabled) registerGameTracker(client);
if (voiceEnabled) registerVoiceTracker(client);
if (activityEnabled) registerActivityTracker(client);
if (connectionsEnabled) registerConnectionTracker(client);

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

await client.login(process.env.DISCORD_TOKEN).catch((err) => {
  if (err.message.includes('disallowed intents')) {
    console.error(
      'Discord rejected a privileged intent. In the Developer Portal → Bot, turn on "Message Content Intent" ' +
        '(word filter, message previews, server logs), "Server Members Intent" (server logs) and ' +
        '"Presence Intent" (game tracking), ' +
        'or turn those features off in .env.',
    );
    process.exit(1);
  }
  throw err;
});
