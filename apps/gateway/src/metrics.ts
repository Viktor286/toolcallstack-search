import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";

export function createMetrics() {
  const registry = new Registry();
  return {
    registry,
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
    upstreamDuration: new Histogram({
      name: "toolcallstack_search_upstream_duration_seconds",
      help: "Duration of the final upstream attempt of each call",
      labelNames: ["provider", "outcome"],
      buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60],
      registers: [registry],
    }),
    upstreamTtfb: new Histogram({
      name: "toolcallstack_search_upstream_ttfb_seconds",
      help: "Time from connection ready to response headers, per upstream attempt",
      labelNames: ["provider"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30],
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
