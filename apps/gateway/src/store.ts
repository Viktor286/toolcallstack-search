import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
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

export async function migrate(sql: postgres.Sql): Promise<string[]> {
  await sql`CREATE SCHEMA IF NOT EXISTS gateway`;
  await sql`
    CREATE TABLE IF NOT EXISTS gateway.migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).toSorted();
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
  return applied;
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
        credits: response.usage.credits ?? null,
        reported_cost_usd: response.usage.costUsd ?? null,
        estimated_cost_usd: response.usage.estimatedCostUsd ?? null,
        warnings: sql.json(response.warnings),
        response: sql.json(response as unknown as postgres.JSONValue),
        raw: options.storeRaw && raw !== undefined ? sql.json(raw as postgres.JSONValue) : null,
      };
      await sql`INSERT INTO gateway.search_calls ${sql(row)}`;
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
          ${query.batchId ? sql`AND batch_id = ${query.batchId}` : sql``}
          ${query.from ? sql`AND sent_at >= ${query.from}` : sql``}
          ${query.to ? sql`AND sent_at < ${query.to}` : sql``}
          ${after ? sql`AND (sent_at, id) < (${after.sentAt}::timestamptz, ${after.id}::uuid)` : sql``}
        ORDER BY sent_at DESC, id DESC
        LIMIT ${query.limit + 1}`;
      const calls = rows.slice(0, query.limit).map((row) => row.response);
      const last = calls.at(-1);
      return {
        calls,
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.timing.sentAt, last.id) : null,
      };
    },

    async getCall(id) {
      const [row] = await sql<{ response: SearchResponse; raw: unknown }[]>`
        SELECT response, raw FROM gateway.search_calls WHERE id = ${id} AND response IS NOT NULL`;
      if (!row) return null;
      return row.raw === null ? row.response : { ...row.response, raw: row.raw };
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
          count(*)::int AS calls,
          count(*) FILTER (WHERE ok)::int AS ok_calls,
          coalesce(sum(jsonb_array_length(attempts)), 0)::int AS upstream_requests,
          sum(credits)::float8 AS credits,
          sum(reported_cost_usd)::float8 AS reported_cost_usd,
          sum(estimated_cost_usd)::float8 AS estimated_cost_usd
        FROM gateway.search_calls
        WHERE sent_at >= ${from} AND sent_at < ${to} AND key_fingerprint IS NOT NULL
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
          count(*)::int AS calls,
          count(*) FILTER (WHERE ok)::int AS ok_calls,
          coalesce(sum(jsonb_array_length(attempts)), 0)::int AS upstream_requests,
          sum(credits)::float8 AS credits,
          sum(reported_cost_usd)::float8 AS reported_cost_usd,
          sum(estimated_cost_usd)::float8 AS estimated_cost_usd
        FROM gateway.search_calls
        WHERE sent_at >= ${from} AND sent_at < ${to}
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
      const rows = await sql<
        {
          bucket: Date;
          provider: string;
          calls: number;
          failures: number;
          retries: number;
          p50: number | null;
          p95: number | null;
          queued: number | null;
          cost_usd: number | null;
        }[]
      >`
        SELECT date_trunc(${bucket}, sent_at, 'UTC') AS bucket, provider,
          count(*)::int AS calls,
          count(*) FILTER (WHERE NOT ok)::int AS failures,
          coalesce(sum(retry_count), 0)::int AS retries,
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok))::float8 AS p50,
          (percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok))::float8 AS p95,
          avg(queued_ms)::float8 AS queued,
          sum(coalesce(reported_cost_usd, estimated_cost_usd))::float8 AS cost_usd
        FROM gateway.search_calls
        WHERE sent_at >= ${from} AND sent_at < ${to}
        GROUP BY 1, 2
        ORDER BY 1, 2`;
      return rows.map((row) => ({
        bucket: row.bucket.toISOString(),
        provider: row.provider,
        calls: row.calls,
        failures: row.failures,
        retries: row.retries,
        p50LatencyMs: row.p50,
        p95LatencyMs: row.p95,
        avgQueuedMs: row.queued,
        costUsd: row.cost_usd === null ? null : round(row.cost_usd),
      }));
    },

    async spendSince(dayStart, monthStart) {
      const rows = await sql<
        { provider: string; period: "day" | "month"; calls: number; usd: number; credits: number }[]
      >`
        SELECT provider, period,
          count(*)::int AS calls,
          coalesce(sum(coalesce(reported_cost_usd, estimated_cost_usd)), 0)::float8 AS usd,
          coalesce(sum(credits), 0)::float8 AS credits
        FROM gateway.search_calls,
          LATERAL (VALUES ('day', ${dayStart}::timestamptz), ('month', ${monthStart}::timestamptz))
            AS periods (period, started)
        WHERE ok AND sent_at >= started
        GROUP BY provider, period`;
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
        SELECT provider, ok, latency_ms, received_at, error_type, error_message
        FROM (
          SELECT *, row_number() OVER (PARTITION BY provider ORDER BY sent_at DESC) AS recency
          FROM gateway.search_calls
          -- These failures happen before anything is sent, so they say nothing about the provider.
          WHERE error_type IS NULL
            OR error_type NOT IN ('not_configured', 'throttled', 'budget_exceeded')
        ) calls
        WHERE recency <= ${perProvider}
        ORDER BY provider, sent_at`;
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
      if (callDays > 0) {
        const cutoff = new Date(Date.now() - callDays * 86_400_000);
        calls = (await sql`DELETE FROM gateway.search_calls WHERE sent_at < ${cutoff}`).count;
        await sql`DELETE FROM gateway.balance_snapshots WHERE taken_at < ${cutoff}`;
      }
      if (rawDays > 0) {
        const cutoff = new Date(Date.now() - rawDays * 86_400_000);
        raws = (
          await sql`
            UPDATE gateway.search_calls SET raw = NULL
            WHERE raw IS NOT NULL AND sent_at < ${cutoff}`
        ).count;
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
