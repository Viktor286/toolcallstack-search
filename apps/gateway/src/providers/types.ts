import type { Pricing } from "../cost.ts";
import type { Limits } from "../limiter.ts";
import type { SearchParams, SearchResult } from "../schema.ts";

/** Unified params a provider may or may not be able to honour. */
export type Feature =
  | "topic:news"
  | "freshness"
  | "freshness:hour"
  | "startDate"
  | "endDate"
  | "includeDomains"
  | "excludeDomains"
  | "country";

export interface UpstreamRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** JSON body for POST requests. */
  body?: Record<string, unknown>;
}

export interface ParseContext {
  params: SearchParams;
  /** Moment the upstream response arrived; anchors relative dates like "8 minutes ago". */
  receivedAt: Date;
}

export interface ParsedResponse {
  /** The gateway adds each result's position and canonical URL. */
  results: Omit<SearchResult, "position" | "canonicalUrl">[];
  /** Only what the provider itself reported for this call. */
  usage?: { credits?: number; costUsd?: number };
  upstreamRequestId?: string;
}

/** What an account has left, as the provider reports it. */
export interface Balance {
  unit: "usd" | "credits";
  remaining: number | null;
  used: number | null;
  quota: number | null;
}

export interface BalanceContext {
  /** The search API key whose usage is being read. */
  apiKey: string;
  /** Value of `credentialEnvVar`, or the search API key when none is needed. */
  credential: string;
  now: Date;
}

/**
 * A search provider is two pure functions around one HTTP call: build the
 * upstream request from unified params, and parse the upstream body into
 * unified results. Everything else (transport, timing, retries, limits, cost,
 * storage) lives in search.ts, so adding a provider means adding one file here
 * and one line in index.ts.
 */
export interface Provider {
  id: string;
  name: string;
  docs: string;
  /** Environment variable holding the API key. */
  envVar: string;
  /** Unified params this provider honours; anything else is dropped with a warning. */
  features: Feature[];
  /** Largest maxResults the upstream accepts in one call. */
  maxResults: number;
  /** Default outbound limits; PROVIDER_LIMITS overrides them. */
  limits?: Limits;
  /** Default list prices; PROVIDER_PRICING overrides them. */
  pricing?: Pricing;
  /** Things a caller should know: useful `options`, quirks, how results are dated. */
  notes: string[];
  /** Account balance or usage endpoint, for providers that have one. */
  balance?: {
    /** A separate credential, when the search key itself cannot read the account. */
    credentialEnvVar?: string;
    request(ctx: BalanceContext): { url: string; headers: Record<string, string> };
    parse(body: unknown): Balance | null;
  };
  buildRequest(params: SearchParams, apiKey: string, now: Date): UpstreamRequest;
  parseResponse(body: unknown, ctx: ParseContext): ParsedResponse;
}
