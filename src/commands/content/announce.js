import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputStyle,
} from 'discord.js';
import { buildModal, checkPostAccess, field } from '../../utils/embeds.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral, notice } from '../../utils/moderation.js';
import { defaultColor, parseColor } from '../../utils/parse.js';

// Slash command options can't carry multi-line text, so the text is collected in a modal.
// The other options are held here until the modal comes back (or expire after 15 minutes).
const pending = new Map();
const PENDING_TTL = 15 * 60_000;

export default {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post an announcement (opens a form for the text)')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Where to post it')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping with the announcement'))
    .addBooleanOption((o) => o.setName('ping_everyone').setDescription('Ping @everyone'))
    .addAttachmentOption((o) => o.setName('image').setDescription('Image to show in the announcement'))
    .addStringOption((o) => o.setName('color').setDescription('Embed color as hex, e.g. #ff8800'))
    .addBooleanOption((o) =>
      o.setName('publish').setDescription('In announcement channels, publish to following servers (default: yes)'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('ping_role');
    const pingEveryone = interaction.options.getBoolean('ping_everyone') ?? false;
    const image = interaction.options.getAttachment('image');
    const colorInput = interaction.options.getString('color');
    const color = colorInput ? parseColor(colorInput) : defaultColor;

    if (color === null) return interaction.reply(ephemeral(`\`${colorInput}\` isn't a valid hex color. Try something like \`#ff8800\`.`));
    if (image && !image.contentType?.startsWith('image/')) return interaction.reply(ephemeral('The attachment must be an image.'));

    const error = checkPostAccess(interaction, channel, image ? [PermissionFlagsBits.AttachFiles] : []);
    if (error) return interaction.reply(ephemeral(error));

    // Don't let the bot ping on behalf of someone who couldn't ping themselves.
    const canMentionAll = channel.permissionsFor(interaction.member).has(PermissionFlagsBits.MentionEveryone);
    if ((pingEveryone || (role && !role.mentionable)) && !canMentionAll) {
      return interaction.reply(ephemeral(`You need the Mention @everyone permission in ${channel} to send that ping.`));
    }

    pending.set(interaction.id, { channelId: channel.id, roleId: role?.id, pingEveryone, image, color, publish: interaction.options.getBoolean('publish') ?? true });
    setTimeout(() => pending.delete(interaction.id), PENDING_TTL).unref();

    await interaction.showModal(
      buildModal(`announce:${interaction.id}`, `Announcement in #${channel.name}`.slice(0, 45), [
        { id: 'title', label: 'Title', max: 256 },
        { id: 'message', label: 'Announcement', style: TextInputStyle.Paragraph, required: true, max: 4000 },
      ]),
    );
  },

  async handleModal(interaction) {
    const key = interaction.customId.split(':')[1];
    const options = pending.get(key);
    if (!options) return interaction.reply(ephemeral('That form expired. Run /announce again.'));
    pending.delete(key);

    await interaction.deferReply(ephemeral());
    const channel = await interaction.guild.channels.fetch(options.channelId);

    const embed = new EmbedBuilder()
      .setTitle(field(interaction, 'title'))
      .setDescription(field(interaction, 'message'))
      .setColor(options.color)
      .setFooter({ text: `Posted by ${interaction.member.displayName}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    // Re-upload the image instead of linking it: interaction attachment URLs expire.
    const files = [];
    if (options.image) {
      files.push({ attachment: options.image.url, name: options.image.name });
      embed.setImage(`attachment://${options.image.name}`);
    }

    const mentions = [options.pingEveryone && '@everyone', options.roleId && `<@&${options.roleId}>`].filter(Boolean);
    const message = await channel.send({
      content: mentions.join(' ') || undefined,
      embeds: [embed],
      files,
      allowedMentions: { parse: options.pingEveryone ? ['everyone'] : [], roles: options.roleId ? [options.roleId] : [] },
    });

    let note = '';
    if (channel.type === ChannelType.GuildAnnouncement && options.publish) {
      note = await message.crosspost().then(
        () => ' and published to following servers',
        () => " (couldn't publish it; I need Manage Messages in that channel)",
      );
    }
    await interaction.editReply(notice(`📣 Announcement posted${note}: ${message.url}`, { tone: 'success' }));
    await logEvent(interaction.guild, {
      title: 'Announcement posted',
      color: COLORS.info,
      user: interaction.user,
      fields: [
        { name: 'Channel', value: `${channel}`, inline: true },
        { name: 'Pinged', value: mentions.join(' ') || 'Nobody', inline: true },
        { name: 'Message', value: message.url },
      ],
    });
  },
};
