import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const baseUrl = String(process.env.CONSUMER_TEST_BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const origin = 'http://127.0.0.1:5500';
const signingKeyB64u = String(process.env.CONSUMER_INVITE_SIGNING_KEY || '').trim();

if (!/^[A-Za-z0-9_-]{43}$/.test(signingKeyB64u)) {
  throw new Error('CONSUMER_INVITE_SIGNING_KEY must be a 32-byte base64url test key.');
}

function signedInvite() {
  const now = Math.floor(Date.now() / 1_000);
  const payloadPart = Buffer.from(JSON.stringify({
    v: 1,
    aud: 'planeir-consumer',
    jti: crypto.randomBytes(24).toString('base64url'),
    cohort: 'automated_test',
    iat: now,
    exp: now + 3_600,
    maxUses: 1
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', Buffer.from(signingKeyB64u, 'base64url'))
    .update(`ci1.${payloadPart}`)
    .digest('base64url');
  return `ci1.${payloadPart}.${signature}`;
}

function proposedCredential() {
  const sessionId = `cs_${crypto.randomBytes(18).toString('base64url')}`;
  return `${sessionId}.${crypto.randomBytes(32).toString('base64url')}`;
}

async function request(path, {
  method = 'GET',
  body,
  credential,
  invite,
  expectedStatus = 200,
  extraHeaders = {}
} = {}) {
  const headers = new Headers({ Origin: origin, ...extraHeaders });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (credential) headers.set('X-Consumer-Session', credential);
  if (invite) headers.set('X-Consumer-Invite', invite);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  const text = await response.text();
  if (text) payload = JSON.parse(text);
  assert.equal(
    response.status,
    expectedStatus,
    `${method} ${path} returned ${response.status}: ${text}`
  );
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.match(response.headers.get('cache-control') || '', /^no-store(?:,|$)/);
  return { response, payload };
}

const preflight = await request('/api/consumer/sessions', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-consumer-invite'
  }
});
assert.match(preflight.response.headers.get('access-control-allow-headers') || '', /X-Consumer-Invite/i);

const voiceUploadPreflight = await request('/api/consumer/sessions/cs_AAAAAAAAAAAAAAAAAAAA/voice/transcriptions', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-consumer-session,x-voice-duration-ms,x-voice-request-id'
  }
});
const voiceAllowedHeaders = voiceUploadPreflight.response.headers.get('access-control-allow-headers') || '';
assert.match(voiceAllowedHeaders, /X-Consumer-Session/i);
assert.match(voiceAllowedHeaders, /X-Voice-Duration-Ms/i);
assert.match(voiceAllowedHeaders, /X-Voice-Request-Id/i);

const realtimeControlPreflight = await request('/api/consumer/sessions/cs_AAAAAAAAAAAAAAAAAAAA/voice/realtime/calls/rt_AAAAAAAAAAAAAAAAAAAA', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'x-consumer-session,x-realtime-control-capability'
  }
});
assert.match(
  realtimeControlPreflight.response.headers.get('access-control-allow-headers') || '',
  /X-Realtime-Control-Capability/i
);

const realtimeActivationPreflight = await request('/api/consumer/sessions/cs_AAAAAAAAAAAAAAAAAAAA/voice/realtime/activations/rt_activation_AAAAAAAAAAAAAAAAAAAA', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'DELETE',
    'Access-Control-Request-Headers': 'x-consumer-session,x-realtime-control-capability'
  }
});
assert.match(
  realtimeActivationPreflight.response.headers.get('access-control-allow-methods') || '',
  /DELETE/i
);

const realtimeCallPreflight = await request('/api/consumer/sessions/cs_AAAAAAAAAAAAAAAAAAAA/voice/realtime/calls', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-consumer-session,x-voice-request-id,x-realtime-activation-id,x-realtime-control-capability'
  }
});
assert.match(
  realtimeCallPreflight.response.headers.get('access-control-allow-headers') || '',
  /X-Realtime-Activation-Id/i
);

const realtimeMeetingsPreflight = await request('/api/consumer/sessions/cs_AAAAAAAAAAAAAAAAAAAA/voice/realtime/meetings', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'x-consumer-session'
  }
});
assert.match(realtimeMeetingsPreflight.response.headers.get('access-control-allow-methods') || '', /GET/i);

const realtimeTranscriptPreflight = await request('/api/consumer/sessions/cs_AAAAAAAAAAAAAAAAAAAA/voice/realtime/meetings/rt_AAAAAAAAAAAAAAAAAAAA/transcript', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'x-consumer-session'
  }
});
assert.match(realtimeTranscriptPreflight.response.headers.get('access-control-allow-methods') || '', /GET/i);

