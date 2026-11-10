import { randomUUID } from "node:crypto";
import { SpanKind, SpanStatusCode, context, trace, type Context } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import type { BudgetTracker } from "./budget.ts";
import { withCost, type Pricing } from "./cost.ts";
import type { HealthTracker } from "./health.ts";
import { QueueTimeoutError, type Limiter } from "./limiter.ts";
import type { Metrics } from "./metrics.ts";
import { providersById } from "./providers/index.ts";
import type { Provider, UpstreamRequest } from "./providers/types.ts";
import type { ErrorType, SearchError, SearchParams, SearchResponse } from "./schema.ts";
import type { Store } from "./store.ts";
import { tracer } from "./tracing.ts";
import type { Phases, Transport } from "./transport.ts";
import { deepMerge, keyFingerprint, redact } from "./util.ts";

export interface RetryPolicy {
  /** Retries after the first attempt, unless the request sets `maxRetries`. */
  maxRetries: number;
  baseMs: number;
  maxMs: number;
  sleep(ms: number): Promise<void>;
  /** Source of jitter, in [0, 1). */
  random(): number;
}

export interface SearchDeps {
  transport: Transport;
  env: Record<string, string | undefined>;
  defaultTimeoutMs: number;
  defaultMaxQueueMs: number;
  retry: RetryPolicy;
  limiter: Limiter;
  budget: BudgetTracker;
  health: HealthTracker;
  pricing: Record<string, Pricing | undefined>;
  metrics: Metrics;
  store: Store | null;
  log: FastifyBaseLogger;
}

export interface SearchTarget {
  provider: string;
  label?: string;
  options?: Record<string, unknown>;
}

export interface SearchContext {
  /** Name of the gateway API key making the call. */
  client?: string | null;
  batchId?: string | null;
  groupId?: string | null;
}

/** Unified params the provider cannot honour, as human-readable warnings. */
function unsupported(provider: Provider, params: SearchParams): string[] {
  const has = (feature: Provider["features"][number]) => provider.features.includes(feature);
  const warnings: string[] = [];
  if (params.topic === "news" && !has("topic:news")) {
    warnings.push("topic 'news' is not supported; ran a general search");
  }
  if (params.freshness && !has("freshness")) {
    warnings.push("freshness is not supported and was ignored");
  } else if (params.freshness === "hour" && !has("freshness:hour")) {
    warnings.push("freshness 'hour' is not supported; widened to 'day'");
  }
  for (const field of [
    "startDate",
    "endDate",
    "includeDomains",
    "excludeDomains",
    "country",
  ] as const) {
    if (params[field] !== undefined && !has(field)) {
      warnings.push(`${field} is not supported and was ignored`);
    }
  }
  return warnings;
}

function applyOptions(request: UpstreamRequest, options: Record<string, unknown> | undefined) {
  if (!options) return request;
  if (request.method === "POST") {
    return { ...request, body: deepMerge(request.body ?? {}, options) };
  }
  const url = new URL(request.url);
  for (const [key, value] of Object.entries(options)) url.searchParams.set(key, String(value));
  return { ...request, url: url.toString() };
}

function upstreamMessage(body: unknown, status: number): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return `upstream responded ${status}: ${text.slice(0, 500)}`;
}

/** Failures worth repeating: the same request may succeed a moment later. */
function isRetryable(type: ErrorType | null, upstreamStatus: number | null): boolean {
  if (type === "timeout" || type === "network" || type === "rate_limited") return true;
  return type === "upstream_error" && upstreamStatus !== null && upstreamStatus >= 500;
}

/** `Retry-After` as milliseconds; it is either a number of seconds or an HTTP date. */
function parseRetryAfter(header: string | undefined, now: Date): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now.getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Exponential backoff with jitter: the wait doubles per attempt up to `maxMs`,
 * and each wait is drawn from the upper half of its step so retries from
 * concurrent calls spread out. A longer upstream `Retry-After` wins, within `maxMs`.
 */
function backoffDelay(policy: RetryPolicy, attempt: number, retryAfterMs: number | null): number {
  const step = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  const jittered = step * (0.5 + policy.random() / 2);
  return Math.round(Math.max(jittered, Math.min(retryAfterMs ?? 0, policy.maxMs)));
}

interface Attempt {
  sentAt: Date;
  receivedAt: Date;
  queuedMs: number;
  latencyMs: number;
  phases: Phases | null;
  status: number | null;
  retryAfterMs: number | null;
  raw: unknown;
  error: SearchError | null;
  parsed: ReturnType<Provider["parseResponse"]> | null;
}

