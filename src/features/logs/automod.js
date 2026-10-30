import { AutoModerationActionType, AutoModerationRuleTriggerType, Events } from 'discord.js';
import { COLORS, logEvent } from '../../utils/logging.js';
import { truncate } from './helpers.js';

const ACTIONS = {
  [AutoModerationActionType.BlockMessage]: 'Blocked the message',
  [AutoModerationActionType.SendAlertMessage]: 'Sent an alert',
  [AutoModerationActionType.Timeout]: 'Timed out',
  [AutoModerationActionType.BlockMemberInteraction]: 'Blocked from interacting',
};
const TRIGGERS = {
  [AutoModerationRuleTriggerType.Keyword]: 'Custom keyword',
  [AutoModerationRuleTriggerType.Spam]: 'Suspected spam',
  [AutoModerationRuleTriggerType.KeywordPreset]: 'Commonly flagged words',
  [AutoModerationRuleTriggerType.MentionSpam]: 'Mention spam',
  [AutoModerationRuleTriggerType.MemberProfile]: 'Member profile',
};

/** Logs Discord's built-in AutoMod. One trigger fires an event per action, so those are collected into one entry. */
export function registerAutoModLogs(client, on) {
  const pending = new Map();

  on(Events.AutoModerationActionExecution, (execution) => {
    const key = `${execution.guild.id}:${execution.ruleId}:${execution.userId}:${execution.content}`;
    const existing = pending.get(key);
    if (existing) return void existing.executions.push(execution);
    pending.set(key, { executions: [execution] });
    setTimeout(() => {
      const { executions } = pending.get(key);
      pending.delete(key);
      flush(executions).catch(console.error);
    }, 1500).unref();
  });

  async function flush(executions) {
    const [first] = executions;
    const { guild } = first;
    // Rule names need Manage Server to fetch.
    const rule = first.autoModerationRule ?? (await guild.autoModerationRules.fetch(first.ruleId).catch(() => null));
    const user = await client.users.fetch(first.userId).catch(() => null);
    const actions = executions.map(({ action }) => {
      const text = ACTIONS[action.type] ?? 'Unknown action';
      return action.type === AutoModerationActionType.Timeout && action.metadata.durationSeconds
        ? `${text} for ${Math.round(action.metadata.durationSeconds / 60)} min`
        : text;
    });

    return logEvent(guild, {
      title: 'AutoMod action',
      color: COLORS.filter,
      user,
      description: first.content ? truncate(first.content, 4000) : undefined,
      fields: [
        { name: 'User', value: `<@${first.userId}>`, inline: true },
        { name: 'Rule', value: rule?.name ?? TRIGGERS[first.ruleTriggerType] ?? 'Unknown', inline: true },
        ...(first.channelId ? [{ name: 'Channel', value: `<#${first.channelId}>`, inline: true }] : []),
        ...(first.matchedKeyword ? [{ name: 'Matched', value: `||${truncate(first.matchedKeyword, 1000)}||`, inline: true }] : []),
        { name: 'Action taken', value: [...new Set(actions)].join('\n') },
      ],
    });
  }
}
