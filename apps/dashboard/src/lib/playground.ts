import { canonicalUrl } from "../../../gateway/src/canonical-url.ts";
import type { BatchResponse, ProviderInfo, SearchResponse } from "@/lib/api";

/** Everything the playground form holds; strings stay as typed until a request is built. */
export interface PlaygroundForm {
  query: string;
  providers: string[];
  topic: "general" | "news";
  freshness: string;
  maxResults: number;
  country: string;
  startDate: string;
  endDate: string;
  includeDomains: string;
  excludeDomains: string;
  includeRaw: boolean;
  /** Seconds as typed; empty leaves the gateway's default. */
  cacheTtlSeconds: string;
  /** JSON text per provider id, merged into that provider's upstream request. */
  options: Record<string, string>;
}

export const EMPTY_FORM: PlaygroundForm = {
  query: "",
  providers: [],
  topic: "general",
  freshness: "any",
  maxResults: 5,
  country: "",
  startDate: "",
  endDate: "",
  includeDomains: "",
  excludeDomains: "",
  includeRaw: false,
  cacheTtlSeconds: "",
  options: {},
};

export interface PlaygroundRequest {
  path: "/v1/search" | "/v1/search/batch";
  body: Record<string, unknown>;
}

function domains(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) =>
      entry
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, ""),
    )
    .filter(Boolean);
}

/** A whole number of seconds the gateway accepts, or null for none. */
function cacheSeconds(text: string): number | null {
  const seconds = Number(text);
  return text.trim() !== "" && Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400
    ? seconds
    : null;
}

/** Parse one provider's options text; empty text means no options. */
export function parseOptions(text: string | undefined): {
  value?: Record<string, unknown>;
  error?: string;
} {
  if (!text?.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: 'Options must be a JSON object, like {"search_depth": "advanced"}' };
    }
    return { value: value as Record<string, unknown> };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid JSON" };
  }
}

/**
 * The exact request the playground sends: one provider goes to /v1/search,
 * several go to /v1/search/batch so they are dispatched at the same instant.
 * Fields left at their default are omitted, so the JSON shows only what was chosen.
 */
export function buildRequest(form: PlaygroundForm): PlaygroundRequest {
  const include = domains(form.includeDomains);
  const exclude = domains(form.excludeDomains);
  const shared: Record<string, unknown> = {
    query: form.query.trim(),
    maxResults: form.maxResults,
    ...(form.topic === "general" ? {} : { topic: form.topic }),
    ...(form.freshness === "any" ? {} : { freshness: form.freshness }),
    ...(form.startDate ? { startDate: form.startDate } : {}),
    ...(form.endDate ? { endDate: form.endDate } : {}),
    ...(include.length > 0 ? { includeDomains: include } : {}),
    ...(exclude.length > 0 ? { excludeDomains: exclude } : {}),
    ...(form.country.trim() ? { country: form.country.trim().toUpperCase() } : {}),
    ...(form.includeRaw ? { includeRaw: true } : {}),
    ...(cacheSeconds(form.cacheTtlSeconds) === null
      ? {}
      : { cacheTtlSeconds: cacheSeconds(form.cacheTtlSeconds) }),
  };
  const optionsFor = (id: string) => parseOptions(form.options[id]).value;

  if (form.providers.length === 1) {
    const provider = form.providers[0]!;
    const options = optionsFor(provider);
    return {
      path: "/v1/search",
      body: { provider, ...shared, ...(options ? { options } : {}) },
    };
  }
  return {
    path: "/v1/search/batch",
    body: {
      providers: form.providers.map((provider) => {
        const options = optionsFor(provider);
        return options ? { provider, options } : provider;
      }),
      ...shared,
    },
  };
}

const PARAM_LABELS: Record<string, string> = {
  "topic:news": "news topic",
  freshness: "freshness",
  "freshness:hour": "past-hour freshness",
  startDate: "start date",
  endDate: "end date",
  includeDomains: "include domains",
  excludeDomains: "exclude domains",
  country: "country",
};

/** Chosen parameters this provider cannot honour; the gateway drops them and warns. */
export function unsupportedParams(
  provider: Pick<ProviderInfo, "features">,
  body: Record<string, unknown>,
): string[] {
  const wanted: string[] = [];
  if (body.topic === "news") wanted.push("topic:news");
  if (body.freshness === "hour") {
    wanted.push(provider.features.includes("freshness") ? "freshness:hour" : "freshness");
  } else if (body.freshness) wanted.push("freshness");
  for (const name of ["startDate", "endDate", "includeDomains", "excludeDomains", "country"]) {
    if (body[name] !== undefined) wanted.push(name);
  }
  return wanted
    .filter((feature) => !provider.features.includes(feature))
    .map((feature) => PARAM_LABELS[feature] ?? feature);
}

