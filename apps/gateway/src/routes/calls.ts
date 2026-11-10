import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  apiErrorSchema,
  callsQuerySchema,
  callsResponseSchema,
  searchResponseSchema,
  statsQuerySchema,
  statsResponseSchema,
  usageQuerySchema,
  usageResponseSchema,
} from "../schema.ts";

const noStore = {
  error: {
    type: "store_unavailable",
    message: "the call log needs DATABASE_URL to be set on the gateway",
  },
};

/** Read access to the call log and to usage derived from it. */
export const callRoutes: FastifyPluginAsyncZod = async (app) => {
  const { store } = app.services;

  app.get(
    "/v1/calls",
    {
      schema: {
        summary: "List logged search calls, newest first",
        querystring: callsQuerySchema,
        response: { 200: callsResponseSchema, 400: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!store) return reply.code(503).send(noStore);
      return store.listCalls(request.query);
    },
  );

  app.get(
    "/v1/calls/:id",
    {
      schema: {
        summary: "One logged call, with the raw upstream body when it was stored",
        params: z.object({ id: z.uuid() }),
        response: { 200: searchResponseSchema, 404: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!store) return reply.code(503).send(noStore);
      const call = await store.getCall(request.params.id);
      if (!call) {
        return reply.code(404).send({ error: { type: "not_found", message: "no such call" } });
      }
      return call;
    },
  );

  app.get(
    "/v1/usage",
    {
      schema: {
        summary: "Calls, cost and account balance change per provider and API key",
        description:
          "Per-call cost is what the provider reported or a list-price estimate. `balance.window.spent` is the real change in the provider's account between the first and last balance snapshot in the window, which also includes any use of the same key outside the gateway.",
        querystring: usageQuerySchema,
        response: { 200: usageResponseSchema, 400: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!store) return reply.code(503).send(noStore);
      const to = request.query.to ? new Date(request.query.to) : new Date();
      const from = request.query.from
        ? new Date(request.query.from)
        : new Date(to.getTime() - 86_400_000);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        providers: await store.usage(from, to),
        ...(request.query.groupBy === "client"
          ? { clients: await store.usageByClient(from, to) }
          : {}),
      };
    },
  );

  app.get(
    "/v1/stats",
    {
      schema: {
        summary: "Calls, failures, latency and cost per provider over time",
        querystring: statsQuerySchema,
        response: { 200: statsResponseSchema, 400: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!store) return reply.code(503).send(noStore);
      const to = request.query.to ? new Date(request.query.to) : new Date();
      const from = request.query.from
        ? new Date(request.query.from)
        : new Date(to.getTime() - 86_400_000);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        bucket: request.query.bucket,
        points: await store.stats(from, to, request.query.bucket),
      };
    },
  );
};
