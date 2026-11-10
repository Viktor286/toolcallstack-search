ALTER TABLE gateway.search_calls
  -- The unified response as returned to the client, without the raw upstream body.
  ADD COLUMN response jsonb,
  ADD COLUMN key_fingerprint text,
  ADD COLUMN credits double precision,
  ADD COLUMN reported_cost_usd double precision,
  ADD COLUMN estimated_cost_usd double precision,
  ADD COLUMN queued_ms double precision,
  -- Calls made for one client request that used fallbacks share this id.
  ADD COLUMN request_group_id uuid;

CREATE INDEX search_calls_page_idx ON gateway.search_calls (sent_at DESC, id DESC);

CREATE TABLE gateway.balance_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL,
  key_fingerprint text NOT NULL,
  taken_at timestamptz NOT NULL,
  unit text NOT NULL,
  remaining double precision,
  used double precision,
  quota double precision
);

CREATE INDEX balance_snapshots_idx
  ON gateway.balance_snapshots (provider, key_fingerprint, taken_at);
