import type { SearchResult } from "./schema.ts";

type Published = Pick<SearchResult, "publishedAt" | "publishedRaw" | "publishedPrecision">;

const NONE: Published = { publishedAt: null, publishedRaw: null, publishedPrecision: null };

const UNIT_MS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Normalise the many publish-date formats providers return into ISO 8601 UTC,
 * keeping the raw value and how precise it was. Timestamps without a zone are
 * taken as UTC. Relative dates ("8 minutes ago") are resolved against the
 * moment the response was received.
 */
export function parsePublished(raw: unknown, receivedAt: Date): Published {
  if (typeof raw !== "string" || raw.trim() === "") return NONE;
  const text = raw.trim();
  const miss: Published = { publishedAt: null, publishedRaw: text, publishedPrecision: null };

  // 2026-10-28
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return iso(new Date(`${text}T00:00:00Z`), text, "date") ?? miss;
  }

  // 2026-10-28T18:00:18(.000)(Z|+02:00)?
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
    return iso(new Date(zoned ? text : `${text.replace(" ", "T")}Z`), text, "datetime") ?? miss;
  }

  // Wed, 16 Sep 2026 18:00:14 GMT
  if (/^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}/.test(text)) {
    return iso(new Date(text), text, "datetime") ?? miss;
  }

  // Sep 16, 2026 / September 16, 2026
  const named = /^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}), (\d{4})$/.exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[1]!.toLowerCase());
    if (month === -1) return miss;
    return iso(new Date(Date.UTC(Number(named[3]), month, Number(named[2]))), text, "date") ?? miss;
  }

  // 8 minutes ago / 1 hr ago / an hour ago
  const relative = /^(\d+|an?) ([a-z]+?)s? ago$/i.exec(text);
  if (relative) {
    const count = /^an?$/i.test(relative[1]!) ? 1 : Number(relative[1]);
    const unit = UNIT_MS[relative[2]!.toLowerCase()];
    if (unit === undefined) return miss;
    return iso(new Date(receivedAt.getTime() - count * unit), text, "relative") ?? miss;
  }
  if (/^(just now|now)$/i.test(text)) return iso(receivedAt, text, "relative") ?? miss;
  if (/^yesterday$/i.test(text)) {
    return iso(new Date(receivedAt.getTime() - UNIT_MS.day!), text, "relative") ?? miss;
  }

  return miss;
}

function iso(
  date: Date,
  raw: string,
  precision: NonNullable<Published["publishedPrecision"]>,
): Published | null {
  if (Number.isNaN(date.getTime())) return null;
  return { publishedAt: date.toISOString(), publishedRaw: raw, publishedPrecision: precision };
}

const FRESHNESS_MS = {
  hour: UNIT_MS.hour!,
  day: UNIT_MS.day!,
  week: UNIT_MS.week!,
  month: 31 * UNIT_MS.day!,
  year: UNIT_MS.year!,
};

/** Start of a freshness window, for providers that only accept absolute dates. */
export function freshnessStart(freshness: keyof typeof FRESHNESS_MS, now: Date): Date {
  return new Date(now.getTime() - FRESHNESS_MS[freshness]);
}

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
