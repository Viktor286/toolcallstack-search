import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { canonicalUrl } from "./canonical-url.ts";
import { NOT_THE_PROVIDER } from "./error-types.ts";
import type { Balance } from "./providers/types.ts";
import type { Spend } from "./budget.ts";
import type {
  CallsQuery,
  SearchParams,
  SearchResponse,
  StatsResponse,
  UsageResponse,
} from "./schema.ts";

export interface CallRecord {
  response: SearchResponse;
  params: SearchParams;
  batchId: string | null;
  /** Shared by the calls one client request made through fallbacks. */
  groupId: string | null;
  keyFingerprint: string | null;
  /** Name of the gateway API key that made the call. */
  client: string | null;
  raw: unknown;
}

export interface ProviderSpend {
  provider: string;
  day: Spend;
  month: Spend;
}

export interface ProviderOutcome {
  provider: string;
  ok: boolean;
  latencyMs: number;
  receivedAt: string;
  error: { type: string; message: string } | null;
}

export interface BalanceSnapshot extends Balance {
  provider: string;
  keyFingerprint: string;
  takenAt: Date;
}

/** Durable log of every call the gateway makes, plus provider balance snapshots. */
export interface Store {
  saveCall(record: CallRecord): Promise<void>;
  listCalls(query: CallsQuery): Promise<{ calls: SearchResponse[]; nextCursor: string | null }>;
  getCall(id: string): Promise<SearchResponse | null>;
  saveBalance(snapshot: BalanceSnapshot): Promise<void>;
  usage(from: Date, to: Date): Promise<UsageResponse["providers"]>;
  usageByClient(from: Date, to: Date): Promise<NonNullable<UsageResponse["clients"]>>;
  stats(from: Date, to: Date, bucket: "hour" | "day"): Promise<StatsResponse["points"]>;
  /** Billed calls, dollars and credits per provider since the start of the UTC day and month. */
  spendSince(dayStart: Date, monthStart: Date): Promise<ProviderSpend[]>;
  /** The latest calls per provider that say something about it, oldest first. */
  recentOutcomes(perProvider: number): Promise<ProviderOutcome[]>;
  /** Apply retention: delete old calls and snapshots, drop old raw bodies. 0 days keeps them. */
  cleanup(retention: {
    callDays: number;
    rawDays: number;
  }): Promise<{ calls: number; raws: number }>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/**
 * Apply pending migrations, then make sure this month and the next have a call log partition.
 * `until` stops after the named migration, so tests can start from an older schema.
 */
export async function migrate(
  sql: postgres.Sql,
  options: { until?: string } = {},
): Promise<string[]> {
  await sql`CREATE SCHEMA IF NOT EXISTS gateway`;
  await sql`
    CREATE TABLE IF NOT EXISTS gateway.migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql") && (!options.until || file <= options.until))
    .toSorted();
  const applied: string[] = [];
  for (const file of files) {
    await sql.begin(async (tx) => {
      // Serialise concurrent starters so a migration never runs twice.
      await tx`LOCK TABLE gateway.migrations IN EXCLUSIVE MODE`;
      const [done] = await tx`SELECT 1 FROM gateway.migrations WHERE name = ${file}`;
      if (done) return;
      await tx.unsafe(await readFile(new URL(file, MIGRATIONS_DIR), "utf8"));
      await tx`INSERT INTO gateway.migrations (name) VALUES (${file})`;
      applied.push(file);
    });
  }
  const [partitioned] = await sql`
    SELECT to_regprocedure('gateway.create_call_partition(timestamptz)') IS NOT NULL AS ready`;
  if (partitioned?.ready) await createPartitions(sql, [new Date(), nextMonth(new Date())]);
  return applied;
}

const nextMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

async function createPartitions(sql: postgres.Sql, months: Date[]): Promise<void> {
  for (const month of months) await sql`SELECT gateway.create_call_partition(${month})`;
}

/** Postgres refuses a row whose month has no partition with this code. */
const NO_PARTITION = "23514";

const HOUR_MS = 3_600_000;

/** Bucket i holds latencies in (RATIO^(i-1), RATIO^i] ms; see gateway.latency_bucket. */
const LATENCY_RATIO = 1.05;

/**
 * A percentile from per-bucket counts, by the same rule as `percentile_cont`: the value at rank
 * q·(n−1), interpolated between the two neighbouring ranks. Each rank's value is read as the
 * geometric middle of its bucket, so the result is within 2.5% of the exact percentile.
 */
export function histogramPercentile(
  buckets: [bucket: number, count: number][],
  q: number,
): number | null {
  const sorted = buckets.filter(([, count]) => count > 0).toSorted(([a], [b]) => a - b);
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;
  const valueAt = (rank: number) => {
    let seen = 0;
    for (const [bucket, count] of sorted) {
      seen += count;
      if (seen > rank) return bucket === 0 ? 1 : LATENCY_RATIO ** (bucket - 0.5);
    }
    return LATENCY_RATIO ** (sorted.at(-1)![0] - 0.5);
  };
  const rank = q * (total - 1);
  const below = valueAt(Math.floor(rank));
  return below + (rank - Math.floor(rank)) * (valueAt(Math.ceil(rank)) - below);
}

/**
 * The whole hours of [from, to), which the hourly rollups answer; a part-hour at either end is
 * read from the call log. The rollup for the current hour is complete up to now, so a window
 * that ends now needs no part-hour at its end.
 */
export function wholeHours(
  from: Date,
  to: Date,
  now = Date.now(),
): { start: Date; end: Date } | null {
  const start = Math.ceil(from.getTime() / HOUR_MS) * HOUR_MS;
  const end =
    to.getTime() >= now
      ? Math.ceil(to.getTime() / HOUR_MS) * HOUR_MS
      : Math.floor(to.getTime() / HOUR_MS) * HOUR_MS;
  return start < end ? { start: new Date(start), end: new Date(end) } : null;
}

/**
 * A stored response in today's shape. Calls logged by an older version lack
 * fields added since, which the response schema requires.
 */
function current(response: SearchResponse): SearchResponse {
  return {
    ...response,
    results: response.results.map((result) => ({
      ...result,
      canonicalUrl: result.canonicalUrl ?? canonicalUrl(result.url),
    })),
    cache: response.cache ?? null,
  };
}

/** Keyset position in the newest-first call list. */
function encodeCursor(sentAt: string, id: string): string {
  return Buffer.from(`${sentAt}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { sentAt: string; id: string } | null {
  const [sentAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!sentAt || !id || Number.isNaN(Date.parse(sentAt)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    return null;
  }
  return { sentAt, id };
}

interface BalanceRow {
  provider: string;
  key_fingerprint: string;
  taken_at: Date;
  unit: "usd" | "credits";
  remaining: number | null;
  used: number | null;
  quota: number | null;
}

const point = (row: BalanceRow) => ({
  takenAt: row.taken_at.toISOString(),
  remaining: row.remaining,
  used: row.used,
  quota: row.quota,
});

const key = (row: { provider: string; key_fingerprint: string }) =>
  `${row.provider}|${row.key_fingerprint}`;

/** Rounded so dollar balances do not pick up binary floating-point noise. */
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** How much an account spent between two snapshots, from whichever counter the provider gives. */
export function spentBetween(
  first: Pick<Balance, "remaining" | "used">,
  last: Pick<Balance, "remaining" | "used">,
): number | null {
  const spent =
    first.used !== null && last.used !== null
      ? last.used - first.used
      : first.remaining !== null && last.remaining !== null
        ? first.remaining - last.remaining
        : null;
  // A negative change means a top-up or a new billing period, not spend.
  return spent === null || spent < 0 ? null : round(spent);
}

export function createPostgresStore(
  databaseUrl: string,
  options: { storeRaw: boolean },
): Store & {
  sql: postgres.Sql;
} {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  /** Adds two rollup sums that stay null while neither side has a value; `column` is a literal. */
  const addNullable = (column: string) =>
    sql.unsafe(
      `CASE WHEN t.${column} IS NULL AND excluded.${column} IS NULL THEN NULL
        ELSE coalesce(t.${column}, 0) + coalesce(excluded.${column}, 0) END`,
    );
  /**
   * Rollup rows for [from, to): whole hours from the rollup table, part-hours aggregated from the
   * call log through the same `call_facts` view the rollups are built from.
   */
  const countFacts = (from: Date, to: Date) => {
    const whole = wholeHours(from, to);
    return sql`
      SELECT hour, provider, key_fingerprint, client, calls, ok_calls, retries, cache_hits,
        upstream_requests, credits, reported_cost_usd, estimated_cost_usd, cost_usd,
        queued_ms_sum, queued_calls, billed_calls, billed_usd, billed_credits
      FROM gateway.call_counts_hourly
      WHERE ${whole ? sql`hour >= ${whole.start} AND hour < ${whole.end}` : sql`false`}
      UNION ALL
      SELECT hour, provider, key_fingerprint, client, sum(calls), sum(ok_calls), sum(retries),
        sum(cache_hits), sum(upstream_requests), sum(credits), sum(reported_cost_usd),
        sum(estimated_cost_usd), sum(cost_usd), sum(queued_ms_sum), sum(queued_calls),
        sum(billed_calls), sum(billed_usd), sum(billed_credits)
      FROM gateway.call_facts
      WHERE sent_at >= ${from} AND sent_at < ${to}
        ${whole ? sql`AND NOT (sent_at >= ${whole.start} AND sent_at < ${whole.end})` : sql``}
      GROUP BY hour, provider, key_fingerprint, client`;
  };
  const latencyFacts = (from: Date, to: Date) => {
    const whole = wholeHours(from, to);
    return sql`
      SELECT hour, provider, bucket, calls FROM gateway.call_latency_hourly
      WHERE ${whole ? sql`hour >= ${whole.start} AND hour < ${whole.end}` : sql`false`}
      UNION ALL
      SELECT hour, provider, latency_bucket, count(*)::int FROM gateway.call_facts
      WHERE latency_bucket IS NOT NULL AND sent_at >= ${from} AND sent_at < ${to}
        ${whole ? sql`AND NOT (sent_at >= ${whole.start} AND sent_at < ${whole.end})` : sql``}
      GROUP BY hour, provider, latency_bucket`;
  };
  return {
    sql,
    async saveCall({ response, params, batchId, groupId, keyFingerprint, client, raw }) {
      // `options` can carry anything a caller sends upstream; `raw` is only kept on request.
      const row = {
        id: response.id,
        batch_id: batchId,
        request_group_id: groupId,
        provider: response.provider,
        label: response.label,
        query: response.query,
        params: sql.json(params as postgres.JSONValue),
        sent_at: response.timing.sentAt,
        received_at: response.timing.receivedAt,
        latency_ms: response.timing.latencyMs,
        total_ms: response.timing.totalMs,
        queued_ms: response.timing.queuedMs,
        retry_count: response.retries.count,
        attempts: sql.json(response.retries.attempts),
        ok: response.ok,
        error_type: response.error?.type ?? null,
        error_message: response.error?.message ?? null,
        upstream_status: response.upstream.status,
        upstream_request_id: response.upstream.requestId,
        result_count: response.results.length,
        results: sql.json(response.results),
        usage: sql.json(response.usage),
        key_fingerprint: keyFingerprint,
        client,
        cache_hit: response.cache?.hit ?? false,
        credits: response.usage.credits ?? null,
        reported_cost_usd: response.usage.costUsd ?? null,
        estimated_cost_usd: response.usage.estimatedCostUsd ?? null,
        warnings: sql.json(response.warnings),
        response: sql.json(response as unknown as postgres.JSONValue),
      };
      const write = () =>
        sql.begin(async (tx) => {
          await tx`INSERT INTO gateway.search_calls ${tx(row)}`;
          if (options.storeRaw && raw !== undefined) {
            await tx`
              INSERT INTO gateway.search_call_raws (call_id, sent_at, raw)
              VALUES (${row.id}, ${row.sent_at}, ${tx.json(raw as postgres.JSONValue)})`;
          }
          // The rollups take what this call adds, by the same definition the backfill used.
          const fact = tx`
            FROM gateway.call_facts WHERE id = ${row.id} AND sent_at = ${row.sent_at}`;
          await tx`
            INSERT INTO gateway.call_counts_hourly AS t
            SELECT hour, provider, key_fingerprint, client, calls, ok_calls, retries, cache_hits,
              upstream_requests, credits, reported_cost_usd, estimated_cost_usd, cost_usd,
              queued_ms_sum, queued_calls, billed_calls, billed_usd, billed_credits
            ${fact}
            ON CONFLICT ON CONSTRAINT call_counts_hourly_key DO UPDATE SET
              calls = t.calls + excluded.calls,
              ok_calls = t.ok_calls + excluded.ok_calls,
              retries = t.retries + excluded.retries,
              cache_hits = t.cache_hits + excluded.cache_hits,
              upstream_requests = t.upstream_requests + excluded.upstream_requests,
              credits = ${addNullable("credits")},
              reported_cost_usd = ${addNullable("reported_cost_usd")},
              estimated_cost_usd = ${addNullable("estimated_cost_usd")},
              cost_usd = ${addNullable("cost_usd")},
              queued_ms_sum = t.queued_ms_sum + excluded.queued_ms_sum,
              queued_calls = t.queued_calls + excluded.queued_calls,
              billed_calls = t.billed_calls + excluded.billed_calls,
              billed_usd = t.billed_usd + excluded.billed_usd,
              billed_credits = t.billed_credits + excluded.billed_credits`;
          await tx`
            INSERT INTO gateway.call_latency_hourly AS t
            SELECT hour, provider, latency_bucket, 1 ${fact} AND latency_bucket IS NOT NULL
            ON CONFLICT (hour, provider, bucket) DO UPDATE SET calls = t.calls + 1`;
        });
      try {
        await write();
      } catch (error) {
        // The first call of a month nobody prepared a partition for: create it and try again.
        if ((error as { code?: string }).code !== NO_PARTITION) throw error;
        await createPartitions(sql, [new Date(row.sent_at)]);
        await write();
      }
    },

    async listCalls(query) {
      const after = query.cursor ? decodeCursor(query.cursor) : null;
      if (query.cursor && !after)
        throw Object.assign(new Error("invalid cursor"), { statusCode: 400 });
      const rows = await sql<{ response: SearchResponse }[]>`
        SELECT response FROM gateway.search_calls
        WHERE response IS NOT NULL
          ${query.provider ? sql`AND provider = ${query.provider}` : sql``}
          ${query.label ? sql`AND label = ${query.label}` : sql``}
          ${query.client ? sql`AND client = ${query.client}` : sql``}
          ${query.ok ? sql`AND ok = ${query.ok === "true"}` : sql``}
          ${query.errorType ? sql`AND error_type = ${query.errorType}` : sql``}
          ${query.q ? sql`AND query ILIKE ${`%${query.q.replace(/[\\%_]/g, "\\$&")}%`}` : sql``}
          ${query.batchId ? sql`AND batch_id = ${query.batchId}` : sql``}
          ${query.from ? sql`AND sent_at >= ${query.from}` : sql``}
          ${query.to ? sql`AND sent_at < ${query.to}` : sql``}
          ${after ? sql`AND (sent_at, id) < (${after.sentAt}::timestamptz, ${after.id}::uuid)` : sql``}
        ORDER BY sent_at DESC, id DESC
        LIMIT ${query.limit + 1}`;
      const calls = rows.slice(0, query.limit).map((row) => current(row.response));
      const last = calls.at(-1);
      return {
        calls,
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.timing.sentAt, last.id) : null,
      };
    },

    async getCall(id) {
      const [row] = await sql<{ response: SearchResponse; raw: unknown }[]>`
        SELECT c.response, r.raw
        FROM gateway.search_calls c
        LEFT JOIN gateway.search_call_raws r ON r.call_id = c.id
        WHERE c.id = ${id} AND c.response IS NOT NULL`;
      if (!row) return null;
      const response = current(row.response);
      return row.raw === null ? response : { ...response, raw: row.raw };
    },

    async saveBalance(snapshot) {
      await sql`INSERT INTO gateway.balance_snapshots ${sql({
        provider: snapshot.provider,
        key_fingerprint: snapshot.keyFingerprint,
        taken_at: snapshot.takenAt,
        unit: snapshot.unit,
        remaining: snapshot.remaining,
        used: snapshot.used,
        quota: snapshot.quota,
      })}`;
    },

    async usage(from, to) {
      const calls = await sql<
        {
          provider: string;
          key_fingerprint: string;
          calls: number;
          ok_calls: number;
          upstream_requests: number;
          credits: number | null;
          reported_cost_usd: number | null;
          estimated_cost_usd: number | null;
        }[]
      >`
        SELECT provider, key_fingerprint,
          sum(calls)::int AS calls,
          sum(ok_calls)::int AS ok_calls,
          sum(upstream_requests)::int AS upstream_requests,
          sum(credits)::float8 AS credits,
          sum(reported_cost_usd)::float8 AS reported_cost_usd,
          sum(estimated_cost_usd)::float8 AS estimated_cost_usd
        FROM (${countFacts(from, to)}) facts
        WHERE key_fingerprint IS NOT NULL
        GROUP BY provider, key_fingerprint`;
      // Per key: its newest snapshot overall, and the first and last inside the window.
      const snapshots = await sql<(BalanceRow & { kind: "latest" | "first" | "last" })[]>`
        (SELECT DISTINCT ON (provider, key_fingerprint) 'latest' AS kind, *
          FROM gateway.balance_snapshots
          ORDER BY provider, key_fingerprint, taken_at DESC)
        UNION ALL
        (SELECT DISTINCT ON (provider, key_fingerprint) 'first' AS kind, *
          FROM gateway.balance_snapshots WHERE taken_at >= ${from} AND taken_at < ${to}
          ORDER BY provider, key_fingerprint, taken_at)
        UNION ALL
        (SELECT DISTINCT ON (provider, key_fingerprint) 'last' AS kind, *
          FROM gateway.balance_snapshots WHERE taken_at >= ${from} AND taken_at < ${to}
          ORDER BY provider, key_fingerprint, taken_at DESC)`;

      const byKey = new Map<string, Partial<Record<"latest" | "first" | "last", BalanceRow>>>();
      for (const row of snapshots) {
        byKey.set(key(row), { ...byKey.get(key(row)), [row.kind]: row });
      }
      const callsByKey = new Map(calls.map((row) => [key(row), row]));

      return [...new Set([...callsByKey.keys(), ...byKey.keys()])].toSorted().map((id) => {
        const [provider = "", keyFingerprint = ""] = id.split("|");
        const row = callsByKey.get(id);
        const { latest, first, last } = byKey.get(id) ?? {};
        const okCalls = row?.ok_calls ?? 0;
        const spent =
          first && last && first.taken_at < last.taken_at ? spentBetween(first, last) : null;
        return {
          provider,
          keyFingerprint,
          calls: row?.calls ?? 0,
          okCalls,
          upstreamRequests: row?.upstream_requests ?? 0,
          credits: row?.credits ?? null,
          reportedCostUsd: row?.reported_cost_usd ?? null,
          estimatedCostUsd: row?.estimated_cost_usd ?? null,
          balance: latest
            ? {
                unit: latest.unit,
                latest: point(latest),
                window:
                  first && last && first.taken_at < last.taken_at
                    ? {
                        first: point(first),
                        last: point(last),
                        spent,
                        spentPerOkCall: spent !== null && okCalls > 0 ? spent / okCalls : null,
                      }
                    : null,
              }
            : null,
        };
      });
    },

    async usageByClient(from, to) {
      const rows = await sql<
        {
          client: string | null;
          provider: string;
          calls: number;
          ok_calls: number;
          upstream_requests: number;
          credits: number | null;
          reported_cost_usd: number | null;
          estimated_cost_usd: number | null;
        }[]
      >`
        SELECT client, provider,
          sum(calls)::int AS calls,
          sum(ok_calls)::int AS ok_calls,
          sum(upstream_requests)::int AS upstream_requests,
          sum(credits)::float8 AS credits,
          sum(reported_cost_usd)::float8 AS reported_cost_usd,
          sum(estimated_cost_usd)::float8 AS estimated_cost_usd
        FROM (${countFacts(from, to)}) facts
        GROUP BY client, provider
        ORDER BY client NULLS LAST, provider`;
      return rows.map((row) => ({
        client: row.client,
        provider: row.provider,
        calls: row.calls,
        okCalls: row.ok_calls,
        upstreamRequests: row.upstream_requests,
        credits: row.credits,
        reportedCostUsd: row.reported_cost_usd,
        estimatedCostUsd: row.estimated_cost_usd,
      }));
    },

    async stats(from, to, bucket) {
      const [rows, latencies] = await Promise.all([
        sql<
          {
            bucket: Date;
            provider: string;
            calls: number;
            failures: number;
            retries: number;
            cache_hits: number;
            queued_ms_sum: number;
            queued_calls: number;
            cost_usd: number | null;
          }[]
        >`
          SELECT date_trunc(${bucket}, hour, 'UTC') AS bucket, provider,
            sum(calls)::int AS calls,
            sum(calls - ok_calls)::int AS failures,
            sum(retries)::int AS retries,
            sum(cache_hits)::int AS cache_hits,
            sum(queued_ms_sum)::float8 AS queued_ms_sum,
            sum(queued_calls)::int AS queued_calls,
            sum(cost_usd)::float8 AS cost_usd
          FROM (${countFacts(from, to)}) facts
          GROUP BY 1, 2
          ORDER BY 1, 2`,
        sql<{ bucket: Date; provider: string; latency_bucket: number; calls: number }[]>`
          SELECT date_trunc(${bucket}, hour, 'UTC') AS bucket, provider,
            bucket AS latency_bucket, sum(calls)::int AS calls
          FROM (${latencyFacts(from, to)}) facts
          GROUP BY 1, 2, 3`,
      ]);
      const histograms = new Map<string, [number, number][]>();
      for (const row of latencies) {
        const id = `${row.bucket.toISOString()}|${row.provider}`;
        histograms.set(id, [...(histograms.get(id) ?? []), [row.latency_bucket, row.calls]]);
      }
      return rows.map((row) => {
        const histogram = histograms.get(`${row.bucket.toISOString()}|${row.provider}`) ?? [];
        return {
          bucket: row.bucket.toISOString(),
          provider: row.provider,
          calls: row.calls,
          failures: row.failures,
          retries: row.retries,
          cacheHits: row.cache_hits,
          p50LatencyMs: histogramPercentile(histogram, 0.5),
          p95LatencyMs: histogramPercentile(histogram, 0.95),
          avgQueuedMs: row.queued_calls > 0 ? row.queued_ms_sum / row.queued_calls : null,
          costUsd: row.cost_usd === null ? null : round(row.cost_usd),
        };
      });
    },

    async spendSince(dayStart, monthStart) {
      const rows = await sql<
        { provider: string; period: "day" | "month"; calls: number; usd: number; credits: number }[]
      >`
        SELECT provider, period,
          sum(billed_calls)::int AS calls,
          sum(billed_usd)::float8 AS usd,
          sum(billed_credits)::float8 AS credits
        FROM (${countFacts(monthStart < dayStart ? monthStart : dayStart, new Date())}) facts,
          LATERAL (VALUES ('day', ${dayStart}::timestamptz), ('month', ${monthStart}::timestamptz))
            AS periods (period, started)
        WHERE hour >= started
        GROUP BY provider, period
        HAVING sum(billed_calls) > 0`;
      const byProvider = new Map<string, ProviderSpend>();
      for (const row of rows) {
        const entry = byProvider.get(row.provider) ?? {
          provider: row.provider,
          day: { calls: 0, usd: 0, credits: 0 },
          month: { calls: 0, usd: 0, credits: 0 },
        };
        entry[row.period] = { calls: row.calls, usd: row.usd, credits: row.credits };
        byProvider.set(row.provider, entry);
      }
      return [...byProvider.values()];
    },

    async recentOutcomes(perProvider) {
      const rows = await sql<
        {
          provider: string;
          ok: boolean;
          latency_ms: number;
          received_at: Date;
          error_type: string | null;
          error_message: string | null;
        }[]
      >`
        SELECT recent.provider, ok, latency_ms, received_at, error_type, error_message
        -- The providers ever called, from the small rollup table; then the newest calls of each,
        -- read backwards along (provider, sent_at) instead of numbering the whole log.
        FROM (SELECT DISTINCT provider FROM gateway.call_counts_hourly) providers,
          LATERAL (
            SELECT * FROM gateway.search_calls calls
            WHERE calls.provider = providers.provider
              AND NOT cache_hit
              -- These failures say nothing about the provider: nothing was sent, or the caller was at fault.
              AND (error_type IS NULL OR NOT (error_type = ANY(${NOT_THE_PROVIDER as string[]})))
            ORDER BY sent_at DESC
            LIMIT ${perProvider}
          ) recent
        ORDER BY recent.provider, sent_at`;
      return rows.map((row) => ({
        provider: row.provider,
        ok: row.ok,
        latencyMs: row.latency_ms,
        receivedAt: row.received_at.toISOString(),
        error: row.error_type ? { type: row.error_type, message: row.error_message ?? "" } : null,
      }));
    },

    async cleanup({ callDays, rawDays }) {
      let calls = 0;
      let raws = 0;
      // Keep the partitions ahead of the calendar while here, so a month never starts without one.
      await createPartitions(sql, [new Date(), nextMonth(new Date())]);
      if (callDays > 0) {
        const cutoff = new Date(Date.now() - callDays * 86_400_000);
        // Months entirely before the cutoff go at once; dropping a table leaves no dead rows.
        const partitions = await sql<{ name: string }[]>`
          SELECT child.relname AS name
          FROM pg_inherits
          JOIN pg_class child ON child.oid = pg_inherits.inhrelid
          WHERE pg_inherits.inhparent = 'gateway.search_calls'::regclass`;
        for (const { name } of partitions) {
          const month = /^search_calls_(\d{4})_(\d{2})$/.exec(name);
          if (!month) continue;
          const end = new Date(Date.UTC(Number(month[1]), Number(month[2]), 1));
          if (end > cutoff) continue;
          const [counted] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM gateway.${sql(name)}`;
          await sql`DROP TABLE gateway.${sql(name)}`;
          calls += counted?.n ?? 0;
        }
        // The rest of the cutoff falls inside one month: those rows are deleted one by one.
        calls += (await sql`DELETE FROM gateway.search_calls WHERE sent_at < ${cutoff}`).count;
        await sql`DELETE FROM gateway.balance_snapshots WHERE taken_at < ${cutoff}`;
        // A raw body never outlives its call.
        await sql`DELETE FROM gateway.search_call_raws WHERE sent_at < ${cutoff}`;
      }
      if (rawDays > 0) {
        const cutoff = new Date(Date.now() - rawDays * 86_400_000);
        raws = (await sql`DELETE FROM gateway.search_call_raws WHERE sent_at < ${cutoff}`).count;
      }
      return { calls, raws };
    },

    async ping() {
      await sql`SELECT 1`;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
