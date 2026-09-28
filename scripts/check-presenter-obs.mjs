import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOBSConnection, obsAuthentication } from '../js/presenter_obs.js';
const expected = createHash('sha256').update(createHash('sha256').update('test-passwordsalt').digest('base64') + 'challenge').digest('base64');
assert.equal(await obsAuthentication('test-password', { salt: 'salt', challenge: 'challenge' }), expected);
class FakeSocket extends EventTarget {
  static sockets = [];
  readyState = 1; requests = []; outputActive = false;
  constructor(url, protocol) { super(); this.url = url; this.protocol = protocol; FakeSocket.sockets.push(this); queueMicrotask(() => this.receive({ op: 0, d: { authentication: { salt: 'salt', challenge: 'challenge' } } })); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send(raw) {
    const { op, d } = JSON.parse(raw);
    if (op === 1) { assert.equal(d.authentication, expected); this.receive({ op: 2, d: { negotiatedRpcVersion: 1 } }); return; }
    this.requests.push(d.requestType);
    if (this.hang) return;
    if (d.requestType === 'StartRecord') this.outputActive = true;
    if (d.requestType === 'StopRecord' && !this.failStop) this.outputActive = false;
    queueMicrotask(() => this.receive({ op: 7, d: { requestId: d.requestId, requestStatus: { result: !this.failStop, code: this.failStop ? 500 : 100, comment: this.failStop ? 'disk problem' : '' }, responseData: { outputActive: this.outputActive, outputPaused: false } } }));
  }
}
let lost = 0;
const obs = createOBSConnection({ Socket: FakeSocket, onDisconnect: () => lost++, timeout: 50 });
await assert.rejects(obs.connect('test-password', 80), /port/);
assert.equal((await obs.connect('test-password')).outputActive, false);
const socket = FakeSocket.sockets.at(-1);
assert.equal(socket.url, 'ws://127.0.0.1:4455'); assert.equal(socket.protocol, 'obswebsocket.json');
await assert.rejects(obs.request('StartStream'), /Unsupported/);
await obs.request('StartRecord'); assert.equal((await obs.status()).outputActive, true);
await obs.request('StopRecord'); assert.equal((await obs.status()).outputActive, false);
socket.failStop = true; await assert.rejects(obs.request('StopRecord'), /disk problem/); socket.failStop = false;
socket.hang = true; await assert.rejects(obs.status(), /did not confirm/);
const waiting = obs.status(); socket.close(); await assert.rejects(waiting, /connection lost/); assert.equal(obs.connected, false); assert.equal(lost, 1);
await obs.connect('test-password'); obs.disconnect(); assert.equal(obs.connected, false);
console.log('OBS checks passed: SHA-256 authentication, local port boundary, command allowlist, confirmed start/stop, rejected stop, timeout, disconnect and reconnection. No recorder used.');
