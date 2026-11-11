import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";

const LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60];

/**
 * The gateway's metrics. With `exemplars`, the call and attempt durations
 * carry the trace id of a recent observation, so a slow bucket in a dashboard
 * links to a trace; exemplars need the OpenMetrics format, which the registry
 * then uses for all its output.
 */
export function createMetrics(options: { exemplars?: boolean } = {}) {
  const exemplars = options.exemplars ?? false;
  const registry = new Registry(
    exemplars ? Registry.OPENMETRICS_CONTENT_TYPE : Registry.PROMETHEUS_CONTENT_TYPE,
  );
  const callDuration = new Histogram({
    name: "toolcallstack_search_call_duration_seconds",
    help: "Duration of whole search calls: queueing, every attempt and the backoff between them",
    labelNames: ["provider", "outcome"],
    buckets: LATENCY_BUCKETS,
    registers: [registry],
    enableExemplars: exemplars,
  });
  const upstreamDuration = new Histogram({
    name: "toolcallstack_search_upstream_duration_seconds",
    help: "Duration of the final upstream attempt of each call",
    labelNames: ["provider", "outcome"],
    buckets: LATENCY_BUCKETS,
    registers: [registry],
    enableExemplars: exemplars,
  });
  /** Observe a duration, attaching the trace id as an exemplar when exemplars are on. */
  const timed =
    (histogram: Histogram<"provider" | "outcome">) =>
    (labels: { provider: string; outcome: string }, seconds: number, traceId?: string) => {
      if (!exemplars) return histogram.observe(labels, seconds);
      histogram.observe({
        labels,
        value: seconds,
        // trace_id is an exemplar label, not one of the metric's own labels.
        exemplarLabels: (traceId ? { trace_id: traceId } : {}) as never,
      });
    };
  return {
    registry,
    observeCall: timed(callDuration),
    observeUpstream: timed(upstreamDuration),
    upstreamCalls: new Counter({
      name: "toolcallstack_search_upstream_calls_total",
      help: "Search calls by provider and final outcome, after any retries",
      labelNames: ["provider", "outcome"],
      registers: [registry],
    }),
    upstreamRetries: new Counter({
      name: "toolcallstack_search_upstream_retries_total",
      help: "Retried upstream attempts by provider and the failure that caused the retry",
      labelNames: ["provider", "reason"],
      registers: [registry],
    }),
    upstreamTtfb: new Histogram({
      name: "toolcallstack_search_upstream_ttfb_seconds",
      help: "Time from connection ready to response headers, per upstream attempt",
      labelNames: ["provider"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30],
      registers: [registry],
    }),
    upstreamPhase: new Histogram({
      name: "toolcallstack_search_upstream_phase_seconds",
      help: "Time of each phase of an upstream attempt: dns, connect, tls, ttfb, download",
      labelNames: ["provider", "phase"],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    }),
    results: new Counter({
      name: "toolcallstack_search_results_total",
      help: "Results returned by successful calls, by whether they carry a publish date",
      labelNames: ["provider", "dated"],
      registers: [registry],
    }),
    parseAnomalies: new Counter({
      name: "toolcallstack_search_parse_anomalies_total",
      help: "Successful answers the gateway could not fully read, a sign the provider's response format changed",
      labelNames: ["provider", "kind"],
      registers: [registry],
    }),
    cacheLookups: new Counter({
      name: "toolcallstack_search_cache_lookups_total",
      help: "Cache lookups of calls that allow caching: hit, shared (joined an identical call in flight) or miss",
      labelNames: ["provider", "result"],
      registers: [registry],
    }),
    upstreamResults: new Histogram({
      name: "toolcallstack_search_upstream_results",
      help: "Results returned per successful upstream call",
      labelNames: ["provider"],
      buckets: [0, 1, 3, 5, 10, 20, 50, 100],
      registers: [registry],
    }),
    queueWait: new Histogram({
      name: "toolcallstack_search_queue_wait_seconds",
      help: "Time an upstream attempt waited for a slot under the provider's rate limit",
      labelNames: ["provider"],
      buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: "toolcallstack_search_queue_depth",
      help: "Upstream attempts currently waiting for a slot",
      labelNames: ["provider"],
      registers: [registry],
    }),
    cost: new Counter({
      name: "toolcallstack_search_cost_usd_total",
      help: "Cost of successful calls in US dollars, by where the figure came from",
      labelNames: ["provider", "source"],
      registers: [registry],
    }),
    budgetSpent: new Gauge({
      name: "toolcallstack_search_budget_spent",
      help: "Spend counted against provider budgets in the current UTC day and month",
      labelNames: ["provider", "period", "unit"],
      registers: [registry],
    }),
    balance: new Gauge({
      name: "toolcallstack_search_balance",
      help: "Remaining provider account balance at the last snapshot",
      labelNames: ["provider", "unit"],
      registers: [registry],
    }),
    storeFailures: new Counter({
      name: "toolcallstack_search_store_failures_total",
      help: "Writes to the call log or balance snapshots that failed",
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
