import { api, clearToken, devLoginUrl, getToken, inviteUrl, loginUrl, setToken } from './api.js';
import { IS_LOCAL, NOT_CONFIGURED } from './config.js';
import { ago, esc, initials, toast } from './util.js';
import * as views from './views.js';

const app = document.getElementById('app');

const TABS = [
  ['overview', 'Overview'],
  ['analytics', 'Analytics'],
  ['activity', 'Activity'],
  ['connections', 'Connections'],
  ['serverstats', 'Server Stats'],
  ['settings', 'Settings'],
  ['moderation', 'Moderation'],
  ['logs', 'Logs'],
  // ['music', 'Music'], // shelved with the bot's music commands; the page is still in views.js
];
// Pages that change on their own are refreshed while open.
const REFRESH = { overview: 30_000, music: 5_000, bot: 30_000 };

let me = null;
let timer = null;

/** Picks up a token or error the worker sent back after Discord sign-in. */
function takeHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('token')) setToken(params.get('token'));
  if (params.has('error')) toast(params.get('error'), true);
  if (params.has('token') || params.has('error')) history.replaceState(null, '', location.pathname + location.search);
}

function signIn(message) {
  app.innerHTML = `<div class="center"><div class="signin-wrap">
    <img class="signin-avatar" src="daemonbot.png" alt="DaemonBot" width="160" height="160">
    <div class="card signin">
    <h1>DaemonBot control panel</h1>
    ${NOT_CONFIGURED && !IS_LOCAL
      ? '<div class="banner bad">This panel isn\'t connected to its server yet: set DEPLOYED_API in panel/config.js (see MAINTAINING.md).</div>'
      : `<p class="muted">${esc(message ?? 'Sign in with Discord to manage the servers where you have Manage Server.')}</p>
         <a class="button primary" href="${esc(loginUrl())}">Sign in with Discord</a>
         <p class="muted small">Don't have the bot yet? <a href="${esc(inviteUrl())}" target="_blank" rel="noopener">Add DaemonBot to your server</a>, then sign in.</p>
         ${IS_LOCAL ? `<div><a class="button" href="${esc(devLoginUrl())}">Local test sign-in</a></div>` : ''}`}
  </div></div></div>`;
}

function shell() {
  const guildLinks = me.guilds
    .map((g) => `<a href="#/g/${esc(g.id)}/overview" data-guild="${esc(g.id)}" title="${esc(g.name)}">
      ${g.icon ? `<img class="icon" src="${esc(g.icon)}" alt="">` : `<span class="icon">${esc(initials(g.name))}</span>`}<span class="name">${esc(g.name)}</span></a>`)
    .join('');
  const bot = me.bot;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><img class="logo" src="daemonbot.png" alt="">${esc(bot.tag?.split('#')[0] ?? 'DaemonBot')}</div>
      <span class="pill ${bot.online ? 'good' : 'bad'}" title="${bot.lastSeen ? `Last heard from ${esc(ago(bot.lastSeen))}` : ''}">${bot.online ? 'Online' : 'Offline'}</span>
      <span class="spacer"></span>
      <span class="who row">${me.user.avatar ? `<img class="avatar" src="${esc(me.user.avatar)}" alt="">` : ''}${esc(me.user.username)}</span>
      <button id="signout" class="small">Sign out</button>
    </header>
    <div class="layout">
      <nav class="sidebar">
        <a href="#/bot" data-guild="bot"><span class="icon">⚙</span><span class="name">Bot status</span></a>
        <a href="#/search" data-guild="search"><span class="icon">?</span><span class="name">Find a member</span></a>
        ${me.user.isOwner ? '<a href="#/owner" data-guild="owner"><span class="icon">★</span><span class="name">Owner Panel</span></a>' : ''}
        <div class="label">Servers</div>
        ${guildLinks || '<p class="muted small" style="padding:0 10px">No servers yet. You need Manage Server in a server the bot is in.</p>'}
        <a href="${esc(inviteUrl())}" target="_blank" rel="noopener" title="Opens Discord. Reload this page once the bot has joined."><span class="icon">+</span><span class="name">Add to a server</span></a>
      </nav>
      <main id="main"></main>
    </div>`;
  document.getElementById('signout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    clearToken();
    me = null;
    signIn('Signed out.');
  });
}

function parseRoute() {
  const [path, search = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, query: new URLSearchParams(search) };
}

async function render() {
  clearTimeout(timer);
  if (!me) return;
  const { parts, query } = parseRoute();
  const main = document.getElementById('main');

  let view;
  let ctx = { me, query };
  let key;
  if (parts[0] === 'g' && me.guilds.some((g) => g.id === parts[1])) {
    const guild = me.guilds.find((g) => g.id === parts[1]);
    // The Activity and Connections tabs only show once the bot's owner lets this server's admins see them.
    const tabs = TABS.filter(([t]) => !['activity', 'connections'].includes(t) || guild.statsAccess !== false);
    const tab = tabs.some(([t]) => t === parts[2]) ? parts[2] : 'overview';
    ctx = { ...ctx, guildId: guild.id };
    view = views[tab];
    key = tab;
    document.title = `${guild.name} · DaemonBot Panel`;
    main.innerHTML = `<div class="header-row">${guild.icon ? `<img class="icon" src="${esc(guild.icon)}" alt="">` : ''}<h1 style="margin:0">${esc(guild.name)}</h1></div>
      <nav class="tabs">${tabs.map(([t, label]) => `<a href="#/g/${esc(guild.id)}/${t}" class="${t === tab ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div id="view"></div>`;
  } else if (parts[0] === 'owner' && me.user.isOwner) {
    view = views.owner;
    key = 'owner';
    ctx = { ...ctx, page: 'owner' };
    document.title = 'Owner Panel · DaemonBot Panel';
    main.innerHTML = '<div id="view"></div>';
  } else if (parts[0] === 'search') {
    view = views.search;
    key = 'search';
    ctx = { ...ctx, page: 'search' };
    document.title = 'Find a member · DaemonBot Panel';
    main.innerHTML = '<div id="view"></div>';
  } else if (parts[0] === 'bot' || !me.guilds.length) {
    view = views.bot;
    key = 'bot';
    document.title = 'Bot status · DaemonBot Panel';
    main.innerHTML = '<div id="view"></div>';
  } else {
    location.replace(`#/g/${me.guilds[0].id}/overview`);
    return;
  }

  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.guild === (ctx.guildId ?? ctx.page ?? 'bot')));
  const target = document.getElementById('view');
  const run = async (first) => {
    try {
      await view(target, ctx);
    } catch (err) {
      if (err.status === 401) return start();
      if (first) target.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
    }
    // Refresh only while the same page is open and nothing is being typed into.
    if (REFRESH[key] && target.isConnected) {
      timer = setTimeout(() => {
        const busy = target.querySelector('button:disabled, [data-dirty]') || target.contains(document.activeElement?.closest('form, textarea, select, input'));
        if (target.isConnected && !busy) run(false);
        else timer = setTimeout(() => run(false), REFRESH[key]);
      }, REFRESH[key]);
    }
  };
  await run(true);
}

async function start() {
  takeHash();
  if (!getToken()) return signIn();
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) {
      clearToken();
      return signIn(err.message);
    }
    app.innerHTML = `<div class="center"><div class="card signin"><h1>Can't load the panel</h1><p>${esc(err.message)}</p><button onclick="location.reload()">Try again</button></div></div>`;
    return;
  }
  shell();
  render();
}

window.addEventListener('hashchange', () => {
  if (location.hash.includes('token=') || location.hash.includes('error=')) start();
  else render();
});
start();
