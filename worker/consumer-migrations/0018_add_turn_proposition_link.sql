-- THE QUESTION A CLIENT WAS ANSWERING IS NOT ADJACENCY.
--
-- meeting_sequence is assigned MAX+1 at INSERT, so it records the order turns
-- were WRITTEN. A user turn is written when its transcription completes, and
-- the assistant's next question routinely completes first. Reconstructing "what
-- was the client answering" from the preceding stored row therefore pairs a
-- terse answer with the wrong question -- and a terse answer is exactly the
-- kind whose whole meaning comes from the question.
--
-- The live session already knows the real relationship: the response context
-- carries the assistant proposition that caused the client turn. Persisting it
-- here means the semantic reader is given the actual conversational context
-- rather than one inferred from ASR timing.
--
-- Nullable on purpose. Turns recorded before this column existed, and turns
-- with no preceding proposition (the client speaking first), both have no
-- answer to give, and a null says so honestly instead of guessing.
ALTER TABLE consumer_realtime_final_turns
  ADD COLUMN answers_turn_id TEXT REFERENCES consumer_realtime_final_turns(id);

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_final_turns_answers
  ON consumer_realtime_final_turns(answers_turn_id);
