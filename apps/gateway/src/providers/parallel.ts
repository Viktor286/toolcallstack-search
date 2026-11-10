import { freshnessStart, parsePublished, toDateOnly } from "../dates.ts";
import { asArray, asNumber, asString, compact, isRecord } from "../util.ts";
import type { Provider } from "./types.ts";

export const parallel: Provider = {
  id: "parallel",
  name: "Parallel Search API",
  docs: "https://docs.parallel.ai/api-reference/search-beta/search",
  envVar: "PARALLEL_API_KEY",
  // after_date is a calendar date, so an hour window cannot be expressed.
  features: ["freshness", "startDate", "includeDomains", "excludeDomains", "country"],
  maxResults: 20,
  notes: [
    "The query is sent both as `objective` and as the single entry of `search_queries`; override either through `options`.",
    "Publish dates are calendar dates without a time.",
    "Useful options: `mode` (`turbo`, `fast`, `basic`, `advanced`), `advanced_settings.fetch_policy.max_age_seconds` for live fetching.",
    "Account balance needs an OAuth account token in `PARALLEL_ACCOUNT_TOKEN`; a normal API key is not accepted.",
  ],
  pricing: { perRequestUsd: 0.005, includedResults: 10, perExtraResultUsd: 0.001 },

  balance: {
    credentialEnvVar: "PARALLEL_ACCOUNT_TOKEN",
    request: ({ credential }) => ({
      url: "https://api.parallel.ai/account/service/v1/balance",
      headers: { Authorization: `Bearer ${credential}` },
    }),
    parse(body) {
      const data = isRecord(body) ? body : {};
      const cents = asNumber(data.credit_balance_cents);
      // Invoiced organisations have no prepaid balance to read.
      if (cents === null || data.will_invoice === true) return null;
      return { unit: "usd", remaining: cents / 100, used: null, quota: null };
    },
  },

  buildRequest(params, apiKey, now) {
    const afterDate =
      params.startDate ??
      (params.freshness ? toDateOnly(freshnessStart(params.freshness, now)) : undefined);
    const sourcePolicy = compact({
      include_domains: params.includeDomains,
      exclude_domains: params.excludeDomains,
      after_date: afterDate,
    });
    return {
      method: "POST",
      url: "https://api.parallel.ai/v1/search",
      headers: { "x-api-key": apiKey },
      body: {
        objective: params.query,
        search_queries: [params.query],
        advanced_settings: compact({
          max_results: params.maxResults,
          source_policy: Object.keys(sourcePolicy).length > 0 ? sourcePolicy : undefined,
          location: params.country?.toLowerCase(),
        }),
      },
    };
  },

  parseResponse(body, { receivedAt }) {
    const data = isRecord(body) ? body : {};
    // Usage arrives as SKU counts, e.g. [{ name: "sku_search", count: 1 }].
    const credits = asArray(data.usage).reduce((sum, sku) => sum + (asNumber(sku.count) ?? 0), 0);
    return {
      results: asArray(data.results).map((item) => ({
        url: asString(item.url),
        title: asString(item.title),
        snippet: Array.isArray(item.excerpts)
          ? item.excerpts.filter((e) => typeof e === "string").join("\n...\n")
          : "",
        ...parsePublished(item.publish_date, receivedAt),
        score: null,
        source: "web",
      })),
      usage: credits > 0 ? { credits } : undefined,
      upstreamRequestId: asString(data.search_id) || undefined,
    };
  },
};
