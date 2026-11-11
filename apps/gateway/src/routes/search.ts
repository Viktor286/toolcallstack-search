import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  apiErrorSchema,
  batchRequestSchema,
  batchResponseSchema,
  searchParamsSchema,
  searchRequestSchema,
  searchResponseSchema,
} from "../schema.ts";
import { executeSearch, searchWithFallbacks, statusFor } from "../search.ts";

export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  const { searchDeps } = app.services;

  app.post(
    "/v1/search",
    {
      schema: {
        summary: "Search with one provider, optionally falling back to others",
        description:
          "Returns the unified response body for upstream failures too, with `ok: false` and a matching HTTP status. Timeouts, network errors, 429 and 5xx responses are retried with exponential backoff; `retries` lists every attempt. With `fallbacks`, the next provider is tried once the previous one has failed for good.",
        body: searchRequestSchema,
        response: {
          200: searchResponseSchema,
          404: searchResponseSchema,
          422: searchResponseSchema,
          429: searchResponseSchema,
          502: searchResponseSchema,
          503: searchResponseSchema,
          504: searchResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { provider, fallbacks = [], ...rest } = request.body;
      const params = searchParamsSchema.parse(rest);
      const result = await searchWithFallbacks(
        searchDeps(request.log),
        [provider, ...fallbacks],
        params,
        { client: request.client },
      );
      return reply.code(statusFor(result)).send(result);
    },
  );

  app.post(
    "/v1/search/batch",
    {
      schema: {
        summary: "Send the same query to several providers at the same instant",
        description:
          "Always answers 200; each entry in `responses` reports its own success or error. Entries keep the order of `providers`.",
        body: batchRequestSchema,
        response: { 200: batchResponseSchema, 400: apiErrorSchema, 401: apiErrorSchema },
      },
    },
    async (request) => {
      const { providers: targets, ...rest } = request.body;
      const params = searchParamsSchema.parse(rest);
      const batchId = randomUUID();
      const deps = searchDeps(request.log);
      const dispatchedAt = new Date().toISOString();
      const responses = await Promise.all(
        targets.map((target) =>
          executeSearch(deps, typeof target === "string" ? { provider: target } : target, params, {
            batchId,
            client: request.client,
          }),
        ),
      );
      return { batchId, query: params.query, dispatchedAt, responses };
    },
  );
};
