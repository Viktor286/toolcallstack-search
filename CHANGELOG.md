# Changelog

Notable changes to this project. Versions follow [semantic versioning](https://semver.org); while
the version is below 1.0 a minor release may change the API.

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
