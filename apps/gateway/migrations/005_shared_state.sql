-- Outbound rate-limit slots shared by every gateway instance (SHARED_STATE=true).
-- One row per upstream request: taken when it may start, released when it ends.
CREATE TABLE gateway.limiter_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  instance text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX limiter_slots_provider_idx ON gateway.limiter_slots (provider, acquired_at);
