import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { searchParamsSchema, statusResponseSchema } from "../schema.ts";
import { executeSearch } from "../search.ts";
import { VERSION } from "../version.ts";

export const statusRoutes: FastifyPluginAsyncZod = async (app) => {
  const { env, store, providers, health, limiter, budget, startedAt, searchDeps } = app.services;

  app.get(
    "/v1/status",
    {
      schema: {
        summary: "Health of the gateway and of each provider",
        description:
          "Provider health is derived from real traffic since the process started. With `probe=true` the gateway first sends one live one-result search to every configured provider, which spends provider credits.",
        querystring: z.object({ probe: z.enum(["true", "false"]).default("false") }),
        response: { 200: statusResponseSchema },
      },
    },
    async (request) => {
      if (request.query.probe === "true") {
        const params = searchParamsSchema.parse({
          query: "latest news",
          maxResults: 1,
          maxRetries: 0,
          timeoutMs: 15_000,
        });
        const deps = searchDeps(request.log);
        await Promise.all(
          providers
            .filter((provider) => env[provider.envVar])
            .map((provider) => executeSearch(deps, { provider: provider.id }, params)),
        );
      }

      const storeStatus = !store
        ? ("none" as const)
        : await store.ping().then(
            () => "ok" as const,
            () => "unreachable" as const,
          );
      const list = providers.map((provider) => ({
        id: provider.id,
        configured: Boolean(env[provider.envVar]),
        queueDepth: limiter.depth(provider.id),
        budgetBlocked: budget.blocked(provider.id),
        ...health.snapshot(provider.id),
      }));
      const degraded =
        storeStatus === "unreachable" || list.some((p) => p.configured && p.status === "down");
      return {
        status: degraded ? ("degraded" as const) : ("ok" as const),
        version: VERSION,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        store: storeStatus,
        providers: list,
      };
    },
  );
};
