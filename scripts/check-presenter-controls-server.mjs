import assert from 'node:assert/strict';
import { createControlsServer } from './serve-presenter-controls.mjs';
const server = createControlsServer();
const request = (url, method = 'GET', host = '127.0.0.1:8790') => new Promise(resolve => {
  let status, headers;
  server.emit('request', { url, method, headers: { host } }, { writeHead(code, values) { status = code; headers = values; }, end(body) { resolve({ status, headers, body: String(body) }); } });
});
for (const url of ['/', '/js/presenter_controls.js', '/js/presenter_obs.js', '/styles/presenter-controls.css']) {
  const res = await request(url); assert.equal(res.status, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/); assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
}
for (const url of ['/private/aam-makeovers/', '/.env', '/../package.json', '/%2e%2e/package.json', '/api/record', '/?file=private']) assert.equal((await request(url)).status, 404);
assert.equal((await request('/', 'POST')).status, 404);
assert.equal((await request('/', 'GET', 'attacker.example:8790')).status, 404);
console.log('Local controls server checks passed: four fixed assets, no client files/API, GET-only, exact Host, no CORS and restricted CSP.');
