// Where the panel finds its Cloudflare Worker. After `npm run deploy` in worker/,
// paste the address it prints here (no trailing slash).
const DEPLOYED_API = 'https://daemonbot-panel.daemonbot.workers.dev';

const local = ['localhost', '127.0.0.1'].includes(location.hostname);

export const API = local ? 'http://localhost:8787' : DEPLOYED_API;
export const IS_LOCAL = local;
export const NOT_CONFIGURED = API.includes('YOUR-CLOUDFLARE-NAME');
