/**
 * WHAT THE CLIENT ACTUALLY HEARD, TRACKED SEPARATELY FROM WHAT WAS GENERATED.
 *
 * Provider generation and WebRTC audio playback are independent lifecycles. A
 * response can complete while its audio is still playing, and audio can be
 * cleared by a barge-in long after the response is done. Neither one alone
 * proves the plan read-back reached the client, and the server refuses to run
 * an approved plan whose read-back was never fully delivered.
 *
 * So this ledger keeps one record per response id, folds in each observation as
 * it arrives in whatever order, and posts a single authenticated
 * acknowledgement once the evidence is complete. An interruption is terminal
 * for that attempt: a later "stopped" event cannot revive it, because the
 * client did not hear the whole thing.
 *
 * Every dependency is injected so this stays a pure lifecycle: it never reads
 * the DOM, never holds credentials, and never decides what the offer means.
 */
export function createPlaybackDeliveryLedger({
  limit,
  newEventId,
  // Whether an authenticated acknowledgement can be sent at all.
  canSend,
  // Whether local audio evidence supports a COMPLETED delivery.
  audible,
  send
}) {
  const records = new Map();

  function acknowledge(delivery) {
    if (!delivery || !canSend()) return;
    const playback = delivery.interrupted
      ? 'interrupted'
      : delivery.started && delivery.stopped && delivery.responseCompleted && audible()
        ? 'completed'
        : null;
    if (!playback || delivery.acknowledged === playback || delivery.pending) return;
    delivery.pending = send({
      responseId: delivery.responseId,
      eventId: delivery.eventId,
      playback
    }).then(() => {
      delivery.acknowledged = playback;
    }).catch(() => {
      // The offer stays incomplete on the server. Retry the same evidence on
      // the next bounded state request, never infer delivery from silence.
    }).finally(() => {
      delivery.pending = null;
      // An interruption observed while a "completed" post was in flight must
      // still be reported, or the server would hold stale delivery evidence.
      if (delivery.interrupted && playback !== 'interrupted') acknowledge(delivery);
    });
  }

  return {
    for(responseId) {
      if (!responseId) return null;
      if (!records.has(responseId)) {
        records.set(responseId, { responseId, interrupted: false });
        if (records.size > limit) records.delete(records.keys().next().value);
      }
      return records.get(responseId);
    },
    interrupt(responseId, eventId) {
      const delivery = this.for(responseId);
      if (!delivery) return;
      delivery.interrupted = true;
      delivery.eventId = String(eventId || delivery.eventId || newEventId());
      acknowledge(delivery);
    },
    acknowledge,
    acknowledgeAll() {
      for (const delivery of records.values()) acknowledge(delivery);
    },
    clear() {
      records.clear();
    }
  };
}
