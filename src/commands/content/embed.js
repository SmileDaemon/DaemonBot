import { ChannelType, EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, TextInputStyle } from 'discord.js';
import { buildModal, checkPostAccess, field } from '../../utils/embeds.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral } from '../../utils/moderation.js';
import { MESSAGE_LINK, defaultColor, isHttpUrl, parseColor } from '../../utils/parse.js';

/** If the embed's image is a file attached to the message (e.g. from /announce), returns that attachment. */
function attachedImage(message, embed) {
  if (!embed?.image?.url) return null;
  const imagePath = new URL(embed.image.url).pathname;
  return message.attachments.find((a) => new URL(a.url).pathname === imagePath) ?? null;
}

function embedModal(customId, title, existing, attachment) {
  return buildModal(customId, title, [
    { id: 'title', label: 'Title', max: 256, value: existing?.title },
    { id: 'description', label: 'Text', style: TextInputStyle.Paragraph, required: true, max: 4000, value: existing?.description },
    { id: 'color', label: 'Color (hex, e.g. #ff8800)', max: 7, placeholder: '#5865F2', value: existing?.hexColor },
    // Attached images are shown as attachment://name: the real CDN link is long and expires.
    { id: 'image', label: 'Image URL', placeholder: 'https://…', value: attachment ? `attachment://${attachment.name}` : existing?.image?.url },
    { id: 'footer', label: 'Footer', max: 2048, value: existing?.footer?.text },
  ]);
}

/** Opens the edit form for a message the bot posted. Shared by /embed edit and the "Edit Embed" right-click menu. */
export async function openEditModal(interaction, message) {
  if (message.author.id !== interaction.client.user.id || !message.embeds.length) {
    return interaction.reply(ephemeral('I can only edit embeds that I posted.'));
  }
  const error = checkPostAccess(interaction, message.channel);
  if (error) return interaction.reply(ephemeral(error));

  const [embed] = message.embeds;
  await interaction.showModal(
    embedModal(`embed:edit:${message.channelId}:${message.id}`, 'Edit embed', embed, attachedImage(message, embed)),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Post or edit a custom embed message')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Write a new embed and post it')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Where to post it (defaults to this channel)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Edit an embed or announcement this bot posted, using its message link')
        .addStringOption((o) =>
          o.setName('message_link').setDescription('Right-click the message → Copy Message Link').setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (interaction.options.getSubcommand() === 'create') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const error = checkPostAccess(interaction, channel);
      if (error) return interaction.reply(ephemeral(error));
      return interaction.showModal(embedModal(`embed:create:${channel.id}`, `New embed in #${channel.name}`.slice(0, 45)));
    }

    const [, guildId, channelId, messageId] = [...interaction.options.getString('message_link', true).matchAll(MESSAGE_LINK)][0] ?? [];
    if (!guildId) return interaction.reply(ephemeral('That isn\'t a message link. Right-click the message → **Copy Message Link**.'));
    if (guildId !== interaction.guild.id) return interaction.reply(ephemeral('That needs to be a link to a message in this server.'));

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (!message) return interaction.reply(ephemeral("I couldn't find that message. It may have been deleted, or I can't see that channel."));

    await openEditModal(interaction, message);
  },

  async handleModal(interaction) {
    const [, mode, channelId, messageId] = interaction.customId.split(':');
    const channel = await interaction.guild.channels.fetch(channelId);
    const message = mode === 'edit' ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (mode === 'edit' && !message) return interaction.reply(ephemeral('That message no longer exists.'));

    const colorInput = field(interaction, 'color');
    const color = colorInput ? parseColor(colorInput) : defaultColor;
    if (color === null) return interaction.reply(ephemeral(`\`${colorInput}\` isn't a valid hex color. Try something like \`#ff8800\`.`));

    const image = field(interaction, 'image');
    const keepsAttachment = image?.startsWith('attachment://') && message?.attachments.some((a) => `attachment://${a.name}` === image);
    if (image && !keepsAttachment && !isHttpUrl(image)) {
      return interaction.reply(ephemeral('The image needs to be a full link starting with https://'));
    }

    // When editing, start from the existing embed so anything the form doesn't cover
    // (timestamp, author, footer icon, fields) is kept.
    const existing = message?.embeds[0];
    const footer = field(interaction, 'footer');
    const embed = (existing ? EmbedBuilder.from(existing) : new EmbedBuilder())
      .setTitle(field(interaction, 'title'))
      .setDescription(field(interaction, 'description'))
      .setColor(color)
      .setImage(image)
      .setFooter(footer ? { text: footer, iconURL: existing?.footer?.iconURL } : null);

    const posted = message
      ? await message.edit({ embeds: [embed, ...message.embeds.slice(1)] })
      : await channel.send({ embeds: [embed] });
    await interaction.reply(ephemeral(`Embed ${message ? 'updated' : 'posted'}: ${posted.url}`, 'success'));
    await logEvent(interaction.guild, {
      title: message ? 'Embed edited' : 'Embed posted',
      color: COLORS.info,
      user: interaction.user,
      fields: [
        { name: 'Channel', value: `${channel}`, inline: true },
        { name: 'Message', value: posted.url, inline: true },
      ],
    });
  },
};
