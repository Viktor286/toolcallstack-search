import { z } from "zod";
import { keyFingerprint } from "./util.ts";

const flag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

/** A JSON object keyed by provider id, e.g. {"tavily":{"rpm":100}}. */
const jsonByProvider = <T extends z.ZodType>(value: T) =>
  z
    .string()
    .default("{}")
    .transform((text, ctx) => {
      try {
        return z.record(z.string(), value).parse(JSON.parse(text));
      } catch (error) {
        ctx.addIssue({ code: "custom", message: `invalid JSON: ${String(error)}` });
        return z.NEVER;
      }
    });

/**
 * Comma-separated gateway API keys. An entry may be `name:token` so calls are attributed to
 * that client; a bare token gets a generated name.
 */
export function parseApiKeys(value: string): { name: string; key: string }[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const named = /^([\w.-]+):(.+)$/.exec(entry);
      return named
        ? { name: named[1]!, key: named[2]! }
        : { name: `key-${keyFingerprint(entry)}`, key: entry };
    });
}

const budgetCaps = z.object({
  calls: z.number().int().min(0).optional(),
  usd: z.number().min(0).optional(),
  credits: z.number().min(0).optional(),
});

const configSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(4310),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Bearer tokens allowed to call the gateway, see parseApiKeys; empty disables auth. */
  GATEWAY_API_KEYS: z.string().default("").transform(parseApiKeys),
  /**
   * Built-in demo providers that answer without any network or account. `auto` offers them
   * only while no real provider has an API key.
   */
  DEMO_MODE: z.enum(["auto", "true", "false"]).default("auto"),
  /** Postgres connection string. When unset, calls are logged but not stored. */
  DATABASE_URL: z.string().optional(),
  /**
   * Keep outbound rate limits, budgets and provider health in Postgres so several gateway
   * instances act as one. Needs DATABASE_URL.
   */
  SHARED_STATE: flag,
  /** How often an instance reloads budgets and provider health from the call log. */
  SHARED_STATE_SYNC_SECONDS: z.coerce.number().min(0.1).default(10),
  /** Also store the untouched upstream body with every call. */
  STORE_RAW: flag,
  DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
  /** Retries per call after a timeout, network error, 429 or 5xx, with exponential backoff. */
  MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  RETRY_BASE_MS: z.coerce.number().int().min(1).default(500),
  RETRY_MAX_MS: z.coerce.number().int().min(1).default(8000),
  /** Outbound limits per provider, merged over each provider's defaults. */
  PROVIDER_LIMITS: jsonByProvider(
    z.object({
      rpm: z.number().int().min(1).optional(),
      concurrency: z.number().int().min(1).optional(),
    }),
  ),
  /** Longest a call may wait for a slot under a provider limit before failing as throttled. */
  MAX_QUEUE_MS: z.coerce.number().int().min(0).default(30_000),
  /** List prices per provider, merged over each provider's defaults. */
  PROVIDER_PRICING: jsonByProvider(
    z.object({
      perCreditUsd: z.number().min(0).optional(),
      perRequestUsd: z.number().min(0).optional(),
      includedResults: z.number().int().min(0).optional(),
      perExtraResultUsd: z.number().min(0).optional(),
    }),
  ),
  /**
   * Spend caps per provider: {"tavily":{"daily":{"credits":50},"monthly":{"usd":5},"minRemaining":100}}.
   * A capped provider answers `budget_exceeded` instead of being called.
   */
  PROVIDER_BUDGETS: jsonByProvider(
    z.object({
      daily: budgetCaps.optional(),
      monthly: budgetCaps.optional(),
      minRemaining: z.number().min(0).optional(),
    }),
  ),
  /** Delete logged calls and balance snapshots older than this many days; 0 keeps them forever. */
  CALL_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  /** Drop stored raw upstream bodies older than this many days; 0 keeps them as long as the call. */
  RAW_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  /** How often to snapshot provider account balances; 0 disables. Needs DATABASE_URL. */
  BALANCE_POLL_SECONDS: z.coerce.number().int().min(0).default(300),
  /** Requests per minute allowed per gateway API key (or client IP); 0 disables. */
  INBOUND_RATE_LIMIT_RPM: z.coerce.number().int().min(0).default(0),
  /** Answer 503 while the event loop lags by more than this, since timings would be skewed; 0 disables. */
  MAX_EVENT_LOOP_DELAY_MS: z.coerce.number().int().min(0).default(1000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
