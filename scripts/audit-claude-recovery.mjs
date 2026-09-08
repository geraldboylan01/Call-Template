// Offline controller probes. Assertions reproduce defects, not desired behaviour.
import assert from 'node:assert/strict';
const storage = new Map();
globalThis.window = { location: { hostname: 'localhost', href: 'http://localhost/plan/' },
  setTimeout, clearTimeout, sessionStorage: { getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) } };
const { TypedMeetingController } = await import('../js/plan/typed_meeting.js');
const { state, storeSessionAccess } = await import('../js/plan/store.js');
const sessionId = 'cs_audit_recovery_1234567890';
storeSessionAccess({ id: sessionId }, 'synthetic-credential');
state.session = { id: sessionId };
function controller() {
  const c = new TypedMeetingController();
  Object.assign(c, { active: true, sessionId, leaseId: 'rt_audit_recovery_1234567890',
    controlCapability: 'rt_control_audit_recovery_1234567890', recoveringTurn: true,
    composerNode: { value: 'The corrected savings figure is 4000.' } });
  c.restoreTurns = turns => { c.transcript = turns.map(turn => ({ role: turn.role, text: turn.text })); };
  c.setStatus = text => { c.lastStatus = text; };
  c.scheduleCompletion = () => { c.scheduled = (c.scheduled || 0) + 1; };
  return c;
}
const beforePersistence = controller();
await beforePersistence.observeMeeting({ turns: [{ role: 'assistant', text: 'What are your savings?' }] }, 0);
assert.equal(beforePersistence.recoveringTurn, false);
assert.equal(beforePersistence.scheduled, undefined);
console.log('REPRODUCED: an older assistant turn falsely ends recovery before the failed-send turn is observed.');

const recovered = controller();
await recovered.observeMeeting({ turns: [{ role: 'user', text: recovered.composerNode.value },
  { role: 'assistant', text: 'Thanks, I have your correction.' }] }, 0);
assert.equal(recovered.recoveringTurn, false);
assert.equal(recovered.composerNode.value, 'The corrected savings figure is 4000.');
console.log('REPRODUCED: a successfully recovered reply leaves the same message in the retry composer.');

const outage = controller();
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; return new Response(JSON.stringify({ error: { message: 'Synthetic outage' } }),
  { status: 503, headers: { 'content-type': 'application/json' } }); };
try { for (let attempt = 0; attempt < 35; attempt++) await outage.pollMeeting(0); }
finally { globalThis.fetch = originalFetch; }
assert.equal(networkCalls, 35);
assert.equal(outage.recoveryAttempts, 0);
assert.equal(outage.recoveringTurn, true);
assert.equal(outage.scheduled, 35);
console.log('REPRODUCED: 35 failed polls never advance the nominal 30-attempt recovery limit.');
