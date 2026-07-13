import { constantTimeEqual, parseConsumerCredential, sha256Base64Url } from './crypto.js';
import { ConsumerError, notFound } from './errors.js';
import { deleteSessionData, getSessionRow } from './repository.js';

export async function requireConsumerSession(request, env, routeSessionId) {
  const parsed = parseConsumerCredential(request.headers.get('X-Consumer-Session'));
  if (!parsed || parsed.id !== routeSessionId) throw notFound();

  const row = await getSessionRow(env, routeSessionId);
  if (!row || row.deleted_at || !['active', 'completed'].includes(row.status)) throw notFound();
  const actualHash = await sha256Base64Url(parsed.secret);
  if (!constantTimeEqual(row.credential_hash_b64u, actualHash)) throw notFound();
  if (Date.parse(row.expires_at) <= Date.now()) {
    await deleteSessionData(env, row.id, 'expired').catch(() => {});
    throw new ConsumerError(410, 'consumer_session_expired', 'This planning session has expired.');
  }
  return row;
}
