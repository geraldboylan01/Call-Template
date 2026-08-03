/**
 * A finished call publishes itself.
 *
 * Until now every published session was created by an authenticated adviser:
 * `handleCreatePublishedSession` opens with `requireAdvisorSession`, and that
 * gate was the whole security model. A consumer call had no way to produce the
 * link a client actually opens.
 *
 * THE SESSION AUTHORISES; THE SERVER WRITES.
 *
 * This is the part that makes consumer-authorised publishing safe. The caller
 * proves it holds a valid consumer session credential, and that is *all* it
 * gets to decide. It does not supply the modules, the title, the figures or a
 * line of copy. Every byte of the published payload is rebuilt here from the
 * profile the client already confirmed and the analysis the deterministic
 * engine already ran.
 *
 * If the request body could carry content, this route would be an open way to
 * put arbitrary markup in front of a client under Planéir's name. It cannot,
 * because nothing in the request is read except the session it came from.
 *
 * The storage and email side is injected rather than imported, matching how the
 * consumer router already receives `createPipelineHandoff`. That keeps this
 * module free of the main worker's R2 and D1 helpers, and keeps it testable
 * without either.
 */

import { encryptPublishedSessionV4 } from '../../../js/crypto_session.js';
import { buildPublishedSessionFromCall } from '../../../js/planning/session_payload.js';
import { ConsumerError } from './errors.js';

const DEFAULT_EXPIRY_DAYS = 30;

/**
 * Build, encrypt and store the published session for a completed call.
 *
 * @param {object} options
 * @param {object} options.env
 * @param {object} options.config
 * @param {object} options.sessionRow the consumer session, already authorised
 * @param {object} options.profile the confirmed profile
 * @param {object} options.analysis the completed analysis run
 * @param {(record: object) => Promise<void>} options.storePublishedSession
 *   injected by the worker: writes both bundles and the session record
 * @param {(message: object) => Promise<void>} [options.notifyAdviser]
 *   injected by the worker: sends the adviser their link
 * @param {string} [options.clientName]
 */
export async function publishConsumerAnalysis({
  env,
  config,
  sessionRow,
  profile,
  analysis,
  storePublishedSession,
  notifyAdviser = null,
  clientName = 'Your Planéir analysis'
}) {
  if (typeof storePublishedSession !== 'function') {
    throw new ConsumerError(500, 'publish_unconfigured', 'Publishing is not configured.');
  }
  // The same gate the analysis itself runs behind. A profile that has moved on
  // since it was confirmed must not be published as though it were reviewed.
  if (!sessionRow?.confirmed_profile_revision
    || Number(sessionRow.confirmed_profile_revision) !== Number(sessionRow.current_profile_revision)) {
    throw new ConsumerError(
      409,
      'profile_confirmation_required',
      'Confirm the current information before publishing this analysis.'
    );
  }
  const results = Array.isArray(analysis?.results) ? analysis.results : [];
  if (results.length === 0) {
    throw new ConsumerError(409, 'analysis_incomplete', 'There is no completed analysis to publish yet.');
  }

  const { session, skipped } = buildPublishedSessionFromCall({
    profile,
    results,
    clientName,
    sessionId: `call-${sessionRow.id}`
  });
  if (session.modules.length === 0) {
    throw new ConsumerError(
      409,
      'analysis_not_publishable',
      'None of the completed analyses can be shown yet.'
    );
  }

  // The client and the adviser currently see the same analysis. They are
  // encrypted under separate keys anyway, so the two views can diverge later
  // without changing anything a client already holds.
  const sessionJson = JSON.stringify(session);
  const encrypted = await encryptPublishedSessionV4({
    clientSessionJson: sessionJson,
    advisorSessionJson: sessionJson,
    clientName,
    expiresInDays: DEFAULT_EXPIRY_DAYS
  });

  const publishedId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86_400_000).toISOString();

  await storePublishedSession({
    publishedId,
    createdAt,
    expiresAt,
    clientName,
    requestBody: encrypted.requestBody,
    // Recorded so a published session can be traced back to the call that
    // produced it, and so a second publish of the same call is recognisable.
    origin: 'consumer_call',
    consumerSessionId: sessionRow.id,
    profileRevision: Number(sessionRow.current_profile_revision)
  });

  const links = buildPublishedLinks({
    config, publishedId, encrypted
  });

  if (typeof notifyAdviser === 'function') {
    // The adviser address comes from configuration, never from the request.
    // A client-supplied recipient would turn this into a way to send mail from
    // Planéir to anyone.
    await notifyAdviser({
      publishedId,
      adviserUrl: links.adviserUrl,
      moduleCount: session.modules.length,
      skipped,
      createdAt
    }).catch(() => {});
  }

  return {
    publishedId,
    createdAt,
    expiresAt,
    moduleCount: session.modules.length,
    skipped,
    ...links
  };
}

/**
 * The two links a publish produces.
 *
 * The secret lives in the URL FRAGMENT, never the path or the query, so it is
 * not sent to the server, not written to access logs and not carried in a
 * Referer header. That is how the existing viewer already reads it.
 */
export function buildPublishedLinks({ config, publishedId, encrypted }) {
  const base = String(config?.publishedSessionBaseUrl || 'https://planeir.ie').replace(/\/+$/, '');
  // THE VIEWER'S OWN PARAMETER NAMES, not ones invented here. session_viewer
  // reads `pub` for a published session and `id` for the LEGACY pin-gated one,
  // so an `id` link sent a client to a gate asking for a PIN that had never
  // been set and offered no way to create one. The fragment key is `ck` for the
  // client and `ak` for the adviser, and the two roles are different pages:
  // a client opens the read-only session view, an adviser opens the workspace.
  const query = `pub=${encodeURIComponent(publishedId)}&view=overview`;
  return {
    clientUrl: `${base}/app/session.html?${query}#ck=${encrypted.clientSecretB64u}`,
    adviserUrl: `${base}/app/index.html?${query}#ak=${encrypted.advisorSecretB64u}`
  };
}

/**
 * What the adviser is told when a call publishes itself.
 *
 * Deliberately contains no client figures. An email is the least controlled
 * surface in the system -- it sits in an inbox, gets forwarded, gets synced to
 * phones -- so it carries a link and a count, and the analysis stays behind the
 * encrypted link.
 */
export function buildAdviserNotification({ adviserUrl, moduleCount, createdAt }) {
  const plural = moduleCount === 1 ? 'analysis' : 'analyses';
  return {
    subject: `A Planéir call finished with ${moduleCount} ${plural} ready`,
    text: [
      `A client completed a Planéir call on ${new Date(createdAt).toUTCString()}.`,
      `${moduleCount} ${plural} ran and are ready to review.`,
      '',
      'Open the adviser view:',
      adviserUrl,
      '',
      'This link carries its own key and expires in 30 days.'
    ].join('\n')
  };
}