const advisorInvitePreflight = await request('/api/advisor/consumer-invite', {
  method: 'OPTIONS',
  expectedStatus: 204,
  extraHeaders: {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-advisor-csrf'
  }
});
assert.match(advisorInvitePreflight.response.headers.get('access-control-allow-headers') || '', /X-Advisor-CSRF/i);
const unauthenticatedAdvisorInvite = (await request('/api/advisor/consumer-invite', {
  method: 'POST',
  expectedStatus: 503,
  extraHeaders: {
    'X-Advisor-CSRF': 'not-an-adviser-session'
  }
})).payload;
assert.equal(unauthenticatedAdvisorInvite.error, 'The adviser planning preview is not available right now.');

const bootstrap = (await request('/api/consumer/bootstrap')).payload;
assert.equal(bootstrap.flags.consumerJourneyEnabled, true);
assert.equal(bootstrap.flags.consumerAiIntakeEnabled, false);
assert.equal(bootstrap.flags.consumerModuleRoutingEnabled, true);
assert.equal(bootstrap.flags.consumerHumanHandoffEnabled, true);
assert.equal(bootstrap.access.publicAccessEnabled, false);
assert.equal(bootstrap.access.inviteRequired, true);
assert.equal(bootstrap.consentPolicyVersion, 'consumer-test-v1');
assert.equal(bootstrap.analysisNoticeId, 'analysis-test-v1');
assert.equal(bootstrap.privacyNoticeUrl, 'https://planeir.ie/plan/privacy.html');
assert.equal(bootstrap.handoff.policyUrl, 'https://planeir.ie/plan/privacy.html#handoff');
assert.equal(bootstrap.bookingUrl, undefined);