/** A curl command for the request. The key is a shell variable, never the stored key itself. */
export function curlCommand(request: PlaygroundRequest, origin: string, withAuth: boolean): string {
  const json = JSON.stringify(request.body, null, 2).replaceAll("'", "'\\''");
  return [
    `curl -s ${origin}${request.path}`,
    "  -H 'content-type: application/json'",
    ...(withAuth ? ['  -H "authorization: Bearer $GATEWAY_API_KEY"'] : []),
    `  -d '${json}'`,
  ].join(" \\\n");
}

/**
 * Reduce a URL to what identifies the page, so the same result from two providers matches.
 * The gateway's own rule, which also fills each result's `canonicalUrl`.
 */
export const normalizeUrl = canonicalUrl;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** For every page, the labels of the responses that returned it. */
export function sharedResults(responses: SearchResponse[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const response of responses) {
    for (const key of new Set(response.results.map((result) => normalizeUrl(result.url)))) {
      seen.set(key, [...(seen.get(key) ?? []), response.label]);
    }
  }
  return seen;
}

export interface ResponseSummary {
  results: number;
  dated: number;
  /** Results no other response returned. */
  unique: number;
  newestAt: string | null;
}

export function summarize(
  response: SearchResponse,
  shared: Map<string, string[]>,
): ResponseSummary {
  const dates = response.results
    .map((result) => result.publishedAt)
    .filter((date): date is string => date !== null)
    .toSorted();
  return {
    results: response.results.length,
    dated: dates.length,
    unique: response.results.filter(
      (result) => (shared.get(normalizeUrl(result.url))?.length ?? 1) === 1,
    ).length,
    newestAt: dates.at(-1) ?? null,
  };
}

/** A self-contained record of one playground run: what was asked and exactly what came back. */
export function snapshot(
  request: PlaygroundRequest,
  response: unknown,
  origin: string,
  now = new Date(),
) {
  return {
    tool: "toolcallstack-search playground",
    exportedAt: now.toISOString(),
    gateway: origin,
    request: { method: "POST", path: request.path, body: request.body },
    response,
  };
}

export function snapshotName(query: string, now = new Date()): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `search-${slug || "snapshot"}-${stamp}.json`;
}

