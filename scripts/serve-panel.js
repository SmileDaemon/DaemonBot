/**
 * Serves panel/ at http://localhost:8020 for local testing, with caching off so
 * an edited module is never served stale. Run the worker alongside it:
 *
 *     npm run panel        (this)
 *     npm run panel:api    (the worker, in another terminal)
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLegal } from './build-legal.js';

const ROOT = resolve(fileURLToPath(new URL('../panel/', import.meta.url)));
const PORT = Number(process.env.PORT) || 8020;
buildLegal(); // terms.html and privacy.html, fresh from the Markdown on every start
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Control panel: http://localhost:${PORT}/`));
