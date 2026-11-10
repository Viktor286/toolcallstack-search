import { z } from "zod";
import type { Feature } from "./providers/types.ts";
import {
  batchRequestSchema,
  batchResponseSchema,
  callsResponseSchema,
  providerInfoSchema,
  searchRequestSchema,
  searchResponseSchema,
  statusResponseSchema,
  usageResponseSchema,
} from "./schema.ts";

/**
 * Documentation written for AI agents and other programs: plain Markdown and
 * JSON Schema generated from the same provider registry and schemas the
 * gateway runs on, so it cannot drift from the behaviour.
 */

type ProviderDoc = z.infer<typeof providerInfoSchema>;

const FEATURES: [Feature, string][] = [
  ["topic:news", 'topic: "news"'],
  ["freshness", "freshness"],
  ["freshness:hour", 'freshness: "hour"'],
  ["startDate", "startDate"],
  ["endDate", "endDate"],
  ["includeDomains", "includeDomains"],
  ["excludeDomains", "excludeDomains"],
  ["country", "country"],
];

export const schemas = {
  "search-request": z.toJSONSchema(searchRequestSchema, { io: "input" }),
  "batch-request": z.toJSONSchema(batchRequestSchema, { io: "input" }),
  "search-response": z.toJSONSchema(searchResponseSchema),
  "batch-response": z.toJSONSchema(batchResponseSchema),
  provider: z.toJSONSchema(providerInfoSchema),
  calls: z.toJSONSchema(callsResponseSchema),
  usage: z.toJSONSchema(usageResponseSchema),
  status: z.toJSONSchema(statusResponseSchema),
};
export type SchemaName = keyof typeof schemas;

/** The arguments worth exposing to a model; operational knobs stay out of its way. */
export const toolInput = searchRequestSchema.pick({
  query: true,
  provider: true,
  fallbacks: true,
  maxResults: true,
  topic: true,
  freshness: true,
  startDate: true,
  endDate: true,
  includeDomains: true,
  excludeDomains: true,
  country: true,
});

/** A ready-made `web_search` tool definition in the shapes model APIs expect. */
export function toolDefinitions(base: string, providers: ProviderDoc[]) {
  const description = toolDescription(providers);
  const inputSchema = z.toJSONSchema(toolInput, { io: "input" });
  return {
    call: {
      method: "POST",
      url: `${base}/v1/search`,
      headers: { "content-type": "application/json", authorization: "Bearer <gateway API key>" },
      body: "the tool arguments, as JSON",
    },
    mcpServer: { url: `${base}/mcp`, transport: "streamable-http" },
    mcp: [{ name: "web_search", description, inputSchema }],
    anthropic: [{ name: "web_search", description, input_schema: inputSchema }],
    openai: [
      { type: "function", function: { name: "web_search", description, parameters: inputSchema } },
    ],
  };
}

export function toolDescription(providers: ProviderDoc[]): string {
  const configured = providers.filter((provider) => provider.configured).map((p) => p.id);
  return (
    "Search the web through the toolcallstack-search gateway and get ranked results with url, title, " +
    "snippet and publish date. Choose a provider with `provider`" +
    (configured.length > 0 ? ` (available: ${configured.join(", ")})` : "") +
    '; list `fallbacks` to try others if it fails. Use `topic: "news"` and `freshness` for ' +
    "recent events. Check `warnings` in the result: a filter the provider cannot apply is " +
    "dropped, not enforced."
  );
}

function matrix(providers: ProviderDoc[]): string {
  const head = `| Provider | Configured | Max results | ${FEATURES.map(([, label]) => label).join(" | ")} |`;
  const rule = `| --- | --- | --- | ${FEATURES.map(() => "---").join(" | ")} |`;
  const rows = providers.map(
    (p) =>
      `| \`${p.id}\` | ${p.configured ? "yes" : "no"} | ${p.maxResults} | ${FEATURES.map(([feature]) => (p.features.includes(feature) ? "yes" : "no")).join(" | ")} |`,
  );
  return [head, rule, ...rows].join("\n");
}