/** One upstream request: build, send, classify the outcome. Never throws. */
async function attemptOnce(
  deps: SearchDeps,
  provider: Provider,
  apiKey: string,
  params: SearchParams,
  timeoutMs: number,
  queuedMs: number,
  within: { parent: Context; index: number },
): Promise<Attempt> {
  // Built at send time so relative windows like freshness are anchored to the real request.
  const sentAt = new Date();
  const request = applyOptions(provider.buildRequest(params, apiKey, sentAt), params.options);
  // The parent is passed in because the limiter may run this from another call's async context.
  const span = tracer().startSpan(
    `upstream ${provider.id}`,
    {
      kind: SpanKind.CLIENT,
      startTime: sentAt,
      attributes: {
        "http.request.method": request.method,
        // Host only: the full URL can carry the query text.
        "server.address": new URL(request.url).host,
        "search.attempt": within.index + 1,
        "search.queued_ms": Math.round(queuedMs),
      },
    },
    within.parent,
  );
  const started = performance.now();
  const attempt: Attempt = {
    sentAt,
    receivedAt: sentAt,
    queuedMs,
    latencyMs: 0,
    phases: null,
    status: null,
    retryAfterMs: null,
    raw: undefined,
    error: null,
    parsed: null,
  };
  const fail = (type: ErrorType, message: string) => {
    attempt.error = { type, message, upstreamStatus: attempt.status };
  };

  try {
    const upstream = await deps.transport({
      method: request.method,
      url: request.url,
      headers: {
        ...request.headers,
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
      timeoutMs,
    });
    attempt.receivedAt = new Date();
    attempt.latencyMs = performance.now() - started;
    attempt.phases = upstream.phases;
    attempt.status = upstream.status;
    attempt.retryAfterMs = parseRetryAfter(upstream.headers["retry-after"], attempt.receivedAt);
    try {
      attempt.raw = JSON.parse(upstream.text);
    } catch {
      attempt.raw = upstream.text;
    }

    if (upstream.status === 429) {
      fail("rate_limited", upstreamMessage(attempt.raw, upstream.status));
    } else if (upstream.status < 200 || upstream.status >= 300) {
      fail("upstream_error", upstreamMessage(attempt.raw, upstream.status));
    } else if (typeof attempt.raw === "string") {
      fail("bad_response", `upstream returned non-JSON body: ${upstream.text.slice(0, 200)}`);
    } else {
      attempt.parsed = provider.parseResponse(attempt.raw, {
        params,
        receivedAt: attempt.receivedAt,
      });
    }
  } catch (error) {
    if (attempt.status === null) {
      attempt.receivedAt = new Date();
      attempt.latencyMs = performance.now() - started;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "TimeoutError") {
      fail("timeout", `no response within ${timeoutMs} ms`);
    } else if (attempt.status === null) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
      fail("network", cause ? `${message}: ${cause.message}` : message);
    } else {
      fail("bad_response", `could not parse upstream response: ${message}`);
    }
  }

  if (attempt.status !== null) span.setAttribute("http.response.status_code", attempt.status);
  if (attempt.phases) {
    const { connectionReused, ...phases } = attempt.phases;
    span.setAttribute("search.connection_reused", connectionReused);
    for (const [name, value] of Object.entries(phases)) {
      if (value !== null) span.setAttribute(`search.phase.${name.replace(/Ms$/, "_ms")}`, value);
    }
  }
  if (attempt.error) {
    span.setAttribute("error.type", attempt.error.type);
    span.setStatus({ code: SpanStatusCode.ERROR, message: attempt.error.message });
  }
  span.end(attempt.receivedAt);
  return attempt;
}

/**
 * Run one search against one provider, queueing under its rate limit and
 * retrying transient failures. Never throws: failures come back as a response
 * with `ok: false`, so a batch can report each provider independently.
 */
export function executeSearch(
  deps: SearchDeps,
  target: SearchTarget,
  baseParams: SearchParams,
  searchContext: SearchContext = {},
): Promise<SearchResponse> {
  return tracer().startActiveSpan(`search ${target.provider}`, async (span) => {
    try {
      const response = await runSearch(deps, target, baseParams, searchContext);
      const cost = response.usage.costUsd ?? response.usage.estimatedCostUsd;
      span.setAttributes({
        "search.provider": response.provider,
        "search.label": response.label,
        "search.call_id": response.id,
        "search.results": response.results.length,
        "search.retries": response.retries.count,
        "search.queued_ms": Math.round(response.timing.queuedMs),
        "search.cost_source": response.usage.costSource,
        ...(cost === undefined ? {} : { "search.cost_usd": cost }),
        ...(searchContext.client ? { "search.client": searchContext.client } : {}),
        ...(searchContext.batchId ? { "search.batch_id": searchContext.batchId } : {}),
      });
      if (response.error) {
        span.setAttribute("error.type", response.error.type);
        span.setStatus({ code: SpanStatusCode.ERROR, message: response.error.message });
      }
      return response;
    } finally {
      span.end();
    }
  });
}

