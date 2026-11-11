import { errorTypes, type ErrorType } from "../../../gateway/src/error-types.ts";

export { errorTypes };

/** A recent window relative to now, or an exact window given by `from` and `to`. */
export const RANGES = [
  { id: "all", label: "Any time", hours: null },
  { id: "1h", label: "Last hour", hours: 1 },
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 24 * 7 },
  { id: "30d", label: "Last 30 days", hours: 24 * 30 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

/**
 * The Calls page filters. They live in the address bar, so a filtered view is
 * a link: the Overview's hourly bars open the calls of one hour this way.
 */
export interface CallFilters {
  provider: string;
  /** "true", "false" or "" for any outcome. */
  ok: string;
  errorType: ErrorType | "";
  client: string;
  label: string;
  /** Text the query contains. */
  q: string;
  range: RangeId;
  /** An exact window, ISO 8601; it wins over `range`. */
  from: string;
  to: string;
}

const TEXT = ["provider", "client", "label", "q", "from", "to"] as const;

export function filtersFromParams(params: URLSearchParams): CallFilters {
  const text = Object.fromEntries(TEXT.map((name) => [name, params.get(name) ?? ""])) as Record<
    (typeof TEXT)[number],
    string
  >;
  const ok = params.get("ok") ?? "";
  const errorType = params.get("errorType") ?? "";
  const range = params.get("range") ?? "";
  return {
    ...text,
    ok: ["true", "false"].includes(ok) ? ok : "",
    errorType: (errorTypes as readonly string[]).includes(errorType)
      ? (errorType as ErrorType)
      : "",
    range: RANGES.some((item) => item.id === range) ? (range as RangeId) : "all",
  };
}

/** Only what is set, so the address stays short. */
export function filtersToParams(filters: CallFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value && !(name === "range" && value === "all")) params.set(name, value.trim());
  }
  return params;
}

/** The /v1/calls query for the filters; a recent window is anchored at `now`. */
export function callsQuery(
  filters: CallFilters,
  now = Date.now(),
): Record<string, string | undefined> {
  const hours = RANGES.find((item) => item.id === filters.range)?.hours ?? null;
  const exact = filters.from || filters.to;
  return {
    provider: filters.provider || undefined,
    // An error type implies a failed call.
    ok: filters.errorType ? "false" : filters.ok || undefined,
    errorType: filters.errorType || undefined,
    client: filters.client.trim() || undefined,
    label: filters.label.trim() || undefined,
    q: filters.q.trim() || undefined,
    from: exact
      ? filters.from || undefined
      : hours === null
        ? undefined
        : new Date(now - hours * 3_600_000).toISOString(),
    to: exact ? filters.to || undefined : undefined,
  };
}

/** The link to one provider's calls in one hour, as the Overview's bars open them. */
export function hourLink(provider: string, start: string): string {
  const from = new Date(start);
  const to = new Date(from.getTime() + 3_600_000);
  return `/calls?${new URLSearchParams({ provider, from: from.toISOString(), to: to.toISOString() })}`;
}
