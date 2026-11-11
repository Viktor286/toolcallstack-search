import { freshnessStart, parsePublished } from "../dates.ts";
import { asArray, asNumber, asString, compact, isRecord } from "../util.ts";
import type { Provider } from "./types.ts";

export const exa: Provider = {
  id: "exa",
  name: "Exa",
  docs: "https://docs.exa.ai/reference/search",
  console: "https://dashboard.exa.ai/home",
  envVar: "EXA_API_KEY",
  features: [
    "topic:news",
    "freshness",
    "freshness:hour",
    "startDate",
    "endDate",
    "includeDomains",
    "excludeDomains",
    "country",
  ],
  maxResults: 100,
  notes: [
    "Reports the dollar cost of every call.",
    '`freshness` and date ranges filter on Exa\'s estimated publish date, and `freshness: "hour"` is exact.',
    "Useful options: `type` (`auto`, `lite`, `deep`), `contents.text`, `contents.maxAgeHours` (0 forces a live crawl), `contents.summary`.",
    "Account usage needs a service key in `EXA_SERVICE_KEY` (dashboard, Service keys tab).",
  ],
  pricing: { perRequestUsd: 0.007, includedResults: 10, perExtraResultUsd: 0.001 },

  balance: {
    credentialEnvVar: "EXA_SERVICE_KEY",
    // Usage since the start of the UTC month, so the figure only grows within a month.
    request: ({ apiKey, credential, now }) => ({
      url: `https://admin-api.exa.ai/team-management/api-keys/${encodeURIComponent(apiKey)}/usage?start_date=${now.toISOString().slice(0, 7)}-01`,
      headers: { "x-api-key": credential },
    }),
    parse(body) {
      const used = isRecord(body) ? asNumber(body.total_cost_usd) : null;
      return used === null ? null : { unit: "usd", used, remaining: null, quota: null };
    },
  },

  buildRequest(params, apiKey, now) {
    const start = params.startDate
      ? `${params.startDate}T00:00:00.000Z`
      : params.freshness
        ? freshnessStart(params.freshness, now).toISOString()
        : undefined;
    return {
      method: "POST",
      url: "https://api.exa.ai/search",
      headers: { "x-api-key": apiKey },
      body: compact({
        query: params.query,
        numResults: params.maxResults,
        category: params.topic === "news" ? "news" : undefined,
        startPublishedDate: start,
        endPublishedDate: params.endDate ? `${params.endDate}T23:59:59.999Z` : undefined,
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
        userLocation: params.country?.toUpperCase(),
        contents: { highlights: true },
      }),
    };
  },

  parseResponse(body, { params, receivedAt }) {
    const data = isRecord(body) ? body : {};
    const cost = isRecord(data.costDollars) ? asNumber(data.costDollars.total) : null;
    return {
      results: asArray(data.results).map((item) => ({
        url: asString(item.url),
        title: asString(item.title),
        snippet: Array.isArray(item.highlights)
          ? item.highlights.filter((h) => typeof h === "string").join("\n...\n")
          : asString(item.text),
        ...parsePublished(item.publishedDate, receivedAt),
        score: asNumber(item.score),
        source: params.topic === "news" ? "news" : "web",
      })),
      usage: cost === null ? undefined : { costUsd: cost },
      upstreamRequestId: asString(data.requestId) || undefined,
    };
  },
};
