-- Calls answered from the gateway's cache: nothing was sent upstream, so they are left out of
-- latency, health and spend.
ALTER TABLE gateway.search_calls ADD COLUMN cache_hit boolean NOT NULL DEFAULT false;
