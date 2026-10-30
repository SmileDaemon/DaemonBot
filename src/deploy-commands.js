import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadCommands } from './loadCommands.js';

const { DISCORD_TOKEN, CLIENT_ID, DEV_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be set in .env');
  process.exit(1);
}

const body = [...(await loadCommands()).values()].map((command) => command.data.toJSON());
const route = DEV_GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

await new REST().setToken(DISCORD_TOKEN).put(route, { body });
console.log(`Registered ${body.length} commands ${DEV_GUILD_ID ? `to server ${DEV_GUILD_ID}` : 'globally'}.`);
