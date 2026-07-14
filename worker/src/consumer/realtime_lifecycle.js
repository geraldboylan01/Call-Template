import { ConsumerError } from './errors.js';
import {
  releaseConsumerProviderCostNotSent,
  settleConsumerProviderCostUnknown
} from './repository.js';
import { hangupOpenAiRealtimeCall } from './realtime_provider.js';
import {
  closeRealtimeLease,
  getActiveRealtimeLease,
  getRealtimeLease,
  getRealtimeProviderCallId
} from './realtime_repository.js';

function durableObjectStub(env, leaseId) {
  if (!env.CONSUMER_REALTIME_SESSIONS
    || typeof env.CONSUMER_REALTIME_SESSIONS.idFromName !== 'function'
    || typeof env.CONSUMER_REALTIME_SESSIONS.get !== 'function') return null;
  return env.CONSUMER_REALTIME_SESSIONS.get(
    env.CONSUMER_REALTIME_SESSIONS.idFromName(`consumer-realtime/${leaseId}`)
  );
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

async function closeDirectly(env, lease, options) {
  const providerCallId = await getRealtimeProviderCallId(env, lease.session_id, lease.id);
  const wasDispatched = Boolean(lease.activated_at || lease.provider_call_id_hash_b64u || providerCallId);
  if (wasDispatched) {
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
    if (wasDispatched) {
      await settleConsumerProviderCostUnknown(env, closed.provider_cost_id, {
        errorCode: options.errorCode || options.reason
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
  try {
    const coordinated = await closeThroughDurableObject(env, lease, normalized);
    if (coordinated) return coordinated;
  } catch (_error) {
    // The official provider hangup below is the fail-safe when the coordinator
    // is unavailable. D1 is never purged before one of these paths confirms.
  }
  return closeDirectly(env, lease, normalized);
}

export async function terminateActiveRealtimeSession(env, sessionId, options = {}) {
  const lease = await getActiveRealtimeLease(env, sessionId);
  return lease ? terminateRealtimeLease(env, lease, options) : null;
}
