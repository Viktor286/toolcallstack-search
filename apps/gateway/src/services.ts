import type { FastifyBaseLogger } from "fastify";
import type { BudgetTracker } from "./budget.ts";
import type { Config } from "./config.ts";
import type { Pricing } from "./cost.ts";
import type { HealthTracker } from "./health.ts";
import type { Limiter, Limits } from "./limiter.ts";
import type { Metrics } from "./metrics.ts";
import type { Provider } from "./providers/types.ts";
import type { SearchDeps } from "./search.ts";
import type { Store } from "./store.ts";

/** Shared state that route plugins reach through `app.services`. */
export interface Services {
  config: Config;
  env: Record<string, string | undefined>;
  metrics: Metrics;
  store: Store | null;
  /** Providers this gateway offers: the real ones, plus the demo ones in demo mode. */
  providers: Provider[];
  limits: Record<string, Limits>;
  limiter: Limiter;
  budget: BudgetTracker;
  health: HealthTracker;
  startedAt: Date;
  pricing: Record<string, Pricing | undefined>;
  /** Reload budgets and provider health from the call log; set when SHARED_STATE is on. */
  syncShared?: () => Promise<void>;
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
