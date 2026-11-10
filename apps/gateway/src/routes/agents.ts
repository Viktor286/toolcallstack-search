import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  llmsFullTxt,
  llmsTxt,
  providerMarkdown,
  schemas,
  toolDefinitions,
  type SchemaName,
} from "../agent-docs.ts";
import { providers, providersById } from "../providers/index.ts";
import { describeProvider } from "./providers.ts";

const MARKDOWN = "text/markdown; charset=utf-8";

/** Origin the client used, so links in the docs point back at this gateway. */
const base = (request: FastifyRequest) => `${request.protocol}://${request.host}`;

/**
 * Public documentation for AI agents and other programs. Nothing here needs a
 * key, so an agent can learn the API before it is given one.
 */
export const agentRoutes: FastifyPluginAsyncZod = async (app) => {
  const all = () => providers.map((provider) => describeProvider(provider, app.services));
  const hidden = { schema: { hide: true } };

  app.get("/llms.txt", hidden, async (request, reply) =>
    reply.type(MARKDOWN).send(llmsTxt(base(request), all())),
  );

  app.get("/llms-full.txt", hidden, async (request, reply) =>
    reply.type(MARKDOWN).send(llmsFullTxt(base(request), all())),
  );

  app.get("/openapi.json", hidden, async () => app.swagger());

  app.get("/tools.json", hidden, async (request) => toolDefinitions(base(request), all()));

  app.get("/schemas", hidden, async (request) => ({
    schemas: Object.keys(schemas).map((name) => ({
      name,
      url: `${base(request)}/schemas/${name}.json`,
    })),
  }));

  app.get(
    "/schemas/:file",
    { schema: { hide: true, params: z.object({ file: z.string() }) } },
    async (request, reply) => {
      const name = request.params.file.replace(/\.json$/, "");
      if (!Object.hasOwn(schemas, name)) {
        return reply.code(404).send({ error: { type: "not_found", message: "no such schema" } });
      }
      return schemas[name as SchemaName];
    },
  );

  app.get(
    "/docs/providers/:file",
    { schema: { hide: true, params: z.object({ file: z.string() }) } },
    async (request, reply) => {
      const provider = providersById.get(request.params.file.replace(/\.md$/, ""));
      if (!provider) {
        return reply.code(404).send({ error: { type: "not_found", message: "no such provider" } });
      }
      return reply.type(MARKDOWN).send(providerMarkdown(describeProvider(provider, app.services)));
    },
  );
};
