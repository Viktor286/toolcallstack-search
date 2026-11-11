-- The call log grows without bound, so reads stop scanning it:
--  - search_calls is partitioned by month, and retention drops whole months;
--  - hourly rollups, kept current on every write, answer stats, usage and spend;
--  - raw upstream bodies live in their own short-lived table.

-- Which latency bucket a call falls in: bucket i holds (1.05^(i-1), 1.05^i] ms, bucket 0 up to
-- 1 ms, the last one everything slower. Reading a bucket back as its geometric middle is
-- within 2.5% of any value in it. The gateway's percentile code assumes this exact rule.
CREATE FUNCTION gateway.latency_bucket(ms double precision) RETURNS smallint
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE WHEN ms <= 1 THEN 0 ELSE least(300, ceil(ln(ms) / ln(1.05)))::smallint END;

-- 1. Raw bodies move out of the call log.
CREATE TABLE gateway.search_call_raws (
  call_id uuid PRIMARY KEY,
  sent_at timestamptz NOT NULL,
  raw jsonb NOT NULL
);
CREATE INDEX search_call_raws_sent_at_idx ON gateway.search_call_raws (sent_at);
INSERT INTO gateway.search_call_raws (call_id, sent_at, raw)
  SELECT id, sent_at, raw FROM gateway.search_calls WHERE raw IS NOT NULL;

-- 2. The call log, partitioned by the UTC month a call was sent in.
ALTER TABLE gateway.search_calls RENAME TO search_calls_unpartitioned;

CREATE TABLE gateway.search_calls (
  id uuid NOT NULL,
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
  -- sent_at, received_at and latency_ms describe the final attempt; total_ms spans all attempts.
  total_ms double precision,
  retry_count integer NOT NULL DEFAULT 0,
  attempts jsonb NOT NULL DEFAULT '[]',
  -- The unified response as returned to the client, without the raw upstream body.
  response jsonb,
  key_fingerprint text,
  credits double precision,
  reported_cost_usd double precision,
  estimated_cost_usd double precision,
  queued_ms double precision,
  -- Calls made for one client request that used fallbacks share this id.
  request_group_id uuid,
  -- Name of the gateway API key that made the call; null when auth is off.
  client text,
  -- Answered from the gateway's cache: nothing was sent upstream.
  cache_hit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, sent_at)
) PARTITION BY RANGE (sent_at);

-- Creates the month's partition unless it exists. Safe to call from several instances at once.
CREATE FUNCTION gateway.create_call_partition(at timestamptz) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  -- Month arithmetic in UTC: in a session time zone, adding a month shifts by its offset.
  month_utc timestamp := date_trunc('month', at AT TIME ZONE 'UTC');
  name text := 'search_calls_' || to_char(month_utc, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS gateway.%I PARTITION OF gateway.search_calls FOR VALUES FROM (%L) TO (%L)',
    name, month_utc AT TIME ZONE 'UTC', (month_utc + interval '1 month') AT TIME ZONE 'UTC');
EXCEPTION WHEN duplicate_table OR unique_violation THEN
  -- Another instance created it in the meantime.
  NULL;
END $$;

SELECT gateway.create_call_partition(month AT TIME ZONE 'UTC')
FROM generate_series(
  date_trunc('month', coalesce((SELECT min(sent_at) FROM gateway.search_calls_unpartitioned), now()) AT TIME ZONE 'UTC'),
  (now() AT TIME ZONE 'UTC') + interval '1 month',
  interval '1 month'
) AS month;

INSERT INTO gateway.search_calls (
  id, batch_id, provider, label, query, params, sent_at, received_at, latency_ms, ok,
  error_type, error_message, upstream_status, upstream_request_id, result_count, results,
  usage, warnings, total_ms, retry_count, attempts, response, key_fingerprint, credits,
  reported_cost_usd, estimated_cost_usd, queued_ms, request_group_id, client, cache_hit
)
SELECT
  id, batch_id, provider, label, query, params, sent_at, received_at, latency_ms, ok,
  error_type, error_message, upstream_status, upstream_request_id, result_count, results,
  usage, warnings, total_ms, retry_count, attempts, response, key_fingerprint, credits,
  reported_cost_usd, estimated_cost_usd, queued_ms, request_group_id, client, cache_hit
