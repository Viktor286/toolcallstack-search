import { randomUUID, timingSafeEqual } from "node:crypto";
import bearerAuth from "@fastify/bearer-auth";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import underPressure from "@fastify/under-pressure";
import * as promClient from "@prometheus-io/client";
import Fastify from "fastify";
import type postgres from "postgres";
import fastifyMetrics from "fastify-metrics";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { balanceCredential, startBalancePoller } from "./balances.ts";
import { BudgetTracker } from "./budget.ts";
import { ResponseCache } from "./cache.ts";
import type { Config } from "./config.ts";
import { HealthTracker } from "./health.ts";
import { ProviderLimiter, type Limiter } from "./limiter.ts";
import { createMetrics } from "./metrics.ts";
import { demoProviders, withDemo } from "./providers/demo.ts";
import { allProviders, providers as realProviders } from "./providers/index.ts";
import { agentRoutes } from "./routes/agents.ts";
import { callRoutes } from "./routes/calls.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { providerRoutes } from "./routes/providers.ts";
import { searchRoutes } from "./routes/search.ts";
import { statusRoutes } from "./routes/status.ts";
import { uiRoutes } from "./routes/ui.ts";
import type { Services } from "./services.ts";
import { PostgresLimiter } from "./shared-limiter.ts";
import type { Store } from "./store.ts";
import type { Tracing } from "./tracing.ts";
import { VERSION } from "./version.ts";
import { createTransport, type Transport } from "./transport.ts";

export interface AppOptions {
  config: Config;
  store?: Store | null;
  transport?: Transport;
  env?: Record<string, string | undefined>;
  /** Replaces the wait between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Directory of the built dashboard; defaults to apps/dashboard/dist. */
  uiDir?: string;
  /** Length of the outbound rate-limit window; tests shorten it. */
  limitWindowMs?: number;
  /** Connection for state shared between instances; required when SHARED_STATE is on. */
  sql?: postgres.Sql;
  /** Set when OpenTelemetry tracing is on; see tracing.ts. */
  tracing?: Tracing | null;
}

