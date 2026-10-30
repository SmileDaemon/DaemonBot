import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { MESSAGE_LINK, defaultColor } from '../utils/parse.js';

const MAX_QUOTES_PER_MESSAGE = 3;
const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

/** When someone posts a link to a message in the same server, reply with a preview of that message. */
export async function handleMessageQuotes(message) {
  if (message.author.bot || !message.inGuild()) return;

  const links = [...message.content.matchAll(MESSAGE_LINK)]
    .filter(([, guildId]) => guildId === message.guild.id)
    .slice(0, MAX_QUOTES_PER_MESSAGE);
  if (!links.length) return;

  const embeds = [];
  const buttons = [];
  for (const [, , channelId, messageId] of links) {
    const channel = await message.guild.channels.fetch(channelId).catch(() => null);
    // Only quote from channels the poster can read, so private channels can't be leaked into public ones.
    if (!channel?.isTextBased() || !channel.permissionsFor(message.member)?.has(READ)) continue;
    if (!channel.permissionsFor(message.guild.members.me)?.has(READ)) continue;

    const quoted = await channel.messages.fetch(messageId).catch(() => null);
    if (!quoted) continue;

    const image = quoted.attachments.find((a) => a.contentType?.startsWith('image/'));
    const embed = new EmbedBuilder()
      .setAuthor({ name: quoted.member?.displayName ?? quoted.author.username, iconURL: quoted.author.displayAvatarURL() })
      .setDescription(quoted.content.slice(0, 4000) || (quoted.embeds.length ? '*[embed]*' : '*[no text]*'))
      .setColor(quoted.member?.displayColor || defaultColor)
      .setFooter({ text: `#${channel.name}` })
      .setTimestamp(quoted.createdAt);
    if (image) embed.setImage(image.url);

    embeds.push(embed);
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to message').setURL(quoted.url));
  }

  if (!embeds.length) return;
  await message.reply({
    embeds,
    components: [new ActionRowBuilder().addComponents(buttons)],
    allowedMentions: { repliedUser: false },
  });
}
