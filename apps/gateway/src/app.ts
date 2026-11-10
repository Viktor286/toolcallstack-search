import { randomUUID, timingSafeEqual } from "node:crypto";
import bearerAuth from "@fastify/bearer-auth";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import underPressure from "@fastify/under-pressure";
import * as promClient from "@prometheus-io/client";
import Fastify from "fastify";
import fastifyMetrics from "fastify-metrics";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { startBalancePoller } from "./balances.ts";
import { BudgetTracker } from "./budget.ts";
import type { Config } from "./config.ts";
import { HealthTracker } from "./health.ts";
import { ProviderLimiter } from "./limiter.ts";
import { createMetrics } from "./metrics.ts";
import { providers } from "./providers/index.ts";
import { agentRoutes } from "./routes/agents.ts";
import { callRoutes } from "./routes/calls.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { providerRoutes } from "./routes/providers.ts";
import { searchRoutes } from "./routes/search.ts";
import { statusRoutes } from "./routes/status.ts";
import { uiRoutes } from "./routes/ui.ts";
import type { Services } from "./services.ts";
import type { Store } from "./store.ts";
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
}

export async function buildApp(options: AppOptions) {
  const { config } = options;
  const store = options.store ?? null;
  const env = options.env ?? process.env;
  const transport = options.transport ?? createTransport();
  const metrics = createMetrics();

  // Environment overrides are merged over the defaults each provider declares.
  const limits = Object.fromEntries(
    providers.map((p) => [p.id, { ...p.limits, ...config.PROVIDER_LIMITS[p.id] }]),
  );
  const pricing = Object.fromEntries(
    providers.map((p) => {
      const merged = { ...p.pricing, ...config.PROVIDER_PRICING[p.id] };
      return [p.id, Object.keys(merged).length > 0 ? merged : undefined];
    }),
  );
  const limiter = new ProviderLimiter(limits, options.limitWindowMs);
  const health = new HealthTracker();
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

  const services: Services = {
    config,
    env,
    metrics,
    store,
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
  if (config.GATEWAY_API_KEYS.length === 0) {
    app.log.warn("GATEWAY_API_KEYS is empty: the gateway accepts unauthenticated requests");
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
  if (store) {
    app.addHook("onReady", async () => {
      // Budgets continue from what the call log says was already spent today and this month.
      try {
        const { dayStart, monthStart } = budget.windows();
        for (const spend of await store.spendSince(dayStart, monthStart)) {
          budget.seed(spend.provider, spend.day, spend.month);
        }
      } catch (error) {
        app.log.error(
          { err: error },
          "could not load spend from the call log; budgets start at zero",
        );
      }

      if (config.BALANCE_POLL_SECONDS > 0) {
        stopBalancePoller = startBalancePoller(
          { transport, env, store, metrics, budget, log: app.log },
          config.BALANCE_POLL_SECONDS,
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
  app.addHook("onClose", async () => {
    stopBalancePoller?.();
    for (const timer of timers) clearInterval(timer);
    await store?.close();
  });

  return app;
}
