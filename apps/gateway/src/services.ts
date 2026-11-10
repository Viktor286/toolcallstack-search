import type { FastifyBaseLogger } from "fastify";
import type { BudgetTracker } from "./budget.ts";
import type { Config } from "./config.ts";
import type { Pricing } from "./cost.ts";
import type { HealthTracker } from "./health.ts";
import type { Limits, ProviderLimiter } from "./limiter.ts";
import type { Metrics } from "./metrics.ts";
import type { SearchDeps } from "./search.ts";
import type { Store } from "./store.ts";

/** Shared state that route plugins reach through `app.services`. */
export interface Services {
  config: Config;
  env: Record<string, string | undefined>;
  metrics: Metrics;
  store: Store | null;
  limits: Record<string, Limits>;
  limiter: ProviderLimiter;
  budget: BudgetTracker;
  health: HealthTracker;
  startedAt: Date;
  pricing: Record<string, Pricing | undefined>;
  searchDeps(log: FastifyBaseLogger): SearchDeps;
}

declare module "fastify" {
  interface FastifyInstance {
    services: Services;
  }
  interface FastifyRequest {
    /** Name of the gateway API key that authenticated this request; null when auth is off. */
    client: string | null;
  }
}
