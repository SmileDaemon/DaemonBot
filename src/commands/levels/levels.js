import { ChannelType, EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  applyRewards,
  DEFAULT_LEVEL_MESSAGE,
  levelFromXp,
  levelMessage,
  levelSettings,
  levelsIn,
  saveLevelSettings,
  setXp,
  XP_DEFAULTS,
} from '../../features/levels.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { ephemeral } from '../../utils/replies.js';
import { defaultColor } from '../../utils/parse.js';
import { isOptedOut } from '../../utils/store.js';

const xpText = (xp) =>
  [
    xp.messageMax ? `${xp.messageMin === xp.messageMax ? xp.messageMax : `${xp.messageMin}–${xp.messageMax}`} per message (every ${xp.cooldownSeconds}s at most)` : 'none for messages',
    xp.voicePerMinute ? `${xp.voicePerMinute} per minute in voice with others` : 'none for voice',
  ].join(', ');

const announceText = (mode) => (mode === 'off' ? 'Off' : mode === 'here' ? 'In the channel where they levelled up' : `<#${mode}>`);

export default {
  data: new SlashCommandBuilder()
    .setName('levels')
    .setDescription('Set up levels for this server')
    .addSubcommand((s) =>
      s
        .setName('enable')
        .setDescription('Turn levels on or off in this server')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('announce')
        .setDescription('Choose where level-ups are announced')
        .addStringOption((o) =>
          o
            .setName('where')
            .setDescription('Where to post them')
            .setRequired(true)
            .addChoices(
              { name: 'Where they levelled up', value: 'here' },
              { name: 'A set channel', value: 'channel' },
              { name: "Don't announce", value: 'off' },
            ),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('The channel, if "A set channel"').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('xp')
        .setDescription('Change how much XP members earn (leave an option out to keep it)')
        .addIntegerOption((o) => o.setName('message-min').setDescription(`Least XP per message (default ${XP_DEFAULTS.messageMin})`).setMinValue(0).setMaxValue(1000))
        .addIntegerOption((o) => o.setName('message-max').setDescription(`Most XP per message (default ${XP_DEFAULTS.messageMax}; 0 = none)`).setMinValue(0).setMaxValue(1000))
        .addIntegerOption((o) =>
          o.setName('cooldown').setDescription(`Seconds before another message earns XP (default ${XP_DEFAULTS.cooldownSeconds})`).setMinValue(0).setMaxValue(3600),
        )
        .addIntegerOption((o) => o.setName('voice').setDescription(`XP per minute in voice with others (default ${XP_DEFAULTS.voicePerMinute}; 0 = none)`).setMinValue(0).setMaxValue(1000))
        .addBooleanOption((o) => o.setName('reset').setDescription('Go back to the defaults')),
    )
    .addSubcommand((s) =>
      s
        .setName('message')
        .setDescription('Change the level-up message. Placeholders: {user} {name} {level} {roles} {server}')
        .addStringOption((o) => o.setName('text').setDescription('The message (leave out to go back to the default)').setMaxLength(1000)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('reward')
        .setDescription('Roles given at a level')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Give a role when members reach a level (also to everyone already there)')
            .addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1).setMaxValue(500))
            .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Stop giving a level reward (members keep roles they already have)')
            .addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1).setMaxValue(500)),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('setxp')
        .setDescription("Set a member's XP")
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('xp').setDescription('Total XP').setRequired(true).setMinValue(0).setMaxValue(100_000_000)),
    )
    .addSubcommand((s) => s.setName('view').setDescription('Show the level settings and rewards'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const { guild } = interaction;
    if (process.env.ENABLE_LEVELS !== 'true') return interaction.reply(ephemeral("Levels are turned off for the whole bot (ENABLE_LEVELS in the bot's .env)."));
    const settings = levelSettings(guild.id);
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    const log = (title, fields = []) => logEvent(guild, { title, color: COLORS.info, user: interaction.user, fields });

    if (sub === 'view') {
      const rewards = Object.entries(settings.rewards).sort(([a], [b]) => a - b);
      const embed = new EmbedBuilder()
        .setTitle(`Levels in ${guild.name}`)
        .setColor(defaultColor)
        .addFields(
          { name: 'Levels', value: settings.enabled ? 'On' : 'Off', inline: true },
          { name: 'Level-up messages', value: announceText(settings.announce), inline: true },
          { name: 'XP', value: xpText(settings.xp) },
          { name: 'Level-up message', value: `\`${settings.message ?? DEFAULT_LEVEL_MESSAGE}\`${settings.message ? '' : ' (default)'}` },
          { name: 'Rewards', value: rewards.length ? rewards.map(([lvl, id]) => `Level ${lvl}: <@&${id}>`).join('\n') : 'None (`/levels reward add`)' },
        );
      return interaction.reply({ embeds: [embed], ...ephemeral() });
    }

    if (sub === 'xp') {
      const opt = (name) => interaction.options.getInteger(name);
      let xp;
      if (interaction.options.getBoolean('reset')) xp = { ...XP_DEFAULTS };
      else {
        xp = { ...settings.xp };
        for (const [option, key] of [['message-min', 'messageMin'], ['message-max', 'messageMax'], ['cooldown', 'cooldownSeconds'], ['voice', 'voicePerMinute']]) {
          if (opt(option) !== null) xp[key] = opt(option);
        }
        if (xp.messageMin > xp.messageMax) return interaction.reply(ephemeral(`The least XP per message (${xp.messageMin}) can't be more than the most (${xp.messageMax}).`));
      }
      saveLevelSettings(guild.id, { xp });
      await interaction.reply(ephemeral(`XP is now: ${xpText(xp)}.`, 'success'));
      return log('Level XP changed', [{ name: 'XP', value: xpText(xp) }]);
    }

    if (sub === 'message') {
      const text = interaction.options.getString('text')?.trim() || null;
      saveLevelSettings(guild.id, { message: text });
      const preview = levelMessage(text, { member: interaction.member, level: 5 });
      await interaction.reply(ephemeral(`Level-up message ${text ? 'set' : 'back to the default'}. It will look like this:\n\n${preview}`, 'success'));
      return log('Level-up message changed', [{ name: 'Message', value: (text ?? `${DEFAULT_LEVEL_MESSAGE} (default)`).slice(0, 1024) }]);
    }

    if (sub === 'enable') {
      const enabled = interaction.options.getBoolean('enabled', true);
      saveLevelSettings(guild.id, { enabled });
      await interaction.reply(ephemeral(enabled ? 'Levels are on. Members earn XP from messages and voice.' : 'Levels are off. XP is kept and counts again if you turn them back on.', 'success'));
      return log(`Levels turned ${enabled ? 'on' : 'off'}`);
    }

    if (sub === 'announce') {
      const where = interaction.options.getString('where', true);
      const channel = interaction.options.getChannel('channel');
      if (where === 'channel') {
        if (!channel) return interaction.reply(ephemeral('Pick the channel too.'));
        if (!channel.permissionsFor(guild.members.me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
          return interaction.reply(ephemeral(`I need View Channel and Send Messages in ${channel} first.`));
        }
      }
      const announce = where === 'channel' ? channel.id : where;
      saveLevelSettings(guild.id, { announce });
      await interaction.reply(ephemeral(`Level-up messages: ${announceText(announce)}.`, 'success'));
      return log('Level-up messages changed', [{ name: 'Where', value: announceText(announce) }]);
    }

    if (group === 'reward' && sub === 'add') {
      const level = interaction.options.getInteger('level', true);
      const role = interaction.options.getRole('role', true);
      if (role.managed || role.id === guild.id) return interaction.reply(ephemeral("That role can't be given out."));
      if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
        return interaction.reply(ephemeral(`I need Manage Roles, and my highest role must be above ${role}.`));
      }
      saveLevelSettings(guild.id, { rewards: { ...settings.rewards, [level]: role.id } });
      await interaction.deferReply(ephemeral());
      // Members already at or past that level get it now.
      let given = 0;
      for (const [userId, rec] of Object.entries(levelsIn(guild.id))) {
        const member = guild.members.cache.get(userId);
        if (member && levelFromXp(rec.xp).level >= level && (await applyRewards(member, levelFromXp(rec.xp).level)).length) given++;
      }
      await interaction.editReply(ephemeral(`Members reaching level ${level} get ${role}.${given ? ` Gave it to ${given} member${given === 1 ? '' : 's'} already there.` : ''}`, 'success'));
      return log('Level reward added', [{ name: 'Level', value: String(level), inline: true }, { name: 'Role', value: `${role}`, inline: true }]);
    }

    if (group === 'reward' && sub === 'remove') {
      const level = interaction.options.getInteger('level', true);
      if (!settings.rewards[level]) return interaction.reply(ephemeral(`There's no reward at level ${level}.`));
      const rewards = { ...settings.rewards };
      delete rewards[level];
      saveLevelSettings(guild.id, { rewards });
      await interaction.reply(ephemeral(`Removed the level ${level} reward. Members who have the role keep it.`, 'success'));
      return log('Level reward removed', [{ name: 'Level', value: String(level) }]);
    }

    if (sub === 'setxp') {
      const member = interaction.options.getMember('member');
      if (!member) return interaction.reply(ephemeral("That person isn't in this server."));
      if (member.user.bot) return interaction.reply(ephemeral("Bots don't earn levels."));
      if (isOptedOut(guild.id, member.id)) return interaction.reply(ephemeral(`${member} has opted out of statistics in this server.`));
      const xp = interaction.options.getInteger('xp', true);
      const level = await setXp(member, xp, null);
      await interaction.reply(ephemeral(`${member} now has ${xp.toLocaleString()} XP (level ${level}).`, 'success'));
      return log('XP set', [{ name: 'Member', value: `${member}`, inline: true }, { name: 'XP', value: xp.toLocaleString(), inline: true }]);
    }
  },
};
