import { DOWN_AFTER, HEALTH_WINDOW, HEALTHY_SHARE } from "../../../gateway/src/health.ts";
import { LOW_DATA, STALE_BALANCE_MS, WARN_SHARE } from "./overview.ts";

/**
 * What every figure on the dashboard means and how it is computed, shown on
 * hover. One entry per metric, reused on every page, so a number reads the
 * same wherever it appears. Text in backticks is rendered as code. Thresholds
 * are imported from the code that applies them, so the words cannot drift.
 */
export interface MetricDoc {
  title: string;
  /** What the figure tells you, in a sentence or two. */
  meaning: string;
  /** How it is computed, step by step. */
  logic: string[];
  /** Where the number comes from: the API field and the code behind it. */
  source: string;
}

const healthBasis = `Taken from the provider's last ${HEALTH_WINDOW} calls since the gateway started (with \`SHARED_STATE\`, reloaded from the shared call log every \`SHARED_STATE_SYNC_SECONDS\`). Calls refused before anything was sent (\`throttled\`, \`budget_exceeded\`, \`not_configured\`) are not counted.`;

const day24 =
  "The last 24 hourly buckets in UTC, ending with the current, unfinished hour: between 23 and 24 hours of history.";

const callRows =
  "One gateway call is one row in the call log: its retries are inside it, while each provider tried through `fallbacks` and each provider in a batch is a call of its own.";

const costRule =
  "Per call, the dollars the provider reported (`usage.costUsd`), otherwise the gateway's list-price estimate (`usage.estimatedCostUsd`). Failed calls cost nothing here.";