async function runSearch(
  deps: SearchDeps,
  target: SearchTarget,
  baseParams: SearchParams,
  searchContext: SearchContext,
): Promise<SearchResponse> {
  const id = randomUUID();
  const active = context.active();
  const label = target.label ?? target.provider;
  const provider = providersById.get(target.provider);
  const options =
    baseParams.options || target.options
      ? deepMerge(baseParams.options ?? {}, target.options)
      : undefined;
  const params: SearchParams = { ...baseParams, options };
  const started = performance.now();
  const startedAt = new Date().toISOString();

  const response: SearchResponse = {
    id,
    provider: target.provider,
    label,
    query: params.query,
    ok: false,
    results: [],
    timing: {
      sentAt: startedAt,
      receivedAt: startedAt,
      latencyMs: 0,
      totalMs: 0,
      queuedMs: 0,
      phases: null,
    },
    retries: { count: 0, backoffMs: 0, attempts: [] },
    usage: { costSource: "unknown" },
    upstream: { status: null, requestId: null },
    warnings: [],
    error: null,
    fallback: { tried: [] },
  };
  let raw: unknown;

  const apiKey = provider ? deps.env[provider.envVar] : undefined;
  if (!provider) {
    response.error = {
      type: "unknown_provider",
      message: `unknown provider '${target.provider}'`,
      upstreamStatus: null,
    };
  } else if (!apiKey) {
    response.error = {
      type: "not_configured",
      message: `provider '${provider.id}' needs ${provider.envVar} to be set`,
      upstreamStatus: null,
    };
  } else {
    response.warnings = unsupported(provider, params);
    let effective = params;
    if (params.maxResults > provider.maxResults) {
      response.warnings.push(`maxResults capped at ${provider.maxResults}`);
      effective = { ...params, maxResults: provider.maxResults };
    }
    const maxRetries = params.maxRetries ?? deps.retry.maxRetries;
    const timeoutMs = params.timeoutMs ?? deps.defaultTimeoutMs;
    const maxQueueMs = params.maxQueueMs ?? deps.defaultMaxQueueMs;

    for (let index = 0; ; index++) {
      const overBudget = deps.budget.reserve(provider.id);
      if (overBudget !== null) {
        // Refused before queueing: nothing is sent and no slot is taken.
        response.error = { type: "budget_exceeded", message: overBudget, upstreamStatus: null };
        break;
      }
      let attempt: Attempt;
      try {
        attempt = await deps.limiter.run(provider.id, maxQueueMs, (queuedMs) =>
          attemptOnce(deps, provider, apiKey, effective, timeoutMs, queuedMs, {
            parent: active,
            index,
          }),
        );
      } catch (error) {
        deps.budget.settle(provider.id, null);
        if (!(error instanceof QueueTimeoutError)) throw error;
        // Nothing was sent, so there is no attempt to record.
        response.timing.queuedMs += maxQueueMs;
        response.error = { type: "throttled", message: error.message, upstreamStatus: null };
        break;
      }

      raw = attempt.raw;
      response.error = attempt.error;
      response.upstream.status = attempt.status;
      response.timing.sentAt = attempt.sentAt.toISOString();
      response.timing.receivedAt = attempt.receivedAt.toISOString();
      response.timing.latencyMs = attempt.latencyMs;
      response.timing.phases = attempt.phases;
      response.timing.queuedMs += attempt.queuedMs;
      deps.metrics.queueWait.observe({ provider: provider.id }, attempt.queuedMs / 1000);
      if (attempt.phases) {
        deps.metrics.upstreamTtfb.observe({ provider: provider.id }, attempt.phases.ttfbMs / 1000);
      }

      const errorType = attempt.error?.type ?? null;
      const backoffMs =
        index < maxRetries && isRetryable(errorType, attempt.status)
          ? backoffDelay(deps.retry, index, attempt.retryAfterMs)
          : null;
      response.retries.attempts.push({
        sentAt: attempt.sentAt.toISOString(),
        queuedMs: attempt.queuedMs,
        latencyMs: attempt.latencyMs,
        phases: attempt.phases,
        upstreamStatus: attempt.status,
        error: errorType,
        backoffMs,
      });

      if (attempt.parsed) {
        response.results = attempt.parsed.results
          .filter((result) => result.url !== "")
          .map((result, position) => ({ position: position + 1, ...result }));
        response.usage = withCost(
          attempt.parsed.usage ?? {},
          deps.pricing[provider.id],
          effective.maxResults,
        );
        response.upstream.requestId = attempt.parsed.upstreamRequestId ?? null;
        response.ok = true;
      }
      deps.budget.settle(provider.id, response.ok ? response.usage : null);
      if (backoffMs === null) break;
      trace.getSpan(active)?.addEvent("retry", {
        "search.backoff_ms": backoffMs,
        "error.type": errorType ?? "unknown",
      });
      response.retries.count += 1;
      response.retries.backoffMs += backoffMs;
      deps.metrics.upstreamRetries.inc({ provider: provider.id, reason: errorType ?? "unknown" });
      await deps.retry.sleep(backoffMs);
    }
  }
  response.timing.totalMs = performance.now() - started;

  deps.health.record(response);
  const outcome = response.error?.type ?? "ok";
  deps.metrics.upstreamCalls.inc({ provider: response.provider, outcome });
  if (response.retries.attempts.length > 0) {
    deps.metrics.upstreamDuration.observe(
      { provider: response.provider, outcome },
      response.timing.latencyMs / 1000,
    );
  }
  if (response.ok) {
    deps.metrics.upstreamResults.observe({ provider: response.provider }, response.results.length);
    const cost = response.usage.costUsd ?? response.usage.estimatedCostUsd;
    if (cost !== undefined) {
      deps.metrics.cost.inc(
        { provider: response.provider, source: response.usage.costSource },
        cost,
      );
    }
  }
  deps.log[response.ok ? "info" : "warn"](
    {
      callId: id,
      traceId: trace.getSpanContext(active)?.traceId,
      batchId: searchContext.batchId ?? null,
      client: searchContext.client ?? null,
      provider: response.provider,
      label,
      query: params.query,
      outcome,
      upstreamStatus: response.upstream.status,
      latencyMs: Math.round(response.timing.latencyMs),
      totalMs: Math.round(response.timing.totalMs),
      queuedMs: Math.round(response.timing.queuedMs),
      retries: response.retries.count,
      results: response.results.length,
      usage: response.usage,
      warnings: response.warnings,
      error: response.error?.message,
    },
    "search call",
  );

  // Stored off the request path so a slow database never delays or skews a measurement.
  if (deps.store && provider) {
    deps.store
      .saveCall({
        response,
        // Secrets a caller put in `options` reached the provider but must not be kept.
        params: options ? { ...params, options: redact(options) } : params,
        batchId: searchContext.batchId ?? null,
        groupId: searchContext.groupId ?? null,
        client: searchContext.client ?? null,
        keyFingerprint: apiKey ? keyFingerprint(apiKey) : null,
        raw,
      })
      .catch((error: unknown) => {
        deps.metrics.storeFailures.inc();
        deps.log.error({ err: error, callId: id }, "could not store search call");
      });
  }

  return params.includeRaw ? { ...response, raw } : response;
}

