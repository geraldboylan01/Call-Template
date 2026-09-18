-- THE HARD REVIEW BOUNDARY.
--
-- Conversational language no longer authorises execution. Two tables replace
-- that authority, and both are read by the Worker rather than by any Durable
-- Object, so a second tab, a stale request and a reconnecting socket all
-- resolve against the same row.
--
-- `consumer_review_control` is the one authoritative control record per
-- planning session: which mode the session is in, which review is current, and
-- the version every conditional transition is claimed against. `input_epoch`
-- fences old input sources: a transcript admitted before a revocation carries
-- the old epoch and can never become a turn in the reopened conversation.
--
-- `consumer_reviews` is the immutable review. Its financial identity columns
-- are written once and never updated; only the lifecycle columns at the end
-- move, and they move exactly once. Revoking a review destroys its execution
-- opportunity without deleting the record, so the audit history survives.

CREATE TABLE consumer_review_control (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('conversation', 'sealing', 'review', 'running')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 0),
  current_review_id TEXT,
  execution_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE TABLE consumer_reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  lease_id TEXT,

  -- The frozen execution identity. Run resolves its inputs from here and
  -- nowhere else; the browser names the review and supplies no financial value.
  plan_id TEXT NOT NULL,
  plan_nonce_hash_b64u TEXT NOT NULL,
  input_snapshot_hash_b64u TEXT NOT NULL,
  -- NULL ONLY FOR THE LEGACY DETERMINISTIC LANE.
  --
  -- The direct-module lane freezes an AI proposal an independent verifier
  -- certified, and these carry that certificate. The older lane's plan is
  -- chosen by the deterministic goal planner from the confirmed profile, so
  -- there is no semantic proposal to certify and nothing to sign. Execution
  -- checks a certificate exactly when the frozen input carries one; it never
  -- treats a missing certificate as a passing one.
  certificate_signature TEXT,
  certificate_profile_revision INTEGER NOT NULL CHECK (certificate_profile_revision >= 1),
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision >= 0),
  confirmation_prompt_hash_b64u TEXT,

  -- The presentation the client was asked to inspect, bound to this exact
  -- review. A summary belonging to another review can never be displayed
  -- beside this review's Run button.
  presentation_encrypted TEXT NOT NULL,
  presentation_hash_b64u TEXT NOT NULL,

  -- The completed input/sealing boundary.
  sealed_input_epoch INTEGER NOT NULL CHECK (sealed_input_epoch >= 0),
  sealed_through_turn_id TEXT,

  -- Applicable validity constraints, recorded so a version change after
  -- sealing is visible to an audit rather than silently tolerated.
  playbook_version TEXT NOT NULL,
  extractor_prompt_version TEXT NOT NULL,
  verifier_prompt_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,

  created_at TEXT NOT NULL,

  -- Lifecycle. `review` is the only executable state.
  state TEXT NOT NULL CHECK (state IN ('review', 'revoked', 'superseded', 'running', 'executed', 'unknown')),
  execution_id TEXT,
  claim_click_id TEXT,
  analysis_run_id TEXT,
  decided_at TEXT,

  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX idx_consumer_reviews_session ON consumer_reviews(session_id, created_at DESC);
CREATE UNIQUE INDEX idx_consumer_reviews_plan ON consumer_reviews(plan_id);