const consent = {
  analysis: true,
  aiProcessing: false,
  adultConfirmed: true,
  educationOnlyAcknowledged: true,
  manifestId: bootstrap.consentManifestId,
  policyVersion: bootstrap.consentPolicyVersion,
  analysisNoticeId: bootstrap.analysisNoticeId,
  aiNoticeId: bootstrap.ai.noticeId,
  privacyNoticeUrl: bootstrap.privacyNoticeUrl
};
const inviteOne = signedInvite();
const proposedOne = proposedCredential();
const staleDisclosure = (await request('/api/consumer/sessions', {
  method: 'POST',
  invite: inviteOne,
  credential: proposedOne,
  body: { consent: { ...consent, analysisNoticeId: 'analysis-stale-v0' } },
  expectedStatus: 400
})).payload;
assert.equal(staleDisclosure.code, 'consent_policy_outdated');
const createdOne = (await request('/api/consumer/sessions', {
  method: 'POST',
  invite: inviteOne,
  credential: proposedOne,
  body: { consent },
  expectedStatus: 201
})).payload;
assert.match(createdOne.credential, /^cs_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
assert.equal(createdOne.credential, proposedOne);
const sessionOne = createdOne.session.sessionId;
const credentialOne = createdOne.credential;

const replayedCreate = (await request('/api/consumer/sessions', {
  method: 'POST',
  invite: inviteOne,
  credential: proposedOne,
  body: { consent }
})).payload;
assert.equal(replayedCreate.idempotentReplay, true);
assert.equal(replayedCreate.credential, proposedOne);
assert.equal(replayedCreate.session.sessionId, sessionOne);

const usedInvite = (await request('/api/consumer/sessions', {
  method: 'POST',
  invite: inviteOne,
  body: { consent },
  expectedStatus: 403
})).payload;
assert.equal(usedInvite.code, 'consumer_invite_used');

const inviteTwo = signedInvite();
const createdTwo = (await request('/api/consumer/sessions', {
  method: 'POST',
  invite: inviteTwo,
  body: { consent },
  expectedStatus: 201
})).payload;
const sessionTwo = createdTwo.session.sessionId;
const credentialTwo = createdTwo.credential;

const crossSession = (await request(`/api/consumer/sessions/${sessionOne}`, {
  credential: credentialTwo,
  expectedStatus: 404
})).payload;
assert.equal(crossSession.code, 'not_found');

const initial = (await request(`/api/consumer/sessions/${sessionOne}`, {
  credential: credentialOne
})).payload;
assert.equal(initial.session.profileRevision, 1);
assert.equal(initial.analysis, null);
assert.equal(initial.consentRefreshRequired, false);

const turnKey = `turn-${crypto.randomUUID()}`;
const turn = (await request(`/api/consumer/sessions/${sessionOne}/turns`, {
  method: 'POST',
  credential: credentialOne,
  body: { message: 'I want to buy a home.', idempotencyKey: turnKey }
})).payload;
assert.equal(turn.idempotentReplay, false);
assert.equal(turn.extraction.mode.startsWith('rules'), true);
assert.ok(turn.session.profileRevision > 1);

const replay = (await request(`/api/consumer/sessions/${sessionOne}/turns`, {
  method: 'POST',
  credential: credentialOne,
  body: { message: 'I want to buy a home.', idempotencyKey: turnKey }
})).payload;
assert.equal(replay.idempotentReplay, true);
assert.equal(replay.session.profileRevision, turn.session.profileRevision);

const conflict = (await request(`/api/consumer/sessions/${sessionOne}/turns`, {
  method: 'POST',
  credential: credentialOne,
  body: { message: 'I want to retire.', idempotencyKey: turnKey },
  expectedStatus: 409
})).payload;
assert.equal(conflict.code, 'idempotency_key_conflict');

const stalePatch = (await request(`/api/consumer/sessions/${sessionOne}/profile`, {
  method: 'PATCH',
  credential: credentialOne,
  body: {
    patch: { '/primaryPerson/displayName': 'Test Person' },
    expectedRevision: 1
  },
  expectedStatus: 409
})).payload;
assert.equal(stalePatch.code, 'profile_revision_conflict');

const patched = (await request(`/api/consumer/sessions/${sessionOne}/profile`, {
  method: 'PATCH',
  credential: credentialOne,
  body: {
    patch: { '/primaryPerson/displayName': 'Test Person' },
    expectedRevision: turn.session.profileRevision
  }
})).payload;
assert.equal(patched.session.profileRevision, turn.session.profileRevision + 1);
assert.equal(patched.analysis, undefined);

const invalidRemove = (await request(`/api/consumer/sessions/${sessionOne}/profile`, {
  method: 'PATCH',
  credential: credentialOne,
  body: {
    patch: {},
    removePaths: ['/primaryPerson/displayName'],
    expectedRevision: patched.session.profileRevision
  },
  expectedStatus: 400
})).payload;
assert.equal(invalidRemove.code, 'profile_remove_not_allowed');

const confirmed = (await request(`/api/consumer/sessions/${sessionOne}/confirm`, {
  method: 'POST',
  credential: credentialOne,
  body: { confirmedPaths: [], expectedRevision: patched.session.profileRevision }
})).payload;
assert.equal(confirmed.session.confirmedProfileRevision, patched.session.profileRevision);

const missingAnalysis = (await request(`/api/consumer/sessions/${sessionOne}/analyses`, {
  method: 'POST',
  credential: credentialOne,
  body: { moduleIds: ['house_purchase'] },
  expectedStatus: 409
})).payload;
assert.equal(missingAnalysis.code, 'analysis_missing_information');
assert.equal(missingAnalysis.details.analysis.profileRevision, patched.session.profileRevision);

const prematureHandoff = (await request(`/api/consumer/sessions/${sessionOne}/handoffs`, {
  method: 'POST',
  credential: credentialOne,
  body: {
    fullName: 'Test Person',
    email: 'test@example.com',
    phone: '',
    requestedHelp: 'Please help me understand my options.',
    consent: true,
    policyVersion: bootstrap.handoff.policyVersion,
    policyUrl: bootstrap.handoff.policyUrl,
    expectedRevision: patched.session.profileRevision
  },
  expectedStatus: 409
})).payload;
assert.equal(prematureHandoff.code, 'current_analysis_required');

const noHandoffToRevoke = (await request(`/api/consumer/sessions/${sessionOne}/handoffs`, {
  method: 'DELETE',
  credential: credentialOne
})).payload;
assert.equal(noHandoffToRevoke.ok, true);
assert.equal(noHandoffToRevoke.handoff, null);

const withdrawn = (await request(`/api/consumer/sessions/${sessionOne}/consent`, {
  method: 'PATCH',
  credential: credentialOne,
  body: { aiProcessing: false }
})).payload;
assert.equal(withdrawn.session.aiProcessingConsented, false);
assert.equal(withdrawn.ai.mode, 'rules_only');

const deletedOne = (await request(`/api/consumer/sessions/${sessionOne}`, {
  method: 'DELETE',
  credential: credentialOne
})).payload;
assert.equal(deletedOne.ok, true);
assert.equal(deletedOne.retainedConsentedHandoff, false);

await request(`/api/consumer/sessions/${sessionOne}`, {
  credential: credentialOne,
  expectedStatus: 404
});

async function completeHomeJourney(sessionId, credential, name, email) {
  const completeTurn = (await request(`/api/consumer/sessions/${sessionId}/turns`, {
    method: 'POST',
    credential,
    body: {
      message: 'I want to buy a home.',
      idempotencyKey: `turn-${crypto.randomUUID()}`
    }
  })).payload;
  const completedProfile = (await request(`/api/consumer/sessions/${sessionId}/profile`, {
    method: 'PATCH',
    credential,
    body: {
      expectedRevision: completeTurn.session.profileRevision,
      patch: {
        '/primaryPerson/displayName': name,
        '/goals/0/targetAmount': { amount: 350000, currency: 'EUR' },
        '/incomeSources/0': {
          incomeId: 'salary',
          ownerId: 'primary',
          type: 'employment',
          label: 'Employment income',
          grossAnnual: { amount: 65000, currency: 'EUR' }
        },
        '/assets/0': {
          assetId: 'cash',
          ownerIds: ['primary'],
          type: 'cash',
          label: 'Cash savings',
          currentValue: { amount: 50000, currency: 'EUR' },
          liquid: true
        },
        '/expenses/monthlyEssential': { amount: 2500, currency: 'EUR' },
        '/expenses/currentMonthlyRent': { amount: 0, currency: 'EUR' },
        '/assumptions/values/housePurchase': {
          lendingCategory: 'first_time_buyer',
          schemeBuyerStatus: 'first_time_buyer'
        }
      }
    }
  })).payload;
  const revision = completedProfile.session.profileRevision;
  const completeConfirmation = (await request(`/api/consumer/sessions/${sessionId}/confirm`, {
    method: 'POST',
    credential,
    body: { confirmedPaths: [], expectedRevision: revision }
  })).payload;
  assert.equal(completeConfirmation.session.confirmedProfileRevision, revision);
  const completeAnalysis = (await request(`/api/consumer/sessions/${sessionId}/analyses`, {
    method: 'POST',
    credential,
    body: { moduleIds: ['house_purchase'] }
  })).payload;
  assert.equal(completeAnalysis.analysis.status, 'complete');
  assert.equal(completeAnalysis.analysis.profileRevision, revision);
  assert.equal(completeAnalysis.session.profileRevision, revision);
  const deliveredHandoff = (await request(`/api/consumer/sessions/${sessionId}/handoffs`, {
    method: 'POST',
    credential,
    body: {
      fullName: name,
      email,
      phone: '',
      requestedHelp: 'Please help me understand my home purchase options.',
      consent: true,
      policyVersion: bootstrap.handoff.policyVersion,
      policyUrl: bootstrap.handoff.policyUrl,
      expectedRevision: revision
    },
    expectedStatus: 201
  })).payload;
  assert.equal(deliveredHandoff.deliveryConfirmed, true);
  assert.equal(deliveredHandoff.pipelineLinkPending, false);
  assert.equal(deliveredHandoff.handoff.status, 'linked');
  assert.equal(deliveredHandoff.handoff.recipient, 'gerry');
  return { revision, deliveredHandoff };
}

const {
  revision: completeRevision,
  deliveredHandoff
} = await completeHomeJourney(sessionTwo, credentialTwo, 'Complete Journey', 'complete@example.com');

const repeatedHandoff = (await request(`/api/consumer/sessions/${sessionTwo}/handoffs`, {
  method: 'POST',
  credential: credentialTwo,
  body: {
    fullName: 'Complete Journey',
    email: 'complete@example.com',
    phone: '',
    requestedHelp: 'Please help me understand my home purchase options.',
    consent: true,
    policyVersion: bootstrap.handoff.policyVersion,
    policyUrl: bootstrap.handoff.policyUrl,
    expectedRevision: completeRevision
  },
  expectedStatus: 201
})).payload;
assert.equal(repeatedHandoff.handoff.handoffId, deliveredHandoff.handoff.handoffId);
assert.equal(repeatedHandoff.deliveryConfirmed, true);

const revokedHandoff = (await request(`/api/consumer/sessions/${sessionTwo}/handoffs`, {
  method: 'DELETE',
  credential: credentialTwo
})).payload;
assert.equal(revokedHandoff.ok, true);
assert.equal(revokedHandoff.downstreamShared, true);
assert.equal(revokedHandoff.adviserContactRequired, true);
assert.equal(revokedHandoff.handoff.status, 'revoked');

const deletedTwo = (await request(`/api/consumer/sessions/${sessionTwo}`, {
  method: 'DELETE',
  credential: credentialTwo
})).payload;
assert.equal(deletedTwo.retainedConsentedHandoff, false);

const createdThree = (await request('/api/consumer/sessions', {
  method: 'POST',
  invite: signedInvite(),
  body: { consent },
  expectedStatus: 201
})).payload;
await completeHomeJourney(
  createdThree.session.sessionId,
  createdThree.credential,
  'Retained Handoff',
  'retained@example.com'
);
const deletedThree = (await request(`/api/consumer/sessions/${createdThree.session.sessionId}`, {
  method: 'DELETE',
  credential: createdThree.credential
})).payload;
assert.equal(deletedThree.retainedConsentedHandoff, true);
await request(`/api/consumer/sessions/${createdThree.session.sessionId}`, {
  credential: createdThree.credential,
  expectedStatus: 404
});

console.log('Consumer HTTP isolation, consent, revision, analysis, handoff, and lifecycle checks passed.');