/**
 * Try providers in order until one answers. Each is a full call with its own
 * retries, limits and call-log entry; the failures before the answer are
 * listed in `fallback.tried`. If all fail, the last failure is returned.
 */
export async function searchWithFallbacks(
  deps: SearchDeps,
  chain: string[],
  params: SearchParams,
  searchContext: SearchContext = {},
): Promise<SearchResponse> {
  const groupId = chain.length > 1 ? randomUUID() : null;
  const tried: SearchResponse["fallback"]["tried"] = [];
  let response: SearchResponse | undefined;
  for (const provider of chain) {
    response = await executeSearch(deps, { provider }, params, { ...searchContext, groupId });
    if (response.ok || !response.error) break;
    tried.push({ provider, callId: response.id, error: response.error });
  }
  if (!response) throw new Error("no provider given");
  // The response that is returned describes itself, so it is not listed among the failures.
  return { ...response, fallback: { tried: response.ok ? tried : tried.slice(0, -1) } };
}

/** HTTP status for a single-provider search response. */
export function statusFor(response: SearchResponse): 200 | 404 | 429 | 502 | 503 | 504 {
  switch (response.error?.type) {
    case undefined:
      return 200;
    case "unknown_provider":
      return 404;
    case "not_configured":
      return 503;
    case "rate_limited":
    case "throttled":
    case "budget_exceeded":
      return 429;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}
