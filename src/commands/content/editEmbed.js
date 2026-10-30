import { ApplicationCommandType, ContextMenuCommandBuilder, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import { openEditModal } from './embed.js';

// Right-click a bot message → Apps → Edit Embed. Same form as /embed edit, without copying the link.
export default {
  data: new ContextMenuCommandBuilder()
    .setName('Edit Embed')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),

  execute: (interaction) => openEditModal(interaction, interaction.targetMessage),
};
