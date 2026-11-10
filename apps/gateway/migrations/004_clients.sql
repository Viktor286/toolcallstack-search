-- Name of the gateway API key that made the call; null when auth is off.
ALTER TABLE gateway.search_calls ADD COLUMN client text;

CREATE INDEX search_calls_client_idx ON gateway.search_calls (client, sent_at)
  WHERE client IS NOT NULL;
