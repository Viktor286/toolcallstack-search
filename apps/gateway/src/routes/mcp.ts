import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { toolDescription, toolInput } from "../agent-docs.ts";
import { searchParamsSchema, type SearchResponse } from "../schema.ts";
import { executeSearch, searchWithFallbacks } from "../search.ts";
import type { Services } from "../services.ts";
import { VERSION } from "../version.ts";
import { describeProvider } from "./providers.ts";

const SNIPPET_CHARS = 600;

/** Results as text a model can read directly; the full response rides along as structured content. */
export function formatResults(response: SearchResponse): string {
  if (!response.ok) {
    return `Search with ${response.label} failed (${response.error?.type}): ${response.error?.message}`;
  }
  const lines = [
    `${response.results.length} results from ${response.label} for "${response.query}"`,
  ];
  for (const result of response.results) {
    const snippet = result.snippet.replace(/\s+/g, " ").trim();
    lines.push(
      "",
      `${result.position}. ${result.title || "(untitled)"}`,
      `   ${result.url}`,
      `   published: ${result.publishedAt ?? "unknown"}${result.publishedPrecision === "relative" ? " (approximate)" : ""}`,
    );
    if (snippet) {
      lines.push(
        `   ${snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS)}…` : snippet}`,
      );
    }
  }
  if (response.fallback.tried.length > 0) {
    lines.push(
      "",
      `Fell back after: ${response.fallback.tried.map((t) => `${t.provider} (${t.error.type})`).join(", ")}`,
    );
  }
  if (response.warnings.length > 0) lines.push("", `Warnings: ${response.warnings.join("; ")}`);
  return lines.join("\n");
}

const result = (text: string, structured: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: structured,
  isError,
});

const batchInput = toolInput.omit({ provider: true, fallbacks: true }).extend({
  providers: z.array(z.string().min(1)).min(1).max(16).describe("Provider ids to query at once"),
});

/** A fresh MCP server per request: the endpoint is stateless, so any gateway instance can serve it. */
function createMcpServer(
  services: Services,
  log: FastifyBaseLogger,
  client: string | null,
): McpServer {
  const server = new McpServer({ name: "toolcallstack-search", version: VERSION });
  const describe = () => services.providers.map((provider) => describeProvider(provider, services));
  server.registerTool(
    "web_search",
    { title: "Web search", description: toolDescription(describe()), inputSchema: toolInput.shape },
    async ({ provider, fallbacks = [], ...rest }) => {
      const response = await searchWithFallbacks(
        services.searchDeps(log),
        [provider, ...fallbacks],
        searchParamsSchema.parse(rest),
        { client },
      );
      return result(formatResults(response), response, !response.ok);
    },
  );

  server.registerTool(
    "web_search_batch",
    {
      title: "Web search across providers",
      description:
        "Send one query to several providers at the same instant and get each provider's results separately. Use it to compare providers or to widen coverage; it costs one search per provider.",
      inputSchema: batchInput.shape,
    },
    async ({ providers: targets, ...rest }) => {
      const params = searchParamsSchema.parse(rest);
      const batchId = randomUUID();
      const deps = services.searchDeps(log);
      const responses = await Promise.all(
        targets.map((provider) => executeSearch(deps, { provider }, params, { batchId, client })),
      );
      return result(
        responses.map(formatResults).join("\n\n---\n\n"),
        { batchId, responses },
        responses.every((response) => !response.ok),
      );
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List search providers",
      description:
        "List the search providers behind the gateway: which are configured, which filters each supports, their limits, prices and notes on provider-specific behaviour.",
      inputSchema: {},
    },
    async () => {
      const list = describe();
      const text = list
        .map(
          (p) =>
            `${p.id} (${p.name}): ${p.configured ? "configured" : "not configured"}; supports ${p.features.join(", ") || "query only"}; up to ${p.maxResults} results`,
        )
        .join("\n");
      return result(text, { providers: list });
    },
  );

  return server;
}

/**
 * Model Context Protocol endpoint (Streamable HTTP), so an agent can use the
 * gateway as a tool server without wiring up HTTP calls itself.
 */
export const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/mcp",
    {
      schema: {
        summary: "MCP server (Streamable HTTP)",
        description:
          "JSON-RPC endpoint of the Model Context Protocol. Tools: `web_search`, `web_search_batch`, `list_providers`. Stateless: no session is kept between requests.",
      },
    },
    async (request, reply) => {
      const server = createMcpServer(app.services, request.log, request.client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      // The transport writes the HTTP response itself.
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  );

  // Without sessions there is no server-to-client stream to open and nothing to delete.
  const notAllowed = {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  };
  app.get("/mcp", { schema: { hide: true } }, async (_request, reply) =>
    reply.code(405).header("allow", "POST").send(notAllowed),
  );
  app.delete("/mcp", { schema: { hide: true } }, async (_request, reply) =>
    reply.code(405).header("allow", "POST").send(notAllowed),
  );
};