export const METRIC_DOCS = {
  health: {
    title: "Provider health",
    meaning: "How the provider has behaved on real traffic lately.",
    logic: [
      healthBasis,
      `Down: the last ${DOWN_AFTER} calls in a row failed.`,
      `Degraded: the latest call failed, or fewer than ${HEALTHY_SHARE * 100}% of the window succeeded.`,
      "Healthy otherwise; no calls yet: nothing recorded since start.",
      `With fewer than ${LOW_DATA} calls the label shows the count, since a few calls prove little.`,
    ],
    source: "GET /v1/status → providers[].status · gateway health.ts snapshot()",
  },
  medianLatency: {
    title: "Median latency",
    meaning:
      "How long a typical successful request to this provider takes, from just before sending to the last byte of the answer.",
    logic: [
      `Only successful calls among the provider's last ${HEALTH_WINDOW}; failures are left out.`,
      "Each call contributes the duration of its final attempt (`timing.latencyMs`): queueing, earlier attempts and backoff are excluded.",
      "Sorted, then the value at index `floor(n / 2)`: the upper middle when n is even.",
      healthBasis,
    ],
    source: "GET /v1/status → providers[].medianLatencyMs · gateway health.ts snapshot()",
  },
  p95WorstHour: {
    title: "p95, worst hour",
    meaning:
      "How slow the slowest 5% of successful calls got, in the provider's worst hour of the last day. A tail-latency alarm, not an average.",
    logic: [
      "Per hour, Postgres computes `percentile_cont(0.95)` over `latency_ms` of the hour's successful calls (interpolated, final attempt only).",
      "The card shows the highest of those hourly values, not a p95 over all 24 hours at once.",
      day24,
      "Needs the call log (`DATABASE_URL`).",
    ],
    source:
      "GET /v1/stats?bucket=hour → points[].p95LatencyMs · dashboard overview.ts activityByProvider()",
  },
  success: {
    title: "Success",
    meaning: "The share of the provider's recent calls that came back with results.",
    logic: [
      `successRate = successful calls / all counted calls, over the last ${HEALTH_WINDOW}, rounded to a whole percent.`,
      "A call counts as successful when its final attempt got a parseable 2xx answer, after any retries.",
      `With fewer than ${LOW_DATA} calls it shows "N calls so far" instead of a percentage.`,
      healthBasis,
    ],
    source: "GET /v1/status → providers[].successRate · gateway health.ts snapshot()",
  },
  calls24h: {
    title: "Calls, 24 h",
    meaning: "How many search calls went to this provider in the last day, and how many failed.",
    logic: [
      callRows,
      "Failed: `ok` is false. That includes calls refused by a budget or the rate-limit queue, which never reached the provider.",
      day24,
      "Labelled variants of one provider are added together. Needs the call log.",
    ],
    source: "GET /v1/stats?bucket=hour → points[].calls, points[].failures",
  },
  cost24h: {
    title: "Cost, 24 h",
    meaning: "What the calls to this provider cost in the last day.",
    logic: [
      costRule,
      "Postgres sums `coalesce(reported_cost_usd, estimated_cost_usd)` per hour; the hours are added up.",
      "Shown as – when no call had a price. Estimates ignore free credits and plan discounts.",
      day24,
    ],
    source: "GET /v1/stats?bucket=hour → points[].costUsd",
  },
  lastSuccess: {
    title: "Last success",
    meaning: "When this provider last answered with results.",
    logic: [
      "The receive time (`timing.receivedAt`) of the most recent successful call the gateway tracked.",
      `Held in memory since start, or with \`SHARED_STATE\` found in the last ${HEALTH_WINDOW} logged calls, so "never" after a restart does not mean the provider has never worked.`,
    ],
    source: "GET /v1/status → providers[].lastOkAt",
  },
  queuedNow: {
    title: "Queued now",
    meaning: "Calls waiting right now for a free slot under the provider's outbound rate limit.",
    logic: [
      "Counted by the limiter of the gateway instance that answered: with several instances, each reports its own waiting calls.",
      "A call waits at most `maxQueueMs` (default 30 s), then fails as `throttled` without being sent.",
    ],
    source: "GET /v1/status → providers[].queueDepth · gateway limiter.ts depth()",
  },
  balance: {
    title: "Balance",
    meaning: "What the provider's own account says is left (or, for some providers, used).",
    logic: [
      "From the newest balance snapshot of any API key of this provider; snapshots are taken every `BALANCE_POLL_SECONDS` (default 300 s).",
      "Shows what is left when the provider reports it, otherwise what was used.",
      "Runway: what is left ÷ (the drop between the first and last snapshot of the last 24 h ÷ the hours between them). Needs an hour between them; hidden beyond 60 days.",
      `Marked stale when the snapshot is older than ${STALE_BALANCE_MS / 60_000} minutes, which suggests polling has stopped.`,
      "The account also counts use of the same key outside the gateway.",
    ],
    source: "GET /v1/usage → providers[].balance · dashboard overview.ts runwayHours()",
  },
  budget: {
    title: "Budget",
    meaning:
      "Spend counted against the provider's cap from `PROVIDER_BUDGETS`; at the cap the gateway refuses calls with `budget_exceeded`.",
    logic: [
      "Only successful calls count: calls as 1 each, dollars as reported cost else the estimate, credits as reported.",
      "Today is the UTC day, this month the UTC calendar month. With a database, spend is reloaded from the call log at start, so a restart does not reset it.",
      `The bar turns amber at ${WARN_SHARE * 100}% of the cap and red at the cap.`,
      "Forecast: spent so far, extrapolated linearly from UTC midnight, as `now + (cap − spent) / spent × elapsed`; shown after the first hour and only if it lands before midnight.",
    ],
    source: "GET /v1/providers → providers[].budget · gateway budget.ts",
  },
  providersTile: {
    title: "Providers",
    meaning: "How many configured providers are healthy, out of those with something to judge.",
    logic: [
      "Counts only providers with an API key set. Providers without calls since start are left out of the total and listed in the note.",
      "Over budget: the provider's cap is reached, so calls to it are refused.",
      healthBasis,
    ],
    source: "GET /v1/status → providers[].status, providers[].budgetBlocked",
  },
  callsTotal: {
    title: "Calls",
    meaning: "Search calls in the period, across all providers.",
    logic: [callRows, "Includes failed calls. Needs the call log."],
    source: "GET /v1/stats → sum of points[].calls",
  },
  failedShare: {
    title: "Failed",
    meaning: "The share of calls in the period that ended without results.",
    logic: [
      "failed calls ÷ all calls, as a percentage (one decimal below 1%).",
      "Failed means `ok` is false after all retries, including calls refused by a budget or the rate-limit queue.",
      callRows,
    ],
    source: "GET /v1/stats → points[].failures ÷ points[].calls",
  },
  costTotal: {
    title: "Cost",
    meaning: "What the calls in the period cost, across all providers.",
    logic: [
      costRule,
      "Providers with no price set are left out and named in the note.",
      "For what the accounts really changed by, see the cost check per API key on the Usage page.",
    ],
    source: "GET /v1/stats → sum of points[].costUsd",
  },
  providersUsed: {
    title: "Providers used",
    meaning: "Distinct providers with at least one call in the period.",
    logic: ["Labelled variants of one provider count once."],
    source: "GET /v1/stats → distinct points[].provider",
  },
  typicalLatency: {
    title: "Typical latency",
    meaning: "A typical successful call's duration per provider, with its worst tail.",
    logic: [
      "Postgres takes the median (`percentile_cont(0.5)`) of `latency_ms` of successful calls per bucket.",
      "The bar is the mean of those bucket medians, weighted by each bucket's successful calls: close to the overall median, but an approximation.",
      "p95 is the highest bucket p95 in the period, as on the Overview.",
      "Latency is the final attempt alone, without queueing or retries.",
    ],
    source: "GET /v1/stats → points[].p50LatencyMs, points[].p95LatencyMs",
  },
  keyCalls: {
    title: "Calls",
    meaning: "Calls made with this provider API key in the period.",
    logic: [callRows, "Includes failed calls."],
    source: "GET /v1/usage → providers[].calls",
  },
  keyFingerprint: {
    title: "Key",
    meaning: "Which provider API key the row is about, without revealing it.",
    logic: ["The first 8 hex digits of the key's SHA-256. A rotated key starts a new row."],
    source: "GET /v1/usage → providers[].keyFingerprint",
  },
  requestsSent: {
    title: "Requests sent",
    meaning: "HTTP requests that actually went to the provider, retries included.",
    logic: [
      "The sum of every call's attempts (`jsonb_array_length(attempts)`).",
      "Higher than Calls when calls were retried; refused calls (budget, queue) add 0.",
    ],
    source: "GET /v1/usage → providers[].upstreamRequests",
  },
  reported: {
    title: "Reported",
    meaning: "What the provider itself said the calls cost.",
    logic: [
      "The sum of `usage.costUsd` over the calls; for providers that report credits instead of dollars, the sum of `usage.credits`.",
      "– when the provider reports neither (Brave, You.com, fastCRW).",
    ],
    source: "GET /v1/usage → providers[].reportedCostUsd, providers[].credits",
  },
  estimated: {
    title: "Estimated",
    meaning: "What the calls cost at the gateway's list prices.",
    logic: [
      "Per successful call: credits × price per credit, or the price per request plus any results beyond those included.",
      "Prices are the built-in defaults merged with `PROVIDER_PRICING`; free credits are ignored, so providers stay comparable.",
    ],
    source: "GET /v1/usage → providers[].estimatedCostUsd · gateway cost.ts estimateCost()",
  },
  accountChange: {
    title: "Account change",
    meaning:
      "What the provider's account says was spent in the period: the ground truth to check the estimates against.",
    logic: [
      "The difference between the first and the last balance snapshot inside the period: `last.used − first.used`, or `first.remaining − last.remaining`.",
      "– with fewer than two snapshots, or when the balance rose (a top-up or a new billing period).",
      "Includes use of the same key outside the gateway, and some providers update their counters late.",
    ],
    source: "GET /v1/usage → providers[].balance.window.spent · gateway store.ts spentBetween()",
  },
  balanceNow: {
    title: "Balance now",
    meaning: "The newest snapshot of the account, whatever the period.",
    logic: [
      "What is left when the provider reports it, otherwise what was used.",
      "Snapshots are taken every `BALANCE_POLL_SECONDS` (default 300 s).",
    ],
    source: "GET /v1/usage → providers[].balance.latest",
  },
  sent: {
    title: "Sent",
    meaning: "When the call's final attempt was sent, in your local time.",
    logic: [
      "The wall clock just before the last upstream request (`timing.sentAt`).",
      "A call that queued or retried started earlier, by about Total minus Final attempt.",
    ],
    source: "timing.sentAt",
  },
  totalTime: {
    title: "Total time",
    meaning: "How long the caller waited for this call, end to end.",
    logic: [
      "Measured on the monotonic clock from the gateway starting this provider's call to its response being ready (`timing.totalMs`).",
      "Includes queueing under the rate limit, every attempt and the backoff waits between them.",
      "With fallbacks, each provider's call has its own total.",
    ],
    source: "timing.totalMs",
  },
  finalAttempt: {
    title: "Final attempt",
    meaning: "How long the last upstream request took on its own.",
    logic: [
      "From just before sending to the last byte of the answer, on the monotonic clock (`timing.latencyMs`).",
      "The phases below add up to it; queueing and earlier attempts are not included.",
    ],
    source: "timing.latencyMs",
  },
  queued: {
    title: "Queued",
    meaning: "Time spent waiting for a slot under the provider's outbound rate limit.",
    logic: [
      "Summed over all attempts (`timing.queuedMs`); each retry queues again.",
      "Shown as – below 1 ms. A call that waited `maxQueueMs` without a slot fails as `throttled`.",
    ],
    source: "timing.queuedMs",
  },
  retries: {
    title: "Retries",
    meaning: "Extra attempts after the first one failed transiently.",
    logic: [
      "Timeouts, network errors, 429 and 5xx answers are retried, up to `maxRetries` (default 5).",
      "Each wait doubles from `RETRY_BASE_MS` (500 ms), drawn from the upper half of its step, capped at `RETRY_MAX_MS` (8 s); a longer `Retry-After` wins, within the cap.",
    ],
    source: "retries.count · gateway search.ts backoffDelay()",
  },
  backoff: {
    title: "Backoff",
    meaning: "Total time spent waiting between attempts.",
    logic: ["The sum of every wait before a retry (`retries.backoffMs`); 0 without retries."],
    source: "retries.backoffMs",
  },
  upstreamStatus: {
    title: "Upstream status",
    meaning: "The HTTP status the provider answered on the final attempt.",
    logic: [
      "– when no answer arrived (timeout or network error) or nothing was sent (budget, queue).",
    ],
    source: "upstream.status",
  },
  results: {
    title: "Results",
    meaning: "Results the provider returned, after the gateway's clean-up.",
    logic: [
      "Results without a URL are dropped.",
      "At most `maxResults`, which is capped at the provider's own maximum with a warning.",
    ],
    source: "results.length",
  },
  cost: {
    title: "Cost",
    meaning: "What this call cost.",
    logic: [
      "`reported`: the provider said so (`usage.costUsd`).",
      "`estimated`: the gateway's list price (`usage.estimatedCostUsd`), from credits × price per credit or price per request plus extra results.",
      "`unknown`: the provider reports nothing and no price is set. Failed calls cost nothing.",
    ],
    source: "usage.costSource · gateway cost.ts withCost()",
  },
  credits: {
    title: "Credits",
    meaning: "Billing units the provider says this call used, in its own unit.",
    logic: [
      "Only providers that report it per call (Tavily, Firecrawl; Parallel reports request counts).",
    ],
    source: "usage.credits",
  },
  dated: {
    title: "Dated",
    meaning: "Results that carry a publish date.",
    logic: [
      "Counts results whose `publishedAt` is not null after the gateway normalised the provider's date to UTC.",
      'Relative dates such as "8 minutes ago" count, resolved against when the answer arrived.',
    ],
    source: "results[].publishedAt",
  },
  unique: {
    title: "Unique",
    meaning: "Results no other provider in this comparison returned.",
    logic: [
      "URLs are compared after normalising: lower-case host without `www.`, `m.` or `amp.`, no trailing slash, tracking parameters (`utm_*`, `gclid`, …) removed, the rest sorted.",
    ],
    source: "dashboard playground.ts normalizeUrl(), sharedResults()",
  },
  newest: {
    title: "Newest",
    meaning: "How old the most recently published result is.",
    logic: ["The latest `publishedAt` among the results; – when none is dated."],
    source: "results[].publishedAt",
  },
  phaseQueue: {
    title: "Queue",
    meaning: "Waiting under the gateway's outbound rate limit, before anything is sent.",
    logic: ["Summed over all attempts (`timing.queuedMs`), so it can exceed the final attempt."],
    source: "timing.queuedMs",
  },
  phaseDns: {
    title: "DNS",
    meaning: "Looking up the provider's host name.",
    logic: [
      "From starting the request to the socket's `lookup` event.",
      '"reused" when a kept-alive connection was reused, so no lookup happened.',
    ],
    source: "timing.phases.dnsMs · gateway transport.ts",
  },
  phaseConnect: {
    title: "Connect",
    meaning: "Opening the TCP connection.",
    logic: [
      'From the DNS answer to the socket\'s `connect` event; "reused" on a kept-alive connection.',
    ],
    source: "timing.phases.connectMs · gateway transport.ts",
  },
  phaseTls: {
    title: "TLS",
    meaning: "The TLS handshake that secures the connection.",
    logic: ['From `connect` to `secureConnect`; "reused" on a kept-alive connection.'],
    source: "timing.phases.tlsMs · gateway transport.ts",
  },
  phaseTtfb: {
    title: "First byte",
    meaning:
      "The provider's thinking time: from the connection being ready to the response headers arriving.",
    logic: [
      "Starts when the connection is ready (after TLS, or at once on a reused connection) and so includes writing the request.",
      "Usually the bulk of the latency, since the search itself happens here.",
    ],
    source: "timing.phases.ttfbMs · gateway transport.ts",
  },
  phaseDownload: {
    title: "Download",
    meaning: "Receiving the response body.",
    logic: ["From the response headers to the last byte, including decompression."],
    source: "timing.phases.downloadMs · gateway transport.ts",
  },
} satisfies Record<string, MetricDoc>;

export type MetricId = keyof typeof METRIC_DOCS;
