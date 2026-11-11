# Changelog

Notable changes to this project. Versions follow [semantic versioning](https://semver.org); while
the version is below 1.0 a minor release may change the API.

## Unreleased

- Error types: a provider's 401 and 403 are `auth_error`, 402 and Tavily's 432/433 are
  `quota_exceeded`, and 400, 404 and 422 are `upstream_invalid_request`, answered 422 and left out
  of provider health. Clients that matched on `upstream_error` for those statuses need updating.
- A successful answer the gateway cannot read anything from carries a warning and counts in
  `parse_anomalies_total`, so a provider that changes its response format no longer looks like an
  empty result. A nightly workflow runs `pnpm smoke` against providers whose keys are stored as
  secrets.
- Metrics: whole-call duration, each upstream phase, results by whether they are dated, cache
  lookups, and trace exemplars on the duration histograms when tracing is on.
- Opt-in cache with `cacheTtlSeconds` or `CACHE_TTL_SECONDS`: identical successful answers are
  reused and identical calls in flight share one request. Hits are marked, cost nothing and are left
  out of latency, health and budgets.
- Impossible dates and a `startDate` after `endDate` are refused with 400. Every result has a
  `canonicalUrl` for matching the same page across providers.
- `/v1/calls` filters by `errorType` and by text in the query (`q`); `/v1/stats` reports
  `cacheHits`.
- Dashboard: every figure explains on hover what it means and how it is computed. The Calls page
  filters by error type, time, query text and label, keeps its filters in the address, opens each
  call at its own link and can refresh itself; an Overview bar opens that hour's calls.
- Playground: the last 10 runs are kept in the browser and come back after a reload or from "Recent
  runs"; a search can be cancelled and shows how long it has waited; a cached answer can be fetched
  again fresh; copied links keep per-provider options; result counts go up to the chosen providers'
  limits, with a note when one returns fewer; the examples stay available after typing a query.
- Provider health is restored from each provider's last 20 logged calls at start, as spend already
  was, so a restart no longer shows "No calls" and "Last success: never" next to the day's traffic.
- `minRemaining` budgets work without a database, and the gateway warns when one cannot apply.
- When shared state cannot reach Postgres, calls fall back to each instance's own rate limits
  instead of failing.
- The Docker image installs pnpm without corepack, so it builds on Node 25 and later.
- Fixes: `.env.example` leaves `DATABASE_URL` commented, so following the quick start without
  Postgres no longer stops the gateway at start; `pnpm smoke` sends the token of a named
  `GATEWAY_API_KEYS` entry instead of `name:token`; a playground link that sets a field of the
  collapsed options panel opens it, so no filter applies unseen.
- Dashboard Overview: a summary strip (providers by health, calls, failures and cost over 24 hours),
  a 24-hour calls chart per provider, providers ordered by how much attention they need with idle
  ones collapsed, balance runway and stale-snapshot hints, amber budget meters with a "cap reached
  at" forecast, links from a provider to its calls, and a manual refresh that keeps the last data
  on screen when the gateway cannot be reached.

## 0.4.0

- Demo mode: with no provider key the gateway offers two built-in providers that answer with
  generated results, so it can be tried without an account anywhere.
- OpenTelemetry traces over OTLP, continuing the caller's trace, with a span per search and per
  upstream attempt.
- `SHARED_STATE=true` keeps rate limits, budgets and provider health in Postgres so several
  instances act as one.
- Playground: live request JSON and curl, parsed and raw JSON views, provider comparison, result
  overlap, more parameters, shareable links and snapshot export.
- Container image published at `ghcr.io/viktor286/toolcallstack-search`.

## 0.3.0

First public release.

- One request and response shape for Brave, Exa, fastCRW, Firecrawl, Parallel, Tavily and You.com,
  with single, batch and fallback search.
- Per-call timing phases, retries with exponential backoff, and outbound rate limiting per provider.
- Cost tracking from provider reports, list prices and account balance changes; spend budgets.
- Call log, usage and statistics endpoints backed by Postgres, with client attribution, redaction
  and retention.
- Prometheus metrics, health and readiness endpoints.
- Documentation endpoints for AI agents and an MCP server.
- A dashboard: overview, calls, usage and a playground.
