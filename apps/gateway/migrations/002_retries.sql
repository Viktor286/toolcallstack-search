-- sent_at, received_at and latency_ms describe the final attempt; total_ms spans all attempts.
ALTER TABLE gateway.search_calls
  ADD COLUMN total_ms double precision,
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN attempts jsonb NOT NULL DEFAULT '[]';
