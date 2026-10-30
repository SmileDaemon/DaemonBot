import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), 'commands');

/** Imports every file under src/commands and returns a Map of command name -> command module. */
export async function loadCommands() {
  const commands = new Map();
  for (const file of readdirSync(commandsDir, { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const { default: command } = await import(pathToFileURL(join(commandsDir, file)).href);
    if (!command?.data || !command?.execute) {
      console.warn(`Skipping ${file}: it must export default { data, execute }.`);
      continue;
    }
    commands.set(command.data.name, command);
  }
  return commands;
}