export async function buildApp(options: AppOptions) {
  const { config } = options;
  const store = options.store ?? null;
  const demo =
    config.DEMO_MODE === "true" ||
    (config.DEMO_MODE === "auto" &&
      !realProviders.some((provider) => (options.env ?? process.env)[provider.envVar]));
  // The demo providers are "configured" through this variable, like a real one through its key.
  const env: Record<string, string | undefined> = {
    ...(options.env ?? process.env),
    DEMO_MODE: demo ? "on" : undefined,
  };
  const providers = demo ? allProviders : realProviders;
  const transport = withDemo(options.transport ?? createTransport());
  // With tracing on, latency histograms link to traces through exemplars.
  const metrics = createMetrics({ exemplars: Boolean(options.tracing) });

  // Environment overrides are merged over the defaults each provider declares.
  const limits = Object.fromEntries(
    allProviders.map((p) => [p.id, { ...p.limits, ...config.PROVIDER_LIMITS[p.id] }]),
  );
  const pricing = Object.fromEntries(
    allProviders.map((p) => {
      const merged = { ...p.pricing, ...config.PROVIDER_PRICING[p.id] };
      return [p.id, Object.keys(merged).length > 0 ? merged : undefined];
    }),
  );
  if (config.SHARED_STATE && !(options.sql && store)) {
    throw new Error("SHARED_STATE needs DATABASE_URL: shared state is kept in Postgres");
  }
  const limiter: Limiter =
    config.SHARED_STATE && options.sql
      ? new PostgresLimiter(options.sql, limits, options.limitWindowMs, (error) =>
          app.log.warn(
            { err: error },
            "shared rate limits are unreachable in Postgres; this call uses this instance's own limits",
          ),
        )
      : new ProviderLimiter(limits, options.limitWindowMs);
  const health = new HealthTracker();
  const cache = new ResponseCache(config.CACHE_MAX_ENTRIES);
  const budget = new BudgetTracker(config.PROVIDER_BUDGETS);
  const clients = config.GATEWAY_API_KEYS.map((entry) => ({
    name: entry.name,
    key: Buffer.from(entry.key),
  }));

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Before any route, so every request gets a span and continues the caller's trace.
  if (options.tracing) await app.register(options.tracing.plugin);

  const services: Services = {
    config,
    env,
    metrics,
    store,
    providers,
    limits,
    limiter,
    budget,
    health,
    startedAt: new Date(),
    pricing,
    searchDeps: (log) => ({
      transport,
      env,
      defaultTimeoutMs: config.DEFAULT_TIMEOUT_MS,
      defaultMaxQueueMs: config.MAX_QUEUE_MS,
      retry: {
        maxRetries: config.MAX_RETRIES,
        baseMs: config.RETRY_BASE_MS,
        maxMs: config.RETRY_MAX_MS,
        sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        random: Math.random,
      },
      limiter,
      budget,
      health,
      pricing,
      metrics,
      store,
      cache,
      defaultCacheTtlSeconds: config.CACHE_TTL_SECONDS,
      log,
    }),
  };
  app.decorate("services", services);
  app.decorateRequest("client", null);

  app.setErrorHandler(
    (error: { statusCode?: number; validation?: unknown; message: string }, request, reply) => {
      const status = error.statusCode ?? 500;
      if (status >= 500 && status !== 503) request.log.error({ err: error }, "request failed");
      const type = error.validation
        ? "invalid_request"
        : ({ 401: "unauthorized", 429: "rate_limited", 503: "overloaded" }[status] ??
          (status >= 500 ? "internal_error" : "bad_request"));
      return reply.code(status).send({
        error: { type, message: type === "internal_error" ? "internal error" : error.message },
      });
    },
  );

  await app.register(swagger, {
    openapi: {
      info: {
        title: "toolcallstack-search",
        description: "Unified API gateway for web search providers",
        version: VERSION,
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Runtime and per-route HTTP metrics, on the same registry as the gateway's own.
  // The package is CommonJS with a named default, so the plugin sits on `.default`.
  await app.register(fastifyMetrics.default, {
    endpoint: null,
    promClient,
    defaultMetrics: { enabled: true, register: metrics.registry },
    routeMetrics: {
      enabled: { histogram: true, summary: false },
      overrides: {
        histogram: { registers: [metrics.registry] },
        summary: { registers: [metrics.registry] },
      },
    },
  });

  // A saturated event loop delays every timestamp, so shed load rather than record skewed timings.
  if (config.MAX_EVENT_LOOP_DELAY_MS > 0) {
    await app.register(underPressure, {
      maxEventLoopDelay: config.MAX_EVENT_LOOP_DELAY_MS,
      message: "gateway is overloaded",
      retryAfter: 1,
    });
  }

  // The API proper: authenticated and rate limited. Health, metrics and docs stay public.
  if (demo) {
    app.log.info(
      { providers: demoProviders.map((provider) => provider.id) },
      "demo mode: built-in providers answer with generated results, nothing is sent upstream",
    );
  }
  if (config.GATEWAY_API_KEYS.length === 0) {
    app.log.warn(
      "GATEWAY_API_KEYS is not set: the API is open to anyone who can reach this port, and every call spends provider credits",
    );
  }
  await app.register(async (api) => {
    if (config.GATEWAY_API_KEYS.length > 0) {
      await api.register(bearerAuth, {
        keys: new Set<string>(),
        // The plugin types the body as { error: string }, but it sends whatever is returned,
        // and the gateway's error shape is { error: { type, message } } everywhere.
        errorResponse: ((error: Error) => ({
          error: { type: "unauthorized", message: error.message },
        })) as never,
        // A wrong token is the caller's mistake, not a gateway error worth an error-level log.
        verifyErrorLogLevel: "debug",
        // Find which client the token belongs to, comparing in constant time.
        auth: (token, request) => {
          const given = Buffer.from(token);
          const match = clients.find(
            (client) => client.key.length === given.length && timingSafeEqual(client.key, given),
          );
          request.client = match?.name ?? null;
          return Boolean(match);
        },
      });
    }
    if (config.INBOUND_RATE_LIMIT_RPM > 0) {
      await api.register(rateLimit, {
        max: config.INBOUND_RATE_LIMIT_RPM,
        timeWindow: "1 minute",
        keyGenerator: (request) => request.client ?? request.ip,
      });
    }
    await api.register(providerRoutes);
    await api.register(searchRoutes);
    await api.register(callRoutes);
    await api.register(statusRoutes);
    await api.register(mcpRoutes);
  });
  await app.register(agentRoutes);
  await app.register(uiRoutes, { dir: options.uiDir });

  // Liveness only: answers as long as the process serves requests. See /v1/status for detail.
  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));

  app.get("/ready", { schema: { hide: true } }, async (_request, reply) => {
    try {
      await store?.ping();
      return { status: "ready", store: store ? "postgres" : "none" };
    } catch {
      return reply.code(503).send({ status: "unavailable", store: "unreachable" });
    }
  });

  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    for (const provider of providers) {
      metrics.queueDepth.set({ provider: provider.id }, limiter.depth(provider.id));
    }
    for (const { provider, period, spend } of budget.spent()) {
      for (const [unit, value] of Object.entries(spend)) {
        metrics.budgetSpent.set({ provider, period, unit }, value);
      }
    }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  const timers: NodeJS.Timeout[] = [];
  let stopBalancePoller: (() => void) | undefined;
  if (store && config.SHARED_STATE) {
    // Other instances spend the same budgets and see the same providers, so this one
    // regularly replaces its own counts with what the shared call log says.
    const zero = { calls: 0, usd: 0, credits: 0 };
    services.syncShared = async () => {
      const { dayStart, monthStart } = budget.windows();
      const [spends, outcomes] = await Promise.all([
        store.spendSince(dayStart, monthStart),
        store.recentOutcomes(20),
      ]);
      for (const provider of allProviders) {
        const spend = spends.find((entry) => entry.provider === provider.id);
        budget.replace(provider.id, spend?.day ?? zero, spend?.month ?? zero);
        health.replace(
          provider.id,
          outcomes.filter((outcome) => outcome.provider === provider.id),
        );
      }
    };
    app.addHook("onReady", async () => {
      const sync = () =>
        services.syncShared?.().catch((error: unknown) => {
          app.log.error({ err: error }, "could not reload shared state from the call log");
        });
      await sync();
      const timer = setInterval(() => void sync(), config.SHARED_STATE_SYNC_SECONDS * 1000);
      timer.unref();
      timers.push(timer);
      app.log.info("shared state: rate limits, budgets and provider health are kept in Postgres");
    });
  }
  if (store) {
    app.addHook("onReady", async () => {
      // Budgets continue from what the call log says was already spent today and this month.
      try {
        const { dayStart, monthStart } = budget.windows();
        // With shared state the sync above has already loaded it.
        const spends = config.SHARED_STATE ? [] : await store.spendSince(dayStart, monthStart);
        for (const spend of spends) {
          budget.seed(spend.provider, spend.day, spend.month);
        }
      } catch (error) {
        app.log.error(
          { err: error },
          "could not load spend from the call log; budgets start at zero",
        );
      }

      const retention = {
        callDays: config.CALL_LOG_RETENTION_DAYS,
        rawDays: config.RAW_RETENTION_DAYS,
      };
      if (retention.callDays > 0 || retention.rawDays > 0) {
        const clean = () =>
          store.cleanup(retention).then(
            (removed) => app.log.info(removed, "call log retention applied"),
            (error: unknown) => app.log.error({ err: error }, "call log retention failed"),
          );
        void clean();
        const timer = setInterval(() => void clean(), 86_400_000);
        timer.unref();
        timers.push(timer);
      }
    });
  }

  // A `minRemaining` floor can only be held to with a balance that cannot be read, so say so.
  for (const provider of realProviders) {
    if (!budget.hasFloor(provider.id) || !env[provider.envVar]) continue;
    const problem = !provider.balance
      ? "the provider has no balance endpoint"
      : !balanceCredential(provider, env)
        ? `${provider.balance.credentialEnvVar} is not set`
        : config.BALANCE_POLL_SECONDS === 0
          ? "BALANCE_POLL_SECONDS is 0"
          : null;
    if (problem) {
      app.log.warn({ provider: provider.id }, `minRemaining cannot apply: ${problem}`);
    }
  }
  // Snapshots need the call log, but a `minRemaining` floor needs balances even without one.
  const floors = realProviders.some((provider) => budget.hasFloor(provider.id));
  if (config.BALANCE_POLL_SECONDS > 0 && (store || floors)) {
    app.addHook("onReady", async () => {
      stopBalancePoller = startBalancePoller(
        { transport, env, store, metrics, budget, log: app.log },
        config.BALANCE_POLL_SECONDS,
      );
    });
  }

  app.addHook("onClose", async () => {
    stopBalancePoller?.();
    for (const timer of timers) clearInterval(timer);
    await store?.close();
    await options.tracing?.shutdown();
  });

  return app;
}
