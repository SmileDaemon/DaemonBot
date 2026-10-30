import { ActionRowBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';

const BOT_NEEDS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * Returns an error message if the invoking member or the bot can't post in `channel`, otherwise null.
 * Stops people from using the bot to post somewhere they couldn't post themselves.
 */
export function checkPostAccess(interaction, channel, extra = []) {
  const memberPerms = channel.permissionsFor(interaction.member);
  if (!memberPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return `You don't have permission to post in ${channel}.`;
  }
  if (!channel.permissionsFor(interaction.guild.members.me)?.has([...BOT_NEEDS, ...extra])) {
    return `I need View Channel, Send Messages, Embed Links${extra.length ? ' and Attach Files' : ''} in ${channel}.`;
  }
  return null;
}

/** Builds a modal from a list of text input definitions. */
export function buildModal(customId, title, inputs) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      inputs.map(({ id, label, style = TextInputStyle.Short, required = false, max, placeholder, value }) => {
        const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
        if (max) input.setMaxLength(max);
        if (placeholder) input.setPlaceholder(placeholder);
        if (value) input.setValue(value);
        return new ActionRowBuilder().addComponents(input);
      }),
    );
}

/** Reads a modal field, returning null for blank values. */
export const field = (interaction, id) => interaction.fields.getTextInputValue(id).trim() || null;
