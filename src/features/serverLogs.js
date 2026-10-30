import { registerAutoModLogs } from './logs/automod.js';
import { listen } from './logs/helpers.js';
import { registerInviteLogs } from './logs/invites.js';
import { registerMemberLogs } from './logs/members.js';
import { registerMessageLogs } from './logs/messages.js';
import { registerServerStructureLogs } from './logs/server.js';

/** Logs member, message, invite, channel, role, server-setting, emoji, webhook and AutoMod events to each server's log channel. */
export function registerServerLogs(client) {
  const on = listen(client);
  registerMemberLogs(client, on);
  registerMessageLogs(client, on);
  registerInviteLogs(client, on);
  registerServerStructureLogs(client, on);
  registerAutoModLogs(client, on);
}
