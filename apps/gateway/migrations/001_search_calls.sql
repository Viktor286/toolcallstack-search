CREATE TABLE gateway.search_calls (
  id uuid PRIMARY KEY,
  batch_id uuid,
  provider text NOT NULL,
  label text NOT NULL,
  query text NOT NULL,
  params jsonb NOT NULL,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  latency_ms double precision NOT NULL,
  ok boolean NOT NULL,
  error_type text,
  error_message text,
  upstream_status integer,
  upstream_request_id text,
  result_count integer NOT NULL,
  results jsonb NOT NULL,
  usage jsonb NOT NULL,
  warnings jsonb NOT NULL,
  raw jsonb
);

CREATE INDEX search_calls_sent_at_idx ON gateway.search_calls (sent_at);
CREATE INDEX search_calls_provider_sent_at_idx ON gateway.search_calls (provider, sent_at);
CREATE INDEX search_calls_batch_id_idx ON gateway.search_calls (batch_id) WHERE batch_id IS NOT NULL;
