-- Agent-test meetings.
--
-- A text/agent meeting is a MEETING; it simply has no audio. Rather than give
-- the agent transport its own parallel storage — which is exactly how the voice
-- and text journeys would drift apart — it reuses the existing meeting row and
-- every table that hangs off it (final turns, fact proposals, meeting briefs,
-- analysis plans, tool attempts, events). One engine, one schema.
--
-- `channel` is the only discriminator. It defaults to 'voice' so every existing
-- row keeps its exact meaning, and the realtime lifecycle machinery (provider
-- hang-up, budget dispatch stops, the hourly expiry sweep) is scoped to
-- channel = 'voice' so an agent meeting can never be handed to it.
--
-- Rollback: agent-test routes are gated by CONSUMER_AGENT_TEST_ENABLED, which
-- defaults false. Turning that off stops all writes. The column is additive and
-- harmless if left in place.

ALTER TABLE consumer_realtime_sessions
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'voice';

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_sessions_channel
  ON consumer_realtime_sessions(channel, status);
