import { parsePublished } from "../dates.ts";
import { asArray, asNumber, asString, compact, isRecord } from "../util.ts";
import type { Provider } from "./types.ts";

export const tavily: Provider = {
  id: "tavily",
  name: "Tavily",
  docs: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  envVar: "TAVILY_API_KEY",
  features: ["topic:news", "freshness", "startDate", "endDate", "includeDomains", "excludeDomains"],
  maxResults: 20,
  notes: [
    'Publish dates are reliable for `topic: "news"`; general results are often undated.',
    "Useful options: `search_depth` (`basic`, `advanced`, `fast`, `ultra-fast`; advanced costs 2 credits), `include_answer`, `include_raw_content`, `max_age_hours`.",
    "`country` is not mapped because Tavily expects a country name; pass it through `options.country`.",
  ],
  limits: { rpm: 100 },
  pricing: { perCreditUsd: 0.008 },
  balance: {
    request: ({ apiKey }) => ({
      url: "https://api.tavily.com/usage",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    parse(body) {
      const data = isRecord(body) ? body : {};
      const key = isRecord(data.key) ? data.key : {};
      const account = isRecord(data.account) ? data.account : {};
      const used = asNumber(key.usage);
      const quota = asNumber(key.limit) ?? asNumber(account.plan_limit);
      if (used === null) return null;
      return { unit: "credits", used, quota, remaining: quota === null ? null : quota - used };
    },
  },

  buildRequest(params, apiKey) {
    return {
      method: "POST",
      url: "https://api.tavily.com/search",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: compact({
        query: params.query,
        max_results: params.maxResults,
        topic: params.topic,
        // Tavily has no hour window; search.ts widens "hour" to "day" with a warning.
        time_range: params.freshness === "hour" ? "day" : params.freshness,
        start_date: params.startDate,
        end_date: params.endDate,
        include_domains: params.includeDomains,
        exclude_domains: params.excludeDomains,
        include_published_date: true,
        include_usage: true,
      }),
    };
  },

  parseResponse(body, { params, receivedAt }) {
    const data = isRecord(body) ? body : {};
    const usage = isRecord(data.usage) ? asNumber(data.usage.credits) : null;
    return {
      results: asArray(data.results).map((item) => ({
        url: asString(item.url),
        title: asString(item.title),
        snippet: asString(item.content),
        ...parsePublished(item.published_date, receivedAt),
        score: asNumber(item.score),
        source: params.topic === "news" ? "news" : "web",
      })),
      usage: usage === null ? undefined : { credits: usage },
      upstreamRequestId: asString(data.request_id) || undefined,
    };
  },
};
