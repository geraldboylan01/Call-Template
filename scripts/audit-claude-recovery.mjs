// Offline controller probes. Each assertion WAS a reproduced defect; each now
// asserts the fixed behaviour.
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
    controlCapability: 'rt_control_audit_recovery_1234567890',
    recovery: { text: 'The corrected savings figure is 4000.', deadlineAt: Date.now() + 90_000 },
    composerNode: { value: 'The corrected savings figure is 4000.' } });
  c.restoreTurns = turns => { c.transcript = turns.map(turn => ({ role: turn.role, text: turn.text })); };
  c.setStatus = text => { c.lastStatus = text; };
  c.scheduleCompletion = () => { c.scheduled = (c.scheduled || 0) + 1; };
  return c;
}
// WAS: any trailing assistant turn ended recovery, so a GET that landed before
// the failed POST was persisted saw the PREVIOUS question, declared success,
// and the client's message vanished from the screen.
const beforePersistence = controller();
await beforePersistence.observeMeeting({ turns: [{ role: 'assistant', text: 'What are your savings?' }] }, 0);
assert.ok(beforePersistence.recovery, 'an older assistant turn is not the reply we are waiting for');
assert.equal(beforePersistence.scheduled, 1, 'so recovery keeps looking');
console.log('FIXED: recovery waits for the reply to the message that was actually sent.');

// WAS: a recovered reply left its own message sitting in the composer, inviting
// the client to send the answer a second time.
const recovered = controller();
await recovered.observeMeeting({ turns: [{ role: 'user', text: recovered.composerNode.value },
  { role: 'assistant', text: 'Thanks, I have your correction.' }] }, 0);
assert.equal(recovered.recovery, null);
assert.equal(recovered.composerNode.value, '', 'the recovered submission is cleared from the retry composer');
console.log('FIXED: a recovered reply clears the message it recovered.');

// AND ONLY THAT MESSAGE. Anything the client typed while the turn was in flight
// is theirs and must survive.
const typedOver = controller();
typedOver.composerNode.value = 'Actually, make that 4500.';
await typedOver.observeMeeting({ turns: [{ role: 'user', text: typedOver.recovery.text },
  { role: 'assistant', text: 'Thanks, I have your correction.' }] }, 0);
assert.equal(typedOver.composerNode.value, 'Actually, make that 4500.');
console.log('FIXED: a newer draft is never cleared by an older recovery.');

const outage = controller();
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; return new Response(JSON.stringify({ error: { message: 'Synthetic outage' } }),
  { status: 503, headers: { 'content-type': 'application/json' } }); };
outage.recovery = { text: outage.recovery.text, deadlineAt: Date.now() - 1 };
outage.stopPolling = () => {};
outage.onToast = () => {};
try { for (let attempt = 0; attempt < 35; attempt++) await outage.pollMeeting(0); }
finally { globalThis.fetch = originalFetch; }
// WAS: the attempt counter only advanced on reads that SUCCEEDED, so an
// outage -- precisely when recovery matters -- retried forever without ever
// reaching its nominal limit. The bound is now a wall clock both paths share.
assert.ok(networkCalls < 35, `an expired recovery window stops polling, made ${networkCalls} calls`);
assert.equal(outage.recovery, null, 'and the client is told rather than left watching a spinner');
assert.ok(outage.scheduled < 35);
console.log('FIXED: failed polls are bounded by the same clock as successful ones.');
