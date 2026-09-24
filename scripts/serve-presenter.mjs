#!/usr/bin/env node
// Local previews may contain private case material; listen only on loopback.
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
const root = await realpath(process.cwd()), port = Number(process.argv[2] || 8788);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
createServer(async (req, res) => {
 try {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = await realpath(path.join(root, pathname));
  if (!file.startsWith(root + path.sep) && file !== root) throw new Error('outside root');
  if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
 } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Planéir preview: http://127.0.0.1:${port}`));