FROM gateway.search_calls_unpartitioned;

DROP TABLE gateway.search_calls_unpartitioned;

-- The newest-first list pages on this; it also serves plain time ranges.
CREATE INDEX search_calls_page_idx ON gateway.search_calls (sent_at DESC, id DESC);
CREATE INDEX search_calls_provider_sent_at_idx ON gateway.search_calls (provider, sent_at);
CREATE INDEX search_calls_batch_id_idx ON gateway.search_calls (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX search_calls_client_idx ON gateway.search_calls (client, sent_at)
  WHERE client IS NOT NULL;

-- 3. What one call adds to the rollups. The backfill below, every write and every read of a
-- part-hour aggregate this one view, so the three cannot disagree.
CREATE VIEW gateway.call_facts AS
SELECT
  id,
  sent_at,
  date_trunc('hour', sent_at, 'UTC') AS hour,
  provider,
  key_fingerprint,
  client,
  1 AS calls,
  ok::int AS ok_calls,
  retry_count AS retries,
  cache_hit::int AS cache_hits,
  jsonb_array_length(attempts) AS upstream_requests,
  credits,
  reported_cost_usd,
  estimated_cost_usd,
  coalesce(reported_cost_usd, estimated_cost_usd) AS cost_usd,
  -- A cache hit took no upstream time, so it is left out of queueing and latency.
  CASE WHEN NOT cache_hit THEN coalesce(queued_ms, 0) ELSE 0 END AS queued_ms_sum,
  (NOT cache_hit AND queued_ms IS NOT NULL)::int AS queued_calls,
  -- Billed: what budgets count. Failures and cache hits cost nothing.
  (ok AND NOT cache_hit)::int AS billed_calls,
  CASE WHEN ok AND NOT cache_hit THEN coalesce(reported_cost_usd, estimated_cost_usd, 0) ELSE 0 END
    AS billed_usd,
  CASE WHEN ok AND NOT cache_hit THEN coalesce(credits, 0) ELSE 0 END AS billed_credits,
  CASE WHEN ok AND NOT cache_hit THEN gateway.latency_bucket(latency_ms) END AS latency_bucket
FROM gateway.search_calls;

-- Counts and money per hour, provider, API key and client.
CREATE TABLE gateway.call_counts_hourly (
  hour timestamptz NOT NULL,
  provider text NOT NULL,
  key_fingerprint text,
  client text,
  calls integer NOT NULL,
  ok_calls integer NOT NULL,
  retries integer NOT NULL,
  cache_hits integer NOT NULL,
  upstream_requests integer NOT NULL,
  -- Sums that stay null while no call in the hour reported a value.
  credits double precision,
  reported_cost_usd double precision,
  estimated_cost_usd double precision,
  cost_usd double precision,
  queued_ms_sum double precision NOT NULL,
  queued_calls integer NOT NULL,
  billed_calls integer NOT NULL,
  billed_usd double precision NOT NULL,
  billed_credits double precision NOT NULL,
  CONSTRAINT call_counts_hourly_key
    UNIQUE NULLS NOT DISTINCT (hour, provider, key_fingerprint, client)
);

-- Successful upstream latency per hour and provider, as counts per latency bucket.
CREATE TABLE gateway.call_latency_hourly (
  hour timestamptz NOT NULL,
  provider text NOT NULL,
  bucket smallint NOT NULL,
  calls integer NOT NULL,
  PRIMARY KEY (hour, provider, bucket)
);

INSERT INTO gateway.call_counts_hourly
SELECT hour, provider, key_fingerprint, client,
  sum(calls), sum(ok_calls), sum(retries), sum(cache_hits), sum(upstream_requests),
  sum(credits), sum(reported_cost_usd), sum(estimated_cost_usd), sum(cost_usd),
  sum(queued_ms_sum), sum(queued_calls), sum(billed_calls), sum(billed_usd), sum(billed_credits)
FROM gateway.call_facts
GROUP BY hour, provider, key_fingerprint, client;

INSERT INTO gateway.call_latency_hourly
SELECT hour, provider, latency_bucket, count(*)
FROM gateway.call_facts
WHERE latency_bucket IS NOT NULL
GROUP BY hour, provider, latency_bucket;
