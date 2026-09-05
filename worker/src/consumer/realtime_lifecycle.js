import { ConsumerError } from './errors.js';
import {
  releaseConsumerProviderCostNotSent,
  settleConsumerProviderCostUnknown
} from './repository.js';
import { hangupOpenAiRealtimeCall } from './realtime_provider.js';
import { conversationLaneStub } from './live/lane.js';
import {
  closeRealtimeLease,
  getActiveRealtimeLease,
  getRealtimeLease,
  getRealtimeProviderCallId
} from './realtime_repository.js';

function durableObjectStub(env, leaseId) {
  return conversationLaneStub(env, leaseId);
}

async function closeThroughDurableObject(env, lease, options) {
  const stub = durableObjectStub(env, lease.id);
  if (!stub) return null;
  const response = await stub.fetch('https://consumer-realtime.internal/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: options.status,
      reason: options.reason,
      errorCode: options.errorCode,
      usageKnown: options.usageKnown === true
    })
  });
  let payload = null;
  try { payload = await response.json(); } catch (_error) { payload = null; }
  if (!response.ok || payload?.ok !== true || payload?.providerHangupConfirmed !== true) return null;
  const current = await getRealtimeLease(env, lease.session_id, lease.id);
  return current && !['pending', 'active', 'closing'].includes(current.status)
    ? { ...current, providerHangupConfirmed: true }
    : null;
}

// A provider call cannot outlive its lease by hours: the session's own hard
// expiry plus the provider's maximum call duration bound it. Beyond that
// margin the call is proven dead by time alone, so cleanup must not depend on
// the hangup endpoint answering for long-dead call ids.
const HANGUP_TIME_PROOF_MARGIN_MS = 2 * 60 * 60 * 1000;

function terminationTimeProven(lease) {
  const hardExpiresMs = Date.parse(String(lease?.hard_expires_at || ''));
  return Number.isFinite(hardExpiresMs)
    && Date.now() - hardExpiresMs > HANGUP_TIME_PROOF_MARGIN_MS;
}

async function closeDirectly(env, lease, options) {
  // A TYPED MEETING HAS NO PROVIDER CALL, SO THERE IS NOTHING TO HANG UP.
  //
  // The same precondition as the Durable Object's own close: `wasDispatched`
  // asks whether a call was ever put on the wire and answered it from
  // `activated_at`, which typed also sets. This is the fallback the DO close
  // falls through to when the coordinator is unavailable -- and the path
  // `closeRealtimeControl` uses when consent is withdrawn or a session is
  // deleted -- so leaving it voice-shaped meant a typed meeting could not be
  // closed by any route at all.
  const typedMeeting = String(lease.channel || 'voice') === 'typed';
  const providerCallId = typedMeeting
    ? null
    : await getRealtimeProviderCallId(env, lease.session_id, lease.id);
  // TWO DIFFERENT QUESTIONS, WHICH ONLY LOOKED LIKE ONE WHILE VOICE WAS THE
  // ONLY TRANSPORT.
  //
  //   `hasProviderCall` -- is there a call on the wire to hang up? For typed,
  //   never.
  //   `spent` -- did this meeting cost money that must now be settled? For
  //   typed, yes: text tokens are metered per turn exactly as audio is.
  //
  // For a call the two always agreed, so one flag served both. Reusing it for
  // typed released a genuinely spent reservation as `not_sent`, which is both
  // untrue and unreachable for a reservation already in flight.
  const hasProviderCall = !typedMeeting
    && Boolean(lease.activated_at || lease.provider_call_id_hash_b64u || providerCallId);
  const spent = Boolean(lease.activated_at || lease.provider_call_id_hash_b64u || providerCallId);
  if (hasProviderCall && !terminationTimeProven(lease)) {
    if (!providerCallId) {
      throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call could not be terminated safely. Please retry.');
    }
    await hangupOpenAiRealtimeCall({ env, providerCallId });
  }
  const closed = await closeRealtimeLease(
    env,
    lease.session_id,
    lease.id,
    options.status,
    options.reason,
    options.errorCode
  );
  if (!closed || ['pending', 'active', 'closing'].includes(closed.status)) {
    throw new ConsumerError(503, 'realtime_close_failed', 'The live voice session could not be closed safely. Please retry.');
  }
  if (closed.provider_cost_id) {
    if (spent) {
      await settleConsumerProviderCostUnknown(env, closed.provider_cost_id, {
        errorCode: options.errorCode || options.reason,
        estimatedCostEurMicros: Number(closed.estimated_cost_eur_micros || 0)
      });
    } else {
      await releaseConsumerProviderCostNotSent(env, closed.provider_cost_id, {
        errorCode: options.errorCode || options.reason
      });
    }
  }
  return { ...closed, providerHangupConfirmed: true };
}

export async function terminateRealtimeLease(env, lease, options = {}) {
  if (!lease) return null;
  if (!['pending', 'active', 'closing'].includes(lease.status)) return lease;
  const normalized = {
    status: options.status || 'failed',
    reason: options.reason || 'lifecycle_terminated',
    errorCode: options.errorCode || null,
    usageKnown: options.usageKnown === true
  };
  // A time-proven-dead lease goes straight to the direct close: its Durable
  // Object is long evicted, and the coordinator round trip can only burn
  // subrequests or fail.
  if (!terminationTimeProven(lease)) {
    try {
      const coordinated = await closeThroughDurableObject(env, lease, normalized);
      if (coordinated) return coordinated;
    } catch (_error) {
      // The official provider hangup below is the fail-safe when the
      // coordinator is unavailable. D1 is never purged before one of these
      // paths confirms.
    }
  }
  return closeDirectly(env, lease, normalized);
}

export async function terminateActiveRealtimeSession(env, sessionId, options = {}) {
  const lease = await getActiveRealtimeLease(env, sessionId);
  return lease ? terminateRealtimeLease(env, lease, options) : null;
}
