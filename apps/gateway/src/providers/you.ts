import { parsePublished, toDateOnly } from "../dates.ts";
import { asArray, asNumber, asString, compact, isRecord } from "../util.ts";
import type { Provider } from "./types.ts";

/**
 * Licensed "knowledge" data is opt-in per call: pass `options: { knowledge: "core" }`.
 * Those items have no URL, so they only appear in the raw response.
 */
export const you: Provider = {
  id: "you",
  name: "You.com",
  docs: "https://you.com/docs/api-reference/search/v1-search",
  console: "https://you.com/platform",
  envVar: "YOU_API_KEY",
  features: ["freshness", "startDate", "endDate", "includeDomains", "excludeDomains", "country"],
  maxResults: 100,
  notes: [
    "News articles are returned in the web results; there is no separate news topic.",
    '`options: { "knowledge": "core" }` adds licensed data. Those items have no URL, so they appear only in the raw response (`includeRaw`).',
    "Useful options: `extraction` for page contents, `boost_domains`, `language`.",
  ],
  pricing: { perRequestUsd: 0.005 },
  balance: {
    request: ({ apiKey }) => ({
      url: "https://api.you.com/v1/billing/account_balance",
      headers: { "X-API-Key": apiKey },
    }),
    parse(body) {
      const data = isRecord(body) && isRecord(body.data) ? body.data : {};
      const cents = isRecord(data.attributes) ? asNumber(data.attributes.balance) : null;
      if (cents === null) return null;
      return { unit: "usd", remaining: cents / 100, used: null, quota: null };
    },
  },

  buildRequest(params, apiKey, now) {
    let freshness: string | undefined;
    if (params.startDate || params.endDate) {
      freshness = `${params.startDate ?? "1990-01-01"}to${params.endDate ?? toDateOnly(now)}`;
    } else if (params.freshness) {
      freshness = params.freshness === "hour" ? "day" : params.freshness;
    }
    return {
      method: "POST",
      url: "https://ydc-index.io/v1/search",
      headers: { "X-API-Key": apiKey },
      body: compact({
        query: params.query,
        count: params.maxResults,
        freshness,
        country: params.country?.toUpperCase(),
        include_domains: params.includeDomains,
        exclude_domains: params.excludeDomains,
      }),
    };
  },

  parseResponse(body, { receivedAt }) {
    const data = isRecord(body) ? body : {};
    const results = isRecord(data.results) ? data.results : {};
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    return {
      results: asArray(results.web).map((item) => ({
        url: asString(item.url),
        title: asString(item.title),
        snippet:
          (Array.isArray(item.snippets)
            ? item.snippets.filter((s) => typeof s === "string").join("\n...\n")
            : "") || asString(item.description),
        ...parsePublished(item.page_age, receivedAt),
        score: null,
        source: "web",
      })),
      upstreamRequestId: asString(metadata.search_uuid) || undefined,
    };
  },
};