function money(usd: number): string {
  return `$${usd}`;
}

export function providerMarkdown(provider: ProviderDoc): string {
  const unsupported = FEATURES.filter(([feature]) => !provider.features.includes(feature)).map(
    ([, label]) => label,
  );
  const price = provider.pricing;
  const priceText = !price
    ? "No price is set, so cost is reported as unknown."
    : price.perCreditUsd !== undefined
      ? `${money(price.perCreditUsd)} per provider credit (list price).`
      : `${money(price.perRequestUsd ?? 0)} per request` +
        (price.includedResults !== undefined && price.perExtraResultUsd !== undefined
          ? `, plus ${money(price.perExtraResultUsd)} per result beyond ${price.includedResults}`
          : "") +
        " (list price).";
  const limits = [
    provider.limits.rpm !== undefined ? `${provider.limits.rpm} requests per minute` : null,
    provider.limits.concurrency !== undefined ? `${provider.limits.concurrency} concurrent` : null,
  ].filter(Boolean);
  return `# ${provider.name} (\`${provider.id}\`)

- Status: ${provider.configured ? "configured and usable" : `not configured (set \`${provider.envVar}\` on the gateway)`}
- Upstream documentation: ${provider.docs}
- Most results per call: ${provider.maxResults}
- Supported unified parameters: ${
    FEATURES.filter(([feature]) => provider.features.includes(feature))
      .map(([, label]) => `\`${label}\``)
      .join(", ") || "none beyond `query` and `maxResults`"
  }
- Not supported (dropped with a warning): ${unsupported.map((label) => `\`${label}\``).join(", ") || "nothing"}
- Gateway rate limit: ${limits.join(", ") || "none"}
- Cost: ${priceText}
- Budget: ${
    provider.budget
      ? (provider.budget.blocked ??
        "a spend cap is set and has room, see `/v1/providers/" + provider.id + "`")
      : "no spend cap"
  }
- Account balance: ${provider.reportsBalance ? "tracked, see `/v1/usage`" : provider.balanceEnvVar ? `available once \`${provider.balanceEnvVar}\` is set` : "the provider has no endpoint for it"}

## Notes

${provider.notes.map((note) => `- ${note}`).join("\n")}

## Example

\`\`\`json
POST /v1/search
{ "provider": "${provider.id}", "query": "Federal Reserve rate decision", "maxResults": 5 }
\`\`\`

Provider-specific fields go in \`options\` and are merged into the upstream request unchanged.
`;
}

export function llmsTxt(base: string, providers: ProviderDoc[]): string {
  return `# toolcallstack-search

> A unified web search API gateway. One request and response shape in front of ${providers.length} search providers (${providers.map((p) => p.id).join(", ")}), with per-call timing, retry, rate-limit and cost data.

Call \`POST ${base}/v1/search\` with JSON \`{"provider": "<id>", "query": "..."}\`. Send \`Authorization: Bearer <key>\` if the gateway requires a key. Read \`results\` when \`ok\` is true; otherwise read \`error\`.

## Docs

- [Full guide](${base}/llms-full.txt): every endpoint, parameter, response field and error, in one Markdown page
- [OpenAPI document](${base}/openapi.json): machine-readable description of all endpoints
- [Tool definitions](${base}/tools.json): a ready-made \`web_search\` tool for Anthropic, OpenAI and MCP-style function calling
- MCP server: \`${base}/mcp\` (Streamable HTTP) with the tools \`web_search\`, \`web_search_batch\` and \`list_providers\`

## Schemas

${(Object.keys(schemas) as SchemaName[]).map((name) => `- [${name}](${base}/schemas/${name}.json)`).join("\n")}

## Providers

${providers.map((p) => `- [${p.name}](${base}/docs/providers/${p.id}.md): \`${p.id}\`, ${p.configured ? "configured" : "not configured"}`).join("\n")}

## Live state

- [Providers](${base}/v1/providers): which are configured, their limits and prices (JSON)
- [Status](${base}/v1/status): health of the gateway and of each provider (JSON)
`;
}

export function llmsFullTxt(base: string, providers: ProviderDoc[]): string {
  return `# toolcallstack-search: full guide

