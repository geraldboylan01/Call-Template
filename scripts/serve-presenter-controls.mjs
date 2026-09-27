#!/usr/bin/env node
// A static loopback origin lets Safari connect to OBS without weakening the
// production app's HTTPS policy. No case files, credentials or HTTP API served.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const origin = 'http://127.0.0.1:8790';
const assets = new Map([
  ['/', ['../app/presenter-controls.html', 'text/html']],
  ['/js/presenter_controls.js', ['../js/presenter_controls.js', 'text/javascript']],
  ['/js/presenter_obs.js', ['../js/presenter_obs.js', 'text/javascript']],
  ['/styles/presenter-controls.css', ['../styles/presenter-controls.css', 'text/css']]
]);
export function createControlsServer() {
  return createServer(async (req, res) => {
    const file = assets.get(req.url);
    if (req.headers.host !== '127.0.0.1:8790' || req.method !== 'GET' || !file) { res.writeHead(404); res.end('Not found'); return; }
    try {
      res.writeHead(200, {
        'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      });
      res.end(await readFile(new URL(file[0], import.meta.url)));
    } catch { res.writeHead(500); res.end('Controls assets are missing. Update your local Planéir repository.'); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createControlsServer().on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Port 8790 is already in use. If Planéir controls are already running, keep that Terminal open.' : error.message); process.exitCode = 1;
  }).listen(8790, '127.0.0.1', () => console.log(`Planéir controls ready at ${origin}. Keep this Terminal open. In Planéir Presenter Mode, click “Open recording controls”.`));
}
