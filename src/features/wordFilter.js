import { existsSync, readFileSync, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { COLORS, logAction, markBotDeleted } from '../utils/logging.js';
import { notice } from '../utils/replies.js';
import { guildConfig } from '../utils/store.js';

// The repo's list is the starting point; panel edits are saved in data/, which survives redeploys on a host.
const DEFAULT_WORDS = fileURLToPath(new URL('../../filter-words.txt', import.meta.url));
export const SAVED_WORDS = fileURLToPath(new URL('../../data/filter-words.txt', import.meta.url));
/** The word list in use: the panel's saved copy once there is one, otherwise the repo's. */
export const wordsFile = () => (existsSync(SAVED_WORDS) ? SAVED_WORDS : DEFAULT_WORDS);
const NOTICE_LIFETIME = 6_000;

// Common character swaps used to dodge filters (n1gg3r, f@g, $pic).
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };
// Punctuation people put between letters (f.a.g, n-i-g).
const BETWEEN_LETTERS = '[._\\-*~]*';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercases and strips accents and invisible characters, so "Ñ" -> "n" and zero-width spaces don't split words. */
function normalize(text) {
  return text.normalize('NFKD').replace(/\p{M}|[​-‍⁠﻿­]/gu, '').toLowerCase();
}

/**
 * Turns a list entry into a regex. Each letter may repeat (fagggot) and be separated by punctuation (f.a.g),
 * plurals match automatically, and a trailing * matches any ending. Whole words only, so "coon" won't hit "raccoon".
 */
function compile(entry) {
  const wildcard = entry.endsWith('*');
  const words = normalize(wildcard ? entry.slice(0, -1) : entry).split(/\s+/);
  const body = words.map((word) => [...word].map((ch) => `${escapeRegex(ch)}+`).join(BETWEEN_LETTERS)).join('[\\s._\\-]+');
  const ending = wildcard ? '\\p{L}*' : '(?:e?s)?';
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${ending}(?![\\p{L}\\p{N}])`, 'u');
}

let terms = [];

function loadWords() {
  const file = wordsFile();
  if (!existsSync(file)) {
    terms = [];
    return console.warn(`Word filter: ${file} not found, filter has no words.`);
  }
  terms = parseWordList(readFileSync(file, 'utf8'));
  console.log(`Word filter: loaded ${terms.length} term(s).`);
}

export function parseWordList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((entry) => ({ entry, regex: compile(entry) }));
}

/** Loads the word list and reloads it whenever the file is saved, so edits apply without a restart. */
export function startWordFilter() {
  loadWords();
  watchFile(DEFAULT_WORDS, { interval: 2_000 }, loadWords);
  watchFile(SAVED_WORDS, { interval: 2_000 }, loadWords);
}

/** Returns the list entry that `text` violates, or null. */
export function findBlockedTerm(text, list = terms) {
  const plain = normalize(text);
  const unLeeted = plain.replace(/[0134578@$!|+]/g, (ch) => LEET[ch] ?? ch);
  // Check both forms: "fag!" only matches before leet-swapping, "f@g" only after.
  return list.find(({ regex }) => regex.test(plain) || regex.test(unLeeted))?.entry ?? null;
}

export async function handleWordFilter(message) {
  if (message.author.bot || !message.inGuild() || !message.content) return;
  if (guildConfig.get(message.guild.id, {}).wordFilter === false) return;

  const blocked = findBlockedTerm(message.content);
  if (!blocked) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  // Administrators are exempt, and the bot can't delete without Manage Messages in that channel.
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return;
  if (!message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) return;

  markBotDeleted([message.id]);
  await message.delete();
  const notice = await message.channel.send({
    ...notice('Your message was removed for offensive language.', { tone: 'error', content: `${message.author}` }),
    allowedMentions: { users: [message.author.id] },
  });
  setTimeout(() => {
    markBotDeleted([notice.id]);
    notice.delete().catch(() => {});
  }, NOTICE_LIFETIME).unref();

  await logAction(message.guild, {
    action: 'Message removed by word filter',
    color: COLORS.filter,
    target: message.author,
    moderator: message.client.user,
    reason: `Matched filter entry ||${blocked}||`,
    fields: [
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Message', value: `||${message.content.slice(0, 1000).replaceAll('|', '\\|')}||` },
    ],
  });
}
