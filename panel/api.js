import { API } from './config.js';

const TOKEN_KEY = 'daemonbot-panel-token';

function storage(action, value) {
  try {
    if (action === 'get') return localStorage.getItem(TOKEN_KEY);
    if (action === 'set') localStorage.setItem(TOKEN_KEY, value);
    if (action === 'clear') localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private windows can refuse storage; the token then lasts until the tab closes.
  }
  return null;
}

let memoryToken = null;
export const getToken = () => memoryToken ?? storage('get');
export function setToken(token) {
  memoryToken = token;
  storage('set', token);
}
export function clearToken() {
  memoryToken = null;
  storage('clear');
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Calls the worker. Throws ApiError with a message fit to show. */
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the control panel server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  return data;
}

/**
 * Sends a change to the bot and waits for it to be applied. The bot collects
 * changes every few seconds, so this polls until it reports back.
 */
export async function sendCommand(guildId, type, payload = {}) {
  const path = guildId ? `/api/guilds/${guildId}/commands` : '/api/commands';
  const { id } = await api(path, { method: 'POST', body: { type, payload } });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const c = await api(`/api/commands/${id}`);
    if (c.status === 'done') return c.result?.message || 'Done.';
    if (c.status === 'failed') throw new ApiError(400, c.result?.message || 'The bot could not apply that.');
  }
  throw new ApiError(504, "The bot hasn't picked that up yet. It will apply it when it's back online.");
}

export const loginUrl = () => `${API}/auth/login`;
export const devLoginUrl = () => `${API}/auth/dev?site=${encodeURIComponent(location.origin + location.pathname)}`;