export function downloadJson(name: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Whether a field of the collapsible "more options" panel is set, so it should start open. */
export function hasAdvanced(form: PlaygroundForm): boolean {
  return (
    [form.includeDomains, form.excludeDomains, form.startDate, form.endDate, form.country].some(
      (value) => value.trim() !== "",
    ) ||
    form.includeRaw ||
    form.cacheTtlSeconds.trim() !== "" ||
    Object.values(form.options).some((text) => text.trim() !== "")
  );
}

const LIST_PARAMS = ["topic", "freshness", "country", "startDate", "endDate"] as const;

/** Form state as a query string, so a set-up can be bookmarked or shared. Nothing runs on load. */
export function formToParams(form: PlaygroundForm): URLSearchParams {
  const params = new URLSearchParams();
  if (form.query.trim()) params.set("q", form.query.trim());
  if (form.providers.length > 0) params.set("providers", form.providers.join(","));
  if (form.maxResults !== EMPTY_FORM.maxResults) params.set("n", String(form.maxResults));
  for (const name of LIST_PARAMS) {
    if (form[name] && form[name] !== EMPTY_FORM[name]) params.set(name, form[name]);
  }
  if (form.includeDomains.trim()) params.set("include", domains(form.includeDomains).join(","));
  if (form.excludeDomains.trim()) params.set("exclude", domains(form.excludeDomains).join(","));
  if (form.includeRaw) params.set("raw", "1");
  if (cacheSeconds(form.cacheTtlSeconds) !== null) params.set("cache", form.cacheTtlSeconds.trim());
  // Options travel as compact JSON per selected provider, so a copied link keeps them too.
  for (const id of form.providers) {
    const text = form.options[id]?.trim();
    if (!text) continue;
    const { value } = parseOptions(text);
    params.set(`${OPTION_PARAM}${id}`, value ? JSON.stringify(value) : text);
  }
  return params;
}

const OPTION_PARAM = "o.";

export function formFromParams(params: URLSearchParams): PlaygroundForm {
  const count = Number(params.get("n"));
  return {
    ...EMPTY_FORM,
    query: params.get("q") ?? "",
    providers: (params.get("providers") ?? "").split(",").filter(Boolean),
    topic: params.get("topic") === "news" ? "news" : "general",
    freshness: params.get("freshness") ?? "any",
    maxResults: Number.isInteger(count) && count >= 1 && count <= 100 ? count : 5,
    country: params.get("country") ?? "",
    startDate: params.get("startDate") ?? "",
    endDate: params.get("endDate") ?? "",
    includeDomains: params.get("include") ?? "",
    excludeDomains: params.get("exclude") ?? "",
    includeRaw: params.get("raw") === "1",
    cacheTtlSeconds: params.get("cache") ?? "",
    options: Object.fromEntries(
      [...params]
        .filter(([name, text]) => name.startsWith(OPTION_PARAM) && text.trim() !== "")
        .map(([name, text]) => [name.slice(OPTION_PARAM.length), text]),
    ),
  };
}

const RESULT_CHOICES = [3, 5, 10, 20, 50, 100];

/** Result counts worth offering: up to the largest limit among the chosen providers. */
export function resultChoices(limits: number[], current: number): number[] {
  const limit = limits.length > 0 ? Math.max(...limits) : 20;
  return [...new Set([...RESULT_CHOICES.filter((count) => count <= limit), current])].toSorted(
    (a, b) => a - b,
  );
}

/** Chosen providers that return fewer results than asked; the gateway caps them and warns. */
export function cappedProviders<P extends Pick<ProviderInfo, "maxResults">>(
  providers: P[],
  maxResults: number,
): P[] {
  return providers.filter((provider) => provider.maxResults < maxResults);
}

/** A copy of the request that skips the cache, to compare a fresh answer with a reused one. */
export function withoutCache(request: PlaygroundRequest): PlaygroundRequest {
  return { ...request, body: { ...request.body, cacheTtlSeconds: 0 } };
}

export function responsesOf(body: SearchResponse | BatchResponse): SearchResponse[] {
  return "responses" in body ? body.responses : [body];
}

/** One finished run as the history keeps it. */
export interface HistoryEntry {
  id: string;
  savedAt: string;
  form: PlaygroundForm;
  request: PlaygroundRequest;
  body: SearchResponse | BatchResponse;
}

const HISTORY_KEY = "toolcallstack-search.playgroundHistory";
export const HISTORY_SIZE = 10;

function stripRaw({ raw: _raw, ...response }: SearchResponse): SearchResponse {
  return response;
}

/** Raw upstream bodies can be large, so the history keeps the unified response only. */
function withoutRaw(body: SearchResponse | BatchResponse): SearchResponse | BatchResponse {
  return "responses" in body
    ? { ...body, responses: body.responses.map(stripRaw) }
    : stripRaw(body);
}

/** Newest first; a run with the same set-up as an older one replaces it. */
export function addToHistory(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const key = formToParams(entry.form).toString();
  return [
    { ...entry, body: withoutRaw(entry.body) },
    ...entries.filter((old) => formToParams(old.form).toString() !== key),
  ].slice(0, HISTORY_SIZE);
}

/** The saved run for this exact set-up, so a reload shows what the address bar describes. */
export function findInHistory(
  entries: HistoryEntry[],
  form: PlaygroundForm,
): HistoryEntry | undefined {
  const key = formToParams(form).toString();
  return entries.find((entry) => formToParams(entry.form).toString() === key);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Stored history as the page can use it. Entries that are not runs are dropped, and forms saved
 * before a field existed get its default, so an old or edited entry cannot break the page.
 */
export function parseHistory(text: string | null): HistoryEntry[] {
  let saved: unknown;
  try {
    saved = JSON.parse(text ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(
      (entry): entry is HistoryEntry =>
        isObject(entry) &&
        typeof entry.id === "string" &&
        typeof entry.savedAt === "string" &&
        isObject(entry.form) &&
        Array.isArray(entry.form.providers) &&
        typeof entry.form.query === "string" &&
        isObject(entry.request) &&
        isObject(entry.request.body) &&
        isObject(entry.body) &&
        (Array.isArray(entry.body.responses) || Array.isArray(entry.body.results)),
    )
    .map((entry) => ({
      ...entry,
      form: {
        ...EMPTY_FORM,
        ...entry.form,
        options: isObject(entry.form.options) ? entry.form.options : {},
      },
    }))
    .slice(0, HISTORY_SIZE);
}

export function loadHistory(): HistoryEntry[] {
  try {
    return parseHistory(localStorage.getItem(HISTORY_KEY));
  } catch {
    return [];
  }
}

/**
 * Keeps as many of the newest runs as the browser lets it store; history is a convenience.
 * When not even the newest run fits, what was stored before is left as it was.
 */
export function saveHistory(entries: HistoryEntry[]): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(HISTORY_KEY);
      return;
    }
  } catch {
    return;
  }
  for (let count = entries.length; count >= 1; count--) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, count)));
      return;
    } catch {
      // Over quota or storage refused: try again with fewer runs.
    }
  }
}
