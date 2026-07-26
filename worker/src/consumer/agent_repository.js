/**
 * Agent-test meeting persistence.
 *
 * An agent meeting is a MEETING row with `channel = 'agent_test'`. It reuses the
 * existing meeting table and everything hanging off it — final turns, fact
 * proposals, meeting briefs, analysis plans, tool attempts — so the text
 * transport writes through exactly the same storage the voice transport does.
 * There is no parallel agent schema, because a parallel schema is how the two
 * journeys would drift apart.
 *
 * The realtime lifecycle machinery (provider hang-up, budget dispatch stops,
 * the hourly expiry sweep) is scoped to `channel = 'voice'`, so an agent
 * meeting is never handed to it.
 */

import { ConsumerError } from './errors.js';
import { randomId } from './crypto.js';

function db(env) {
  if (!env.CONSUMER_DB) {
    throw new ConsumerError(503, 'consumer_storage_unavailable', 'This planning journey is not available right now.');
  }
  return env.CONSUMER_DB;
}

function nowIso() {
  return new Date().toISOString();
}

export const AGENT_CHANNEL = 'agent_test';

/** Inert marker values for the meeting columns that only describe audio. */
const AGENT_MEETING_MARKERS = Object.freeze({
  provider: 'openai',
  model: 'text-agent-test',
  voice: 'none',
  reasoningEffort: 'low'
});

export async function createAgentMeeting(env, { sessionId, config, scenarioId = null }) {
  const id = randomId('rt');
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db(env).prepare(`
    INSERT INTO consumer_realtime_sessions (
      id, session_id, provider_cost_id, provider, status, model, voice,
      reasoning_effort, prompt_version, toolset_version, pricing_version,
      reservation_eur_micros, dispatch_stop_eur_micros,
      starting_profile_revision, latest_profile_revision,
      hard_expires_at, idle_expires_at, created_at, activated_at,
      last_active_at, channel, meeting_phase
    )
    SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, 'discovery'
    WHERE EXISTS (SELECT 1 FROM consumer_sessions WHERE id = ? AND deleted_at IS NULL)
  `).bind(
    id,
    sessionId,
    `cost_agent_${id}`,
    AGENT_MEETING_MARKERS.provider,
    AGENT_MEETING_MARKERS.model,
    AGENT_MEETING_MARKERS.voice,
    AGENT_MEETING_MARKERS.reasoningEffort,
    config.realtimePlannerPromptVersion,
    'agent-test-tools-v1',
    'agent-test-no-audio-pricing-v1',
    // The meeting table requires a positive reservation; an agent meeting has
    // no audio spend, so this is the smallest legal placeholder. Real model
    // spend is bounded by agentTestSessionBudgetMicroEur before each dispatch.
    1,
    0,
    expiresAt,
    expiresAt,
    timestamp,
    timestamp,
    timestamp,
    AGENT_CHANNEL,
    sessionId
  ).run();
  const row = await getAgentMeeting(env, sessionId, id);
  if (!row) throw new ConsumerError(409, 'agent_meeting_create_failed', 'The test meeting could not be created.');
  return row;
}

export async function getAgentMeeting(env, sessionId, meetingId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE id = ? AND session_id = ? AND channel = ?
    LIMIT 1
  `).bind(meetingId, sessionId, AGENT_CHANNEL).first();
}

export async function getActiveAgentMeeting(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE session_id = ? AND channel = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).bind(sessionId, AGENT_CHANNEL).first();
}

export async function countAgentTestSessions(env) {
  const row = await db(env).prepare(`
    SELECT COUNT(*) AS count FROM consumer_realtime_sessions
    WHERE channel = ? AND status = 'active'
  `).bind(AGENT_CHANNEL).first();
  return Number(row?.count || 0);
}

export async function countAgentTurns(env, meetingId) {
  const row = await db(env).prepare(`
    SELECT COUNT(*) AS count FROM consumer_realtime_final_turns
    WHERE realtime_session_id = ? AND role = 'user'
  `).bind(meetingId).first();
  return Number(row?.count || 0);
}

/** Accumulated model spend for this meeting, in euro micros. */
export async function agentMeetingSpendMicroEur(env, meetingId) {
  const row = await db(env).prepare(`
    SELECT estimated_cost_eur_micros AS spend FROM consumer_realtime_sessions
    WHERE id = ? LIMIT 1
  `).bind(meetingId).first();
  return Number(row?.spend || 0);
}

export async function addAgentMeetingSpend(env, meetingId, microEur) {
  const amount = Number.isSafeInteger(microEur) && microEur > 0 ? microEur : 0;
  if (!amount) return;
  await db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET estimated_cost_eur_micros = estimated_cost_eur_micros + ?, last_active_at = ?
    WHERE id = ? AND channel = ?
  `).bind(amount, nowIso(), meetingId, AGENT_CHANNEL).run();
}

export async function closeAgentMeeting(env, sessionId, meetingId) {
  await db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET status = 'complete', ended_at = ?, last_active_at = ?
    WHERE id = ? AND session_id = ? AND channel = ?
  `).bind(nowIso(), nowIso(), meetingId, sessionId, AGENT_CHANNEL).run();
}
