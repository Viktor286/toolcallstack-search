import { z } from "zod";
import { errorTypes } from "./error-types.ts";

export { errorTypes, type ErrorType } from "./error-types.ts";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  // The format alone lets 2026-02-31 through; a provider would reject it, or worse, roll it over.
  .refine((text) => {
    // Runs even when the format check failed, so the date may not parse at all.
    const date = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
  }, "not a calendar date")
  .describe("Calendar date, YYYY-MM-DD (UTC)");

/** A date range that ends before it starts would be sent upstream and fail there. */
function datesInOrder(params: { startDate?: string; endDate?: string }, ctx: z.RefinementCtx) {
  if (params.startDate && params.endDate && params.startDate > params.endDate) {
    ctx.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "endDate is before startDate",
    });
  }
}

export const freshnessValues = ["hour", "day", "week", "month", "year"] as const;

/**
 * Provider-independent search parameters, as a plain object so the request
 * schemas can extend it; checks across fields are added to each final schema.
 */
const searchParamsObject = z.object({
  query: z.string().min(1).max(2000),
  maxResults: z.number().int().min(1).max(100).default(10),
  topic: z.enum(["general", "news"]).default("general"),
  freshness: z
    .enum(freshnessValues)
    .optional()
    .describe("Only results published within the last hour/day/week/month/year"),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  includeDomains: z.array(z.string().min(1)).max(100).optional(),
  excludeDomains: z.array(z.string().min(1)).max(100).optional(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "expected ISO 3166-1 alpha-2 code")
    .optional(),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Provider-specific fields, deep-merged into the upstream request as-is"),
  includeRaw: z.boolean().default(false).describe("Return the untouched upstream response body"),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(120_000)
    .optional()
    .describe("Timeout for each attempt, not for the call as a whole"),
  maxQueueMs: z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .optional()
    .describe(
      "Longest wait for a free slot under the provider's rate limit; 0 fails at once instead of queueing",
    ),
  maxRetries: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Retries after a transient failure; 0 makes exactly one upstream request"),
  cacheTtlSeconds: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .optional()
    .describe(
      "Reuse an identical successful answer up to this many seconds old, and keep this answer as long; 0 turns caching off. Identical calls in flight share one upstream request.",
    ),
});
export const searchParamsSchema = searchParamsObject.superRefine(datesInOrder);
export type SearchParams = z.infer<typeof searchParamsSchema>;

/** The search request without its checks across fields, for picking tool arguments from. */
export const searchRequestObject = searchParamsObject.extend({
  provider: z.string().min(1),
  fallbacks: z
    .array(z.string().min(1))
    .max(5)
    .optional()
    .describe("Providers to try in order when the previous one fails, after its own retries"),
});
export const searchRequestSchema = searchRequestObject.superRefine(datesInOrder);

