import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { backupStats, latestBackup, restoreBackup, takeBackup } from '../../features/backups.js';
import { cleanUp, endLockdown, MODULES, ROLE_HINT, securityStatus, startLockdown, verifyMember } from '../../features/security.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { Refused } from '../../utils/refused.js';
import { ephemeral, notice } from '../../utils/replies.js';

const off = () => process.env.ENABLE_SECURITY !== 'true';

async function lockdown(interaction) {
  const turnOn = interaction.options.getString('state', true) === 'on';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const changed = turnOn ? await startLockdown(interaction.guild, { by: interaction.user.tag }) : await endLockdown(interaction.guild, interaction.user.tag);
  await interaction.editReply(
    notice(
      changed
        ? turnOn
          ? "🔒 Locked down: @everyone can't post, verification is High and invites are paused. Run `/security lockdown state:off` to undo it."
          : '🔓 Lockdown over: posting, verification and invites are back as they were.'
        : turnOn ? 'The server is already locked down.' : "The server isn't locked down.",
      { tone: changed ? 'success' : 'info' },
    ),
  );
}

async function backup(interaction) {
  const b = takeBackup(interaction.guild, 'manual');
  await interaction.reply(ephemeral(`Backed up ${b.roles.length} roles and ${b.channels.length} channels. The newest 10 backups are kept.`, 'success'));
  await logEvent(interaction.guild, { title: '🛡️ Backup taken', color: COLORS.info, user: interaction.user });
}

async function restore(interaction) {
  if (!latestBackup(interaction.guild.id)) return interaction.reply(ephemeral('There are no backups yet. Run `/security backup` first.'));
  const { missing } = backupStats(interaction.guild);
  if (!missing.roles.length && !missing.channels.length) return interaction.reply(ephemeral('Nothing from the latest backup is missing.', 'success'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await restoreBackup(interaction.guild);
  await interaction.editReply(
    notice(
      `Made again: **${result.roles}** role(s) and **${result.channels}** channel(s), with their permissions.${result.failed ? ` ${result.failed} couldn't be made; ${ROLE_HINT}` : ''} Messages can't be restored.`,
      { tone: result.failed ? 'warn' : 'success', title: 'Restored from backup' },
    ),
  );
  await logEvent(interaction.guild, { title: '🛡️ Restored from backup', color: COLORS.info, user: interaction.user, fields: [{ name: 'Made again', value: `${result.roles} roles, ${result.channels} channels`, inline: true }] });
}

async function status(interaction) {
  const s = securityStatus(interaction.guild);
  const b = backupStats(interaction.guild);
  const lines = Object.entries(MODULES).map(([key, m]) => `${s.modules[key] ? '🟢' : '⚫'} ${m.label}${m.reaction ? ' (during raids)' : ''}`);
  const extra = [
    s.raid ? `🚨 Raid mode on since <t:${Math.floor(s.raid.startedAt / 1000)}:R>` : null,
    s.lockdown ? '🔒 Locked down' : null,
    `Backups: ${b.count}${b.list[0] ? `, latest <t:${Math.floor(b.list[0].at / 1000)}:R>` : ''}`,
    s.hasLogChannel ? null : '⚠️ No log channel, so alerts have nowhere to go. Set one with `/setup logs`.',
    s.roleTop ? null : `⚠️ ${ROLE_HINT}`,
  ].filter(Boolean);
  await interaction.reply(ephemeral(`${lines.join('\n')}\n\n${extra.join('\n')}\n\nTurn protections on and off in the control panel's Security tab.`, 'info'));
}

const RUN = { lockdown, backup, restore, status };

export default {
  data: new SlashCommandBuilder()
    .setName('security')
    .setDescription('Admins: raid protection: lockdown, backups and status')
    .addSubcommand((s) =>
      s
        .setName('lockdown')
        .setDescription("Stop @everyone posting, raise verification and pause invites, or undo it")
        .addStringOption((o) => o.setName('state').setDescription('On or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    )
    .addSubcommand((s) => s.setName('backup').setDescription('Back up channels, roles and permissions now'))
    .addSubcommand((s) => s.setName('restore').setDescription('Make again any channels and roles from the latest backup that are gone'))
    .addSubcommand((s) => s.setName('status').setDescription('Which protections are on, and backups and raids'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (off()) return interaction.reply(ephemeral("Raid protection is turned off in the bot's .env."));
    return RUN[interaction.options.getSubcommand()](interaction);
  },

  // "security:verify" (the join gate) and "security:cleanup:<raid>:<kick|ban>" (the raid cleanup offer).
  async handleButton(interaction) {
    const [, action, raidId, how] = interaction.customId.split(':');
    try {
      if (action === 'verify') return interaction.reply(ephemeral(await verifyMember(interaction.member), 'success'));
      if (action === 'cleanup') {
        const needed = how === 'ban' ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
        if (!interaction.memberPermissions.has(needed)) return interaction.reply(ephemeral(`You need ${how === 'ban' ? 'Ban' : 'Kick'} Members for that.`));
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const done = await cleanUp(interaction.guild, raidId, how);
        await interaction.editReply(notice(`${how === 'ban' ? 'Banned' : 'Kicked'} ${done} raid account(s).`, { tone: 'success' }));
        await interaction.message.edit({ components: [] }).catch(() => {});
        await logEvent(interaction.guild, { title: `🛡️ Raid cleanup: ${done} ${how === 'ban' ? 'banned' : 'kicked'}`, color: COLORS.ban, user: interaction.user });
      }
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      const payload = ephemeral(err.message);
      if (interaction.deferred) await interaction.editReply(payload);
      else await interaction.reply(payload);
    }
  },
};