toolcallstack-search is a unified web search API gateway at ${base}. It puts one request and response shape in front of several search providers and reports, for every call, where the time went, what was retried and what it cost.

## Authentication

If the gateway has API keys configured, every \`/v1/*\` request needs \`Authorization: Bearer <key>\`. The documentation, schema, \`/health\` and \`/metrics\` endpoints are public. A missing or wrong key returns 401.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| \`POST /v1/search\` | Search with one provider, optionally falling back to others |
| \`POST /v1/search/batch\` | Send one query to several providers at the same instant |
| \`GET /v1/providers\`, \`GET /v1/providers/{id}\` | Providers: configured or not, supported parameters, limits, prices, notes |
| \`GET /v1/status\` | Health of the gateway and of each provider |
| \`GET /v1/calls\`, \`GET /v1/calls/{id}\` | Logged calls, newest first |
| \`GET /v1/usage\` | Calls, cost and account balance change per provider |
| \`POST /mcp\` | MCP server (Streamable HTTP): tools \`web_search\`, \`web_search_batch\`, \`list_providers\` |
| \`GET /health\` | Liveness: 200 while the process is serving |

## Search request

\`POST /v1/search\`, JSON body.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| \`provider\` | string | required | Provider id, see the table below |
| \`query\` | string | required | 1 to 2000 characters |
| \`maxResults\` | integer | 10 | 1 to 100; capped at the provider's maximum, with a warning |
| \`topic\` | \`general\` or \`news\` | \`general\` | \`news\` uses the provider's news index where it has one |
| \`freshness\` | \`hour\`, \`day\`, \`week\`, \`month\`, \`year\` | none | Only results published within that window |
| \`startDate\`, \`endDate\` | \`YYYY-MM-DD\` | none | Publish date range, UTC |
| \`includeDomains\`, \`excludeDomains\` | string[] | none | Domain allow and block lists |
| \`country\` | ISO 3166-1 alpha-2 | none | Result localisation |
| \`options\` | object | none | Provider-specific fields, merged into the upstream request unchanged |
| \`fallbacks\` | string[] | none | Providers to try in order if the previous one fails |
| \`timeoutMs\` | integer | 30000 | Timeout for each attempt |
| \`maxRetries\` | integer | 5 | Retries after a transient failure; 0 makes exactly one upstream request |
| \`maxQueueMs\` | integer | 30000 | Longest wait under the provider's rate limit; 0 fails at once |
| \`includeRaw\` | boolean | false | Also return the untouched upstream body as \`raw\` |

A parameter the chosen provider cannot honour is dropped, and \`warnings\` says so. It is never an error and never silent. Check \`warnings\` before relying on a filter.

\`POST /v1/search/batch\` takes the same body with \`providers\` (an array) instead of \`provider\` and without \`fallbacks\`. An entry is a provider id or \`{"provider": "you", "label": "you+knowledge", "options": {"knowledge": "core"}}\` to run a labelled variant. It always answers 200 with \`{batchId, query, dispatchedAt, responses}\`; each entry of \`responses\` is a search response with its own \`ok\` and \`error\`.

## Search response

| Field | Meaning |
| --- | --- |
| \`id\` | Gateway call id; look the call up later at \`/v1/calls/{id}\` |
| \`provider\`, \`label\` | The provider that answered (after fallbacks) and the variant label |
| \`ok\` | True when results were obtained |
| \`results[]\` | \`position\` (1-based), \`url\`, \`title\`, \`snippet\`, \`score\` (provider relevance or null), \`source\` (\`web\` or \`news\`) |
| \`results[].publishedAt\` | Publish time in ISO 8601 UTC, or null when the provider gave none |
| \`results[].publishedRaw\` | The provider's own value, unchanged |
| \`results[].publishedPrecision\` | \`datetime\`, \`date\` (time unknown, midnight UTC used) or \`relative\` (derived from text such as "2 hours ago") |
| \`timing.sentAt\`, \`timing.receivedAt\` | Wall-clock send and receive time of the final attempt |
| \`timing.latencyMs\` | Duration of the final attempt alone |
| \`timing.totalMs\` | Duration of the whole call, including queueing, earlier attempts and backoff |
| \`timing.queuedMs\` | Time spent waiting under the provider's rate limit |
| \`timing.phases\` | \`dnsMs\`, \`connectMs\`, \`tlsMs\` (null on a reused connection), \`ttfbMs\`, \`downloadMs\`, \`connectionReused\`; they add up to \`latencyMs\` |
| \`retries\` | \`count\`, \`backoffMs\`, and \`attempts[]\` with timing, status and error of every upstream request |
| \`usage.credits\`, \`usage.costUsd\` | What the provider reported for this call |
| \`usage.estimatedCostUsd\` | List-price estimate from the gateway's price table |
| \`usage.costSource\` | \`reported\` (use \`costUsd\`), \`estimated\` (use \`estimatedCostUsd\`) or \`unknown\` |
| \`upstream\` | The provider's HTTP \`status\` and \`requestId\` |
| \`warnings[]\` | Parameters that were dropped, widened or capped |
| \`error\` | Null, or \`{type, message, upstreamStatus}\` |
| \`fallback.tried[]\` | Providers that failed before this one answered |

## Errors

\`/v1/search\` returns the full response body on failure too, with \`ok: false\`.

| HTTP | \`error.type\` | Meaning | What to do |
| --- | --- | --- | --- |
| 400 | \`invalid_request\` | The body failed validation | Fix the request; \`message\` names the field |
| 401 | \`unauthorized\` | Missing or wrong gateway key | Send the bearer token |
| 404 | \`unknown_provider\` | No such provider id | Use an id from \`/v1/providers\` |
| 503 | \`not_configured\` | The provider's API key is not set on the gateway | Use another provider |
| 429 | \`rate_limited\` | The provider answered 429, after retries | Wait, or use another provider |
| 429 | \`budget_exceeded\` | The provider's spend cap on the gateway is used up; nothing was sent | Use another provider; \`message\` says when the cap resets |
| 429 | \`throttled\` | No slot under the gateway's limit within \`maxQueueMs\`; nothing was sent | Raise \`maxQueueMs\`, or use another provider |
| 504 | \`timeout\` | No response within \`timeoutMs\`, after retries | Retry later or raise \`timeoutMs\` |
| 502 | \`upstream_error\` | The provider answered an error status | Read \`message\`; a 4xx usually means bad \`options\` or a bad key |
| 502 | \`network\`, \`bad_response\` | Connection failure, or a body that could not be parsed | Retry later |
| 503 | \`overloaded\` | The gateway is shedding load | Retry after a second |

Timeouts, network errors, 429 and 5xx from a provider are retried automatically with exponential backoff, so a client does not need its own retry loop for those.

## Providers

${matrix(providers)}

Where \`freshness: "hour"\` is "no" but \`freshness\` is "yes", an hour is widened to a day, with a warning. Details per provider:

${providers.map((p) => `- \`${p.id}\`: ${base}/docs/providers/${p.id}.md`).join("\n")}

${providers.map((p) => `### ${p.name} (\`${p.id}\`)\n\n${p.notes.map((note) => `- ${note}`).join("\n")}`).join("\n\n")}

## Examples

Recent news with a fallback:

\`\`\`json
POST /v1/search
{ "provider": "tavily", "fallbacks": ["brave"], "query": "Nvidia earnings", "topic": "news", "freshness": "day", "maxResults": 5 }
\`\`\`

Compare providers on one query:

\`\`\`json
POST /v1/search/batch
{ "providers": ["brave", "exa", "tavily"], "query": "Nvidia earnings", "maxResults": 5 }
\`\`\`

## Machine-readable

- OpenAPI: ${base}/openapi.json
- JSON Schemas: ${(Object.keys(schemas) as SchemaName[]).map((name) => `${base}/schemas/${name}.json`).join(", ")}
- Tool definitions: ${base}/tools.json
- MCP server (Streamable HTTP): ${base}/mcp
`;
}