const batchTargetSchema = z.union([
  z.string().min(1),
  z.object({
    provider: z.string().min(1),
    label: z
      .string()
      .min(1)
      .optional()
      .describe("Name for this variant, e.g. 'you+knowledge'; defaults to the provider id"),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const batchRequestSchema = searchParamsObject
  .extend({
    providers: z
      .array(batchTargetSchema)
      .min(1)
      .max(32)
      .describe("Providers to query at the same instant; use objects to run labelled variants"),
  })
  .superRefine(datesInOrder);
export type BatchRequest = z.infer<typeof batchRequestSchema>;

export const searchResultSchema = z.object({
  position: z.number().int().describe("1-based rank in the upstream response"),
  url: z.string(),
  canonicalUrl: z
    .string()
    .describe(
      "The url normalised for matching the same page across providers (https, host without www, no tracking parameters); not for fetching",
    ),
  title: z.string(),
  snippet: z.string(),
  publishedAt: z
    .string()
    .nullable()
    .describe("Publish time reported by the provider, normalised to ISO 8601 UTC"),
  publishedRaw: z.string().nullable().describe("Publish time exactly as the provider returned it"),
  publishedPrecision: z
    .enum(["datetime", "date", "relative"])
    .nullable()
    .describe(
      "How precise publishedRaw was; 'relative' means derived from text like '2 hours ago'",
    ),
  score: z.number().nullable(),
  source: z.enum(["web", "news"]),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const usageSchema = z.object({
  credits: z.number().optional().describe("Provider billing units consumed, as reported"),
  costUsd: z.number().optional().describe("Dollar cost, as reported by the provider"),
  estimatedCostUsd: z
    .number()
    .optional()
    .describe("List-price cost from the gateway's price table, ignoring free credits"),
  costSource: z
    .enum(["reported", "estimated", "unknown", "cache"])
    .describe(
      "Which figure to use: costUsd, estimatedCostUsd, neither is known, or cache (answered from the cache, nothing billed)",
    ),
});
export type Usage = z.infer<typeof usageSchema>;

export const searchErrorSchema = z.object({
  type: z.enum(errorTypes),
  message: z.string(),
  upstreamStatus: z.number().int().nullable(),
});
export type SearchError = z.infer<typeof searchErrorSchema>;

export const phasesSchema = z
  .object({
    dnsMs: z.number().nullable(),
    connectMs: z.number().nullable(),
    tlsMs: z.number().nullable(),
    ttfbMs: z.number().describe("Connection ready to response headers received"),
    downloadMs: z.number().describe("Response headers to last body byte"),
    connectionReused: z
      .boolean()
      .describe("True when a kept-alive connection was reused; dns/connect/tls are then null"),
  })
  .describe("Consecutive phases of one upstream request; they add up to its latency");

export const searchResponseSchema = z.object({
  id: z.string().describe("Gateway call id; also the primary key in the call log"),
  provider: z.string(),
  label: z.string(),
  query: z.string(),
  ok: z.boolean(),
  results: z.array(searchResultSchema),
  timing: z.object({
    sentAt: z.string().describe("Wall-clock time just before the final attempt was sent"),
    receivedAt: z.string().describe("Wall-clock time when the final attempt's body was fully read"),
    latencyMs: z.number().describe("Monotonic-clock duration of the final attempt alone"),
    totalMs: z
      .number()
      .describe(
        "Monotonic-clock duration of the whole call, including queueing, retries and waits",
      ),
    queuedMs: z
      .number()
      .describe("Total time attempts waited for a slot under the provider's rate limit"),
    phases: phasesSchema
      .nullable()
      .describe("Phases of the final attempt; null if it got no response"),
  }),
  retries: z.object({
    count: z.number().int().describe("Attempts made after the first one"),
    backoffMs: z.number().describe("Total time spent waiting between attempts"),
    attempts: z
      .array(
        z.object({
          sentAt: z.string(),
          queuedMs: z.number(),
          latencyMs: z.number(),
          phases: phasesSchema.nullable(),
          upstreamStatus: z.number().int().nullable(),
          error: z.enum(errorTypes).nullable(),
          backoffMs: z
            .number()
            .nullable()
            .describe("Wait before the next attempt; null on the final attempt"),
        }),
      )
      .describe("Every upstream request made for this call, in order"),
  }),
  usage: usageSchema,
  upstream: z.object({
    status: z.number().int().nullable(),
    requestId: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
  error: searchErrorSchema.nullable(),
  cache: z
    .object({
      hit: z.boolean(),
      ageMs: z.number().nullable().describe("Age of the reused answer; null on a miss"),
      sourceCallId: z
        .string()
        .nullable()
        .describe("Id of the call whose answer was reused; null on a miss"),
    })
    .nullable()
    .describe(
      "Null when the call did not allow caching. A hit sent nothing upstream and cost nothing; its timing is the gateway's own.",
    ),
  fallback: z
    .object({
      tried: z.array(
        z.object({ provider: z.string(), callId: z.string(), error: searchErrorSchema }),
      ),
    })
    .describe("Providers that failed before this one answered; empty without fallbacks"),
  raw: z.unknown().optional(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const batchResponseSchema = z.object({
  batchId: z.string(),
  query: z.string(),
  dispatchedAt: z.string().describe("Wall-clock time the fan-out started"),
  responses: z.array(searchResponseSchema),
});
export type BatchResponse = z.infer<typeof batchResponseSchema>;

const budgetCapsSchema = z.object({
  calls: z.number().optional(),
  usd: z.number().optional(),
  credits: z.number().optional(),
});
const budgetPeriodSchema = z
  .object({
    caps: budgetCapsSchema,
    spent: z.object({ calls: z.number(), usd: z.number(), credits: z.number() }),
  })
  .nullable();
export const budgetSchema = z.object({
  daily: budgetPeriodSchema.describe("Per UTC day"),
  monthly: budgetPeriodSchema.describe("Per UTC calendar month"),
  minRemaining: z.number().nullable().describe("Floor on the provider's reported balance"),
  remaining: z.number().nullable().describe("Balance at the last snapshot"),
  blocked: z.string().nullable().describe("Why calls are refused right now, or null"),
});

export const providerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  docs: z.string(),
  console: z
    .string()
    .nullable()
    .describe("The provider's web console for the account, keys and billing"),
  configured: z.boolean(),
  features: z.array(z.string()),
  maxResults: z.number().int(),
  limits: z.object({ rpm: z.number().optional(), concurrency: z.number().optional() }),
  pricing: z
    .object({
      perCreditUsd: z.number().optional(),
      perRequestUsd: z.number().optional(),
      includedResults: z.number().optional(),
      perExtraResultUsd: z.number().optional(),
    })
    .nullable(),
  budget: budgetSchema.nullable().describe("Spend caps and current spend; null when none is set"),
  reportsBalance: z.boolean().describe("Whether the gateway can read this account's balance"),
  balanceEnvVar: z
    .string()
    .nullable()
    .describe(
      "Variable holding the credential that reads the balance; null if there is no endpoint",
    ),
  envVar: z.string().describe("Variable holding the provider's API key"),
  notes: z.array(z.string()),
});

const providerHealthSchema = z.object({
  status: z
    .enum(["healthy", "degraded", "down", "unknown"])
    .describe(
      "From the last 20 calls (reloaded from the call log at start when there is one): down after 3 failures in a row, degraded after a failure or below 80% success, unknown before any call",
    ),
  recentCalls: z.number().int(),
  successRate: z.number().nullable(),
  medianLatencyMs: z.number().nullable(),
  consecutiveFailures: z.number().int(),
  lastOkAt: z.string().nullable(),
  lastError: z.object({ type: z.string(), message: z.string(), at: z.string() }).nullable(),
});

export const statusResponseSchema = z.object({
  status: z
    .enum(["ok", "degraded"])
    .describe("degraded when the store or a configured provider is down"),
  version: z.string(),
  startedAt: z.string(),
  uptimeSeconds: z.number(),
  store: z.enum(["ok", "unreachable", "none"]),
  providers: z.array(
    providerHealthSchema.extend({
      id: z.string(),
      configured: z.boolean(),
      queueDepth: z.number().int(),
      budgetBlocked: z.string().nullable().describe("Why the budget refuses calls, or null"),
    }),
  ),
});

export const callsQuerySchema = z.object({
  provider: z.string().optional(),
  label: z.string().optional(),
  client: z.string().optional().describe("Name of the gateway API key that made the call"),
  ok: z.enum(["true", "false"]).optional(),
  errorType: z.enum(errorTypes).optional().describe("Only failed calls with this error type"),
  q: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Only calls whose query contains this text, ignoring case"),
  batchId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional().describe("Sent at or after this time"),
  to: z.iso.datetime({ offset: true }).optional().describe("Sent before this time"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional().describe("nextCursor from the previous page"),
});
export type CallsQuery = z.infer<typeof callsQuerySchema>;

export const callsResponseSchema = z.object({
  calls: z.array(searchResponseSchema),
  nextCursor: z.string().nullable(),
});

export const usageQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe("Default: 24 hours ago"),
  to: z.iso.datetime({ offset: true }).optional().describe("Default: now"),
  groupBy: z.enum(["client"]).optional().describe("Also break calls and cost down per client"),
});

export const statsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe("Default: 24 hours ago"),
  to: z.iso.datetime({ offset: true }).optional().describe("Default: now"),
  bucket: z.enum(["hour", "day"]).default("hour"),
});

export const statsResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  bucket: z.enum(["hour", "day"]),
  points: z.array(
    z.object({
      bucket: z.string().describe("Start of the bucket, UTC"),
      provider: z.string(),
      calls: z.number().int(),
      failures: z.number().int(),
      retries: z.number().int(),
      cacheHits: z.number().int().describe("Calls answered from the cache, included in calls"),
      p50LatencyMs: z
        .number()
        .nullable()
        .describe(
          "Median latency of successful calls, cache hits excluded; estimated from latency buckets, within 2.5%",
        ),
      p95LatencyMs: z
        .number()
        .nullable()
        .describe("95th percentile, estimated the same way as p50LatencyMs"),
      avgQueuedMs: z.number().nullable(),
      costUsd: z.number().nullable().describe("Reported cost where known, else the estimate"),
    }),
  ),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

const balancePointSchema = z.object({
  takenAt: z.string(),
  remaining: z.number().nullable(),
  used: z.number().nullable(),
  quota: z.number().nullable(),
});

export const usageResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  clients: z
    .array(
      z.object({
        client: z.string().nullable().describe("Null for calls made while auth was off"),
        provider: z.string(),
        calls: z.number().int(),
        okCalls: z.number().int(),
        upstreamRequests: z.number().int(),
        credits: z.number().nullable(),
        reportedCostUsd: z.number().nullable(),
        estimatedCostUsd: z.number().nullable(),
      }),
    )
    .optional()
    .describe("Present with groupBy=client"),
  providers: z.array(
    z.object({
      provider: z.string(),
      keyFingerprint: z.string().describe("First 8 hex digits of the API key's SHA-256"),
      calls: z.number().int(),
      okCalls: z.number().int(),
      upstreamRequests: z.number().int().describe("Attempts actually sent, including retries"),
      credits: z.number().nullable(),
      reportedCostUsd: z.number().nullable(),
      estimatedCostUsd: z.number().nullable(),
      balance: z
        .object({
          unit: z.enum(["usd", "credits"]),
          latest: balancePointSchema,
          window: z
            .object({
              first: balancePointSchema,
              last: balancePointSchema,
              spent: z.number().nullable().describe("Balance drop between first and last"),
              spentPerOkCall: z
                .number()
                .nullable()
                .describe("spent / okCalls; compare with the price table"),
            })
            .nullable()
            .describe("Null until the window holds two snapshots"),
        })
        .nullable(),
    }),
  ),
});
export type UsageResponse = z.infer<typeof usageResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});
