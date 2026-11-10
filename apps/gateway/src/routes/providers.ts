import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { balanceCredential } from "../balances.ts";
import { providersById } from "../providers/index.ts";
import type { Provider } from "../providers/types.ts";
import { apiErrorSchema, providerInfoSchema } from "../schema.ts";
import type { Services } from "../services.ts";

/** Everything a caller can know about a provider, without its secrets. */
export function describeProvider(
  provider: Provider,
  { env, limits, pricing, budget }: Pick<Services, "env" | "limits" | "pricing" | "budget">,
) {
  return {
    id: provider.id,
    name: provider.name,
    docs: provider.docs,
    configured: Boolean(env[provider.envVar]),
    envVar: provider.envVar,
    features: provider.features,
    maxResults: provider.maxResults,
    limits: limits[provider.id] ?? {},
    pricing: pricing[provider.id] ?? null,
    budget: budget.snapshot(provider.id),
    reportsBalance: Boolean(env[provider.envVar] && balanceCredential(provider, env)),
    balanceEnvVar: provider.balance ? (provider.balance.credentialEnvVar ?? provider.envVar) : null,
    notes: provider.notes,
  };
}

export const providerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/providers",
    {
      schema: {
        summary: "List providers with what each supports, its limits and its prices",
        response: { 200: z.object({ providers: z.array(providerInfoSchema) }) },
      },
    },
    async () => ({
      providers: app.services.providers.map((provider) => describeProvider(provider, app.services)),
    }),
  );

  app.get(
    "/v1/providers/:id",
    {
      schema: {
        summary: "One provider in detail",
        params: z.object({ id: z.string() }),
        response: { 200: providerInfoSchema, 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const provider = providersById.get(request.params.id);
      if (!provider || !app.services.providers.includes(provider)) {
        return reply
          .code(404)
          .send({ error: { type: "unknown_provider", message: "no such provider" } });
      }
      return describeProvider(provider, app.services);
    },
  );
};
