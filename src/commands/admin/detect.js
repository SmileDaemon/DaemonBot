import { EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defaultColor } from '../../utils/parse.js';

/** What this bot does in place of others, and how to set each up. */
const FEATURES = {
  moderation: 'Moderation: `/warn`, `/timeout`, `/kick`, `/ban`, `/purge`, `/channel lock`',
  logging: 'Logging: `/setup logs`',
  filter: 'Word filter: `/config filter`',
  levels: 'Levels and leaderboard: `/levels`, `/level`, `/leaderboard`',
  tickets: 'Tickets: `/setup tickets`',
  stats: 'Server stats channels: `/setup serverstats`',
  tempvoice: 'Temporary voice channels: `/setup tempvoice`',
  embeds: 'Embeds and announcements: `/embed`, `/announce`',
};

/**
 * Well-known bots this one overlaps with, by application ID, with a name to fall back on for copies and
 * renamed instances. `replaces` are FEATURES keys; `keeps` is what it does that this bot doesn't.
 */
const KNOWN = [
  { name: 'MEE6', ids: ['159985870458322944'], replaces: ['levels', 'moderation', 'logging', 'filter', 'embeds'], keeps: 'welcome messages, reaction roles, custom commands' },
  { name: 'Dyno', ids: ['155149108183695360'], replaces: ['moderation', 'logging', 'filter', 'embeds'], keeps: 'autoroles, custom commands, reaction roles' },
  { name: 'Carl-bot', ids: ['235148962103951360'], replaces: ['moderation', 'logging', 'filter', 'embeds'], keeps: 'reaction roles, tags, welcome messages' },
  { name: 'YAGPDB', ids: ['204255221017214977'], replaces: ['moderation', 'logging', 'filter'], keeps: 'custom commands, role menus, feeds' },
  { name: 'ProBot', ids: ['282859044593598464'], replaces: ['levels', 'moderation', 'logging', 'filter'], keeps: 'welcome images, auto-responses' },
  { name: 'Zeppelin', ids: ['473868086773153793'], replaces: ['moderation', 'logging', 'filter'], keeps: 'its case history (export it before removing)' },
  { name: 'Ticket Tool', ids: ['557628352828014614'], replaces: ['tickets'], keeps: 'ticket transcripts' },
  { name: 'Tickets', ids: ['508391840525975553'], replaces: ['tickets'], keeps: 'ticket transcripts' },
  { name: 'Arcane', ids: ['437808476106784770'], replaces: ['levels'] },
  { name: 'Tatsu', ids: ['172002275412279296'], replaces: ['levels'], keeps: 'its economy and profiles' },
  { name: 'Amari', ids: ['339254240012664832'], replaces: ['levels'], keeps: 'weekly leaderboards' },
  { name: 'Lurkr', ids: [], replaces: ['levels'] },
  { name: 'Statbot', ids: ['491769129318088714'], replaces: ['stats'], keeps: 'its long-term charts (the control panel has 400 days of daily counts)' },
  { name: 'ServerStats', ids: ['458276816071950337'], replaces: ['stats'] },
  { name: 'VoiceMaster', ids: ['472911936951156740'], replaces: ['tempvoice'] },
  { name: 'TempVoice', ids: [], replaces: ['tempvoice'] },
  { name: 'Wick', ids: ['536991182035746816'], replaces: [], keeps: 'anti-raid and anti-nuke protection, which this bot does not do, so keep it' },
];

const squash = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
function recognise(user) {
  return KNOWN.find((k) => k.ids.includes(user.id)) ?? KNOWN.find((k) => squash(user.username) === squash(k.name));
}

/** What to set up here, what that bot still does, and the steps to retire it. */
function botField(member, known) {
  const lines = known.replaces.length ? known.replaces.map((f) => `• ${FEATURES[f]}`) : ['• Nothing here overlaps.'];
  if (known.keeps) lines.push(`Not covered here: ${known.keeps}.`);
  return { name: `${known.name} · ${member.user.tag}`, value: lines.join('\n').slice(0, 1024) };
}

const STEPS = [
  '**1. Set up the replacements.** Run `/setup full` for the defaults, or the `/setup` command for each feature listed above. Put my role above any roles I hand out (level rewards) or moderate.',
  "**2. Turn off the overlapping parts of the old bot**, in its dashboard or settings, one feature at a time. Running both means double level-up messages, logs and moderation, and two bots fighting over the same channels.",
  "**3. Run side by side for a few days** with only my versions on. Let open tickets in the old bot finish rather than moving them.",
  "**4. Bring over what you can.** Levels don't transfer automatically; set your top members with `/levels setxp`. Copy any warnings or case notes you need to keep.",
  '**5. Clean up its leftovers:** its ticket panel, stat channels and "join to create" channel, and any channels it made that you no longer use.',
  "**6. Remove the old bot:** Server Settings → Members, find it, then **Kick**. Then delete its role in Server Settings → Roles if it's left behind.",
];

export default {
  data: new SlashCommandBuilder()
    .setName('detect')
    .setDescription('Admins: find other bots in this server and how to switch from them to this one')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { guild } = interaction;
    // Bots are often missing from the member cache, so ask Discord for the full list when possible.
    const members = await guild.members.fetch().catch(() => guild.members.cache);
    const bots = members.filter((m) => m.user.bot && m.id !== guild.members.me.id);

    const known = [];
    const unknown = [];
    for (const member of bots.values()) {
      const match = recognise(member.user);
      if (match) known.push([member, match]);
      else unknown.push(member);
    }

    const overlapping = known.filter(([, k]) => k.replaces.length).length;
    const summary = new EmbedBuilder()
      .setTitle(`Other bots in ${guild.name}`)
      .setColor(defaultColor)
      .setDescription(
        bots.size
          ? `I found **${bots.size}** other bot${bots.size === 1 ? '' : 's'}. ${overlapping ? `${overlapping} overlap${overlapping === 1 ? 's' : ''} with what I do; here's what I can take over from each.` : known.length ? 'None of them overlap with what I do.' : "None of them are ones I know, so check each one's features against mine below."}`
          : "I didn't find any other bots here, so there's nothing to phase out. Run `/setup full` to get started.",
      );
    // A message holds 6000 characters across its embeds, so only the first few get the full breakdown.
    for (const [member, match] of known.slice(0, 8)) summary.addFields(botField(member, match));
    if (known.length > 8) {
      summary.addFields({ name: `Also recognised (${known.length - 8})`, value: known.slice(8).map(([m, k]) => `${k.name} (${m})`).join(', ').slice(0, 1024) });
    }
    if (unknown.length) {
      summary.addFields({
        name: `Not recognised (${unknown.length})`,
        value: `${unknown.slice(0, 30).map((m) => `${m}`).join(', ')}${unknown.length > 30 ? ', …' : ''}\nCompare what each does with \`/help\` before removing it.`.slice(0, 1024),
      });
    }

    const embeds = [summary];
    if (known.some(([, m]) => m.replaces.length) || unknown.length) {
      embeds.push(new EmbedBuilder().setTitle('Switching over').setColor(defaultColor).setDescription(STEPS.join('\n\n')));
    }
    await interaction.editReply({ embeds });
  },
};
