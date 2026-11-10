import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SearchResponse } from "../src/schema.ts";
import { callsQuerySchema, searchParamsSchema } from "../src/schema.ts";
import { createPostgresStore, migrate } from "../src/store.ts";

// Needs a disposable Postgres database: TEST_DATABASE_URL=postgres://localhost/toolcallstack_search_test
const databaseUrl = process.env.TEST_DATABASE_URL;

function call(overrides: {
  provider: string;
  sentAt: string;
  ok?: boolean;
  attempts?: number;
  credits?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
}): SearchResponse {
  const ok = overrides.ok ?? true;
  const attempt = {
    sentAt: overrides.sentAt,
    queuedMs: 0,
    latencyMs: 10,
    phases: null,
    upstreamStatus: ok ? 200 : 500,
    error: ok ? null : ("upstream_error" as const),
    backoffMs: null,
  };
  return {
    id: crypto.randomUUID(),
    provider: overrides.provider,
    label: overrides.provider,
    query: "q",
    ok,
    results: [],
    timing: {
      sentAt: overrides.sentAt,
      receivedAt: overrides.sentAt,
      latencyMs: 10,
      totalMs: 10,
      queuedMs: 0,
      phases: null,
    },
    retries: {
      count: (overrides.attempts ?? 1) - 1,
      backoffMs: 0,
      attempts: Array.from({ length: overrides.attempts ?? 1 }, () => ({ ...attempt })),
    },
    usage: {
      credits: overrides.credits,
      costUsd: overrides.costUsd,
      estimatedCostUsd: overrides.estimatedCostUsd,
      costSource: "estimated",
    },
    upstream: { status: ok ? 200 : 500, requestId: null },
    warnings: [],
    error: ok ? null : { type: "upstream_error", message: "x", upstreamStatus: 500 },
    fallback: { tried: [] },
  };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe.skipIf(!databaseUrl)("postgres store", () => {
  let store: ReturnType<typeof createPostgresStore>;
  const params = searchParamsSchema.parse({ query: "q" });
  const save = (
    response: SearchResponse,
    extra: { batchId?: string; raw?: unknown; key?: string; client?: string } = {},
  ) =>
    store.saveCall({
      response,
      params,
      batchId: extra.batchId ?? null,
      groupId: null,
      client: extra.client ?? null,
      keyFingerprint: extra.key ?? "aaaaaaaa",
      raw: extra.raw,
    });
  const list = (query: Record<string, string> = {}) =>
    store.listCalls(callsQuerySchema.parse(query));

  beforeAll(async () => {
    store = createPostgresStore(databaseUrl!, { storeRaw: true });
    await store.sql`DROP SCHEMA IF EXISTS gateway CASCADE`;
    expect(await migrate(store.sql)).toHaveLength(5);
    expect(await migrate(store.sql)).toEqual([]);
  });
  afterAll(() => store.close());
  beforeEach(async () => {
    await store.sql`TRUNCATE gateway.search_calls, gateway.balance_snapshots`;
  });

  it("round-trips calls, filters them and pages newest first", async () => {
    const batchId = crypto.randomUUID();
    const calls = [
      call({ provider: "tavily", sentAt: "2026-11-09T10:00:00.000Z" }),
      call({ provider: "you", sentAt: "2026-11-09T10:01:00.000Z", ok: false }),
      call({ provider: "tavily", sentAt: "2026-11-09T10:02:00.000Z" }),
      call({ provider: "tavily", sentAt: "2026-11-09T10:02:00.000Z" }),
      call({ provider: "exa", sentAt: "2026-11-09T10:03:00.000Z" }),
    ];
    await save(calls[0]!, { raw: { upstream: true } });
    await save(calls[1]!, { batchId });
    for (const response of calls.slice(2)) await save(response);

    const all = await list();
    expect(all.calls).toHaveLength(5);
    expect(all.nextCursor).toBeNull();
    expect(all.calls[0]).toEqual(calls[4]);

    // Paging never repeats or skips, even across calls sent in the same millisecond.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list({ limit: "2", ...(cursor ? { cursor } : {}) });
      seen.push(...page.calls.map((c) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(calls.map((c) => c.id)));
    expect(seen[0]).toBe(calls[4]!.id);
    expect(seen[4]).toBe(calls[0]!.id);

    expect((await list({ provider: "tavily" })).calls).toHaveLength(3);
    expect((await list({ ok: "false" })).calls.map((c) => c.id)).toEqual([calls[1]!.id]);
    expect((await list({ batchId })).calls.map((c) => c.id)).toEqual([calls[1]!.id]);
    expect(
      (await list({ from: "2026-11-09T10:01:00Z", to: "2026-11-09T10:02:00Z" })).calls.map(
        (c) => c.id,
      ),
    ).toEqual([calls[1]!.id]);
    await expect(list({ cursor: "garbage" })).rejects.toMatchObject({ statusCode: 400 });

    expect(await store.getCall(calls[0]!.id)).toEqual({ ...calls[0], raw: { upstream: true } });
    expect(await store.getCall(calls[2]!.id)).toEqual(calls[2]);
    expect(await store.getCall(crypto.randomUUID())).toBeNull();
  });

  it("summarises usage and balance change per provider and key", async () => {
    await save(
      call({
        provider: "tavily",
        sentAt: "2026-11-09T10:00:00.000Z",
        credits: 1,
        estimatedCostUsd: 0.008,
      }),
    );
    await save(
      call({
        provider: "tavily",
        sentAt: "2026-11-09T10:05:00.000Z",
        credits: 2,
        estimatedCostUsd: 0.016,
        attempts: 3,
      }),
    );
    await save(
      call({ provider: "tavily", sentAt: "2026-11-09T10:06:00.000Z", ok: false, attempts: 2 }),
    );
    await save(call({ provider: "tavily", sentAt: "2026-11-09T10:07:00.000Z", credits: 1 }), {
      key: "bbbbbbbb",
    });
    await save(call({ provider: "tavily", sentAt: "2026-11-08T10:00:00.000Z", credits: 50 }));
    await save(call({ provider: "exa", sentAt: "2026-11-09T10:00:00.000Z", costUsd: 0.007 }));

    const snapshot = (
      provider: string,
      takenAt: string,
      used: number | null,
      remaining: number | null,
    ) =>
      store.saveBalance({
        provider,
        keyFingerprint: "aaaaaaaa",
        takenAt: new Date(takenAt),
        unit: provider === "you" ? "usd" : "credits",
        used,
        remaining,
        quota: 1000,
      });
    await snapshot("tavily", "2026-11-08T09:00:00Z", 1, 999);
    await snapshot("tavily", "2026-11-09T09:59:00Z", 60, 940);
    await snapshot("tavily", "2026-11-09T10:30:00Z", 64, 936);
    await snapshot("tavily", "2026-11-10T09:00:00Z", 70, 930);
    await snapshot("you", "2026-11-09T10:10:00Z", null, 9.94);

    const usage = await store.usage(
      new Date("2026-11-09T00:00:00Z"),
      new Date("2026-11-10T00:00:00Z"),
    );
    expect(usage.map((row) => [row.provider, row.keyFingerprint])).toEqual([
      ["exa", "aaaaaaaa"],
      ["tavily", "aaaaaaaa"],
      ["tavily", "bbbbbbbb"],
      ["you", "aaaaaaaa"],
    ]);
    expect(usage[0]).toMatchObject({
      calls: 1,
      reportedCostUsd: 0.007,
      estimatedCostUsd: null,
      balance: null,
    });
    expect(usage[1]).toMatchObject({
      calls: 3,
      okCalls: 2,
      upstreamRequests: 6,
      credits: 3,
      reportedCostUsd: null,
      balance: {
        unit: "credits",
        latest: { takenAt: "2026-11-10T09:00:00.000Z", used: 70, remaining: 930, quota: 1000 },
        window: {
          first: { takenAt: "2026-11-09T09:59:00.000Z", used: 60 },
          last: { takenAt: "2026-11-09T10:30:00.000Z", used: 64 },
          spent: 4,
          spentPerOkCall: 2,
        },
      },
    });
    expect(usage[1]?.estimatedCostUsd).toBeCloseTo(0.024);
    expect(usage[2]).toMatchObject({ calls: 1, credits: 1, balance: null });
    // One snapshot in the window is not enough to measure a change.
    expect(usage[3]).toMatchObject({
      calls: 0,
      balance: { unit: "usd", latest: { remaining: 9.94 }, window: null },
    });
  });

  it("filters and groups by client", async () => {
    await save(call({ provider: "tavily", sentAt: "2026-11-09T10:00:00.000Z", credits: 1 }), {
      client: "alice",
    });
    await save(
      call({ provider: "tavily", sentAt: "2026-11-09T10:01:00.000Z", credits: 2, attempts: 2 }),
      { client: "alice" },
    );
    await save(call({ provider: "exa", sentAt: "2026-11-09T10:02:00.000Z", costUsd: 0.007 }), {
      client: "bob",
    });
    await save(call({ provider: "exa", sentAt: "2026-11-09T10:03:00.000Z", ok: false }));

    expect((await list({ client: "alice" })).calls).toHaveLength(2);
    expect((await list({ client: "nobody" })).calls).toHaveLength(0);
    const usage = await store.usageByClient(
      new Date("2026-11-09T00:00:00Z"),
      new Date("2026-11-10T00:00:00Z"),
    );
    expect(usage).toEqual([
      {
        client: "alice",
        provider: "tavily",
        calls: 2,
        okCalls: 2,
        upstreamRequests: 3,
        credits: 3,
        reportedCostUsd: null,
        estimatedCostUsd: null,
      },
      {
        client: "bob",
        provider: "exa",
        calls: 1,
        okCalls: 1,
        upstreamRequests: 1,
        credits: null,
        reportedCostUsd: 0.007,
        estimatedCostUsd: null,
      },
      {
        client: null,
        provider: "exa",
        calls: 1,
        okCalls: 0,
        upstreamRequests: 1,
        credits: null,
        reportedCostUsd: null,
        estimatedCostUsd: null,
      },
    ]);
  });

  it("buckets calls, failures, latency and cost over time", async () => {
    await save(
      call({ provider: "tavily", sentAt: "2026-11-09T10:05:00.000Z", estimatedCostUsd: 0.008 }),
    );
    await save(
      call({
        provider: "tavily",
        sentAt: "2026-11-09T10:55:00.000Z",
        costUsd: 0.01,
        estimatedCostUsd: 0.008,
        attempts: 3,
      }),
    );
    await save(call({ provider: "tavily", sentAt: "2026-11-09T10:56:00.000Z", ok: false }));
    await save(call({ provider: "tavily", sentAt: "2026-11-09T11:00:00.000Z" }));
    await save(call({ provider: "exa", sentAt: "2026-11-09T23:30:00.000Z" }));
    const from = new Date("2026-11-09T00:00:00Z");
    const to = new Date("2026-11-10T00:00:00Z");

    const hourly = await store.stats(from, to, "hour");
    expect(hourly.map((p) => [p.bucket, p.provider, p.calls, p.failures, p.retries])).toEqual([
      ["2026-11-09T10:00:00.000Z", "tavily", 3, 1, 2],
      ["2026-11-09T11:00:00.000Z", "tavily", 1, 0, 0],
      ["2026-11-09T23:00:00.000Z", "exa", 1, 0, 0],
    ]);
    expect(hourly[0]).toMatchObject({ p50LatencyMs: 10, p95LatencyMs: 10, avgQueuedMs: 0 });
    // Reported cost wins over the estimate for the same call.
    expect(hourly[0]?.costUsd).toBeCloseTo(0.018);
    expect(hourly[1]?.costUsd).toBeNull();

    const daily = await store.stats(from, to, "day");
    expect(daily.map((p) => [p.bucket, p.provider, p.calls])).toEqual([
      ["2026-11-09T00:00:00.000Z", "exa", 1],
      ["2026-11-09T00:00:00.000Z", "tavily", 4],
    ]);
  });

  it("reports billed spend since the start of the day and month", async () => {
    await save(
      call({
        provider: "tavily",
        sentAt: "2026-11-01T00:00:00.000Z",
        credits: 5,
        estimatedCostUsd: 0.04,
      }),
    );
    await save(
      call({
        provider: "tavily",
        sentAt: "2026-11-09T08:00:00.000Z",
        credits: 1,
        estimatedCostUsd: 0.008,
      }),
    );
    await save(call({ provider: "tavily", sentAt: "2026-11-09T09:00:00.000Z", ok: false }));
    await save(call({ provider: "tavily", sentAt: "2026-10-31T23:59:59.000Z", credits: 99 }));
    await save(
      call({
        provider: "exa",
        sentAt: "2026-11-03T00:00:00.000Z",
        costUsd: 0.007,
        estimatedCostUsd: 0.005,
      }),
    );

    const spend = await store.spendSince(
      new Date("2026-11-09T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z"),
    );
    const byProvider = Object.fromEntries(spend.map((row) => [row.provider, row]));
    expect(byProvider.tavily?.day).toEqual({ calls: 1, usd: 0.008, credits: 1 });
    expect(byProvider.tavily?.month.calls).toBe(2);
    expect(byProvider.tavily?.month.credits).toBe(6);
    expect(byProvider.tavily?.month.usd).toBeCloseTo(0.048);
    expect(byProvider.exa).toEqual({
      provider: "exa",
      day: { calls: 0, usd: 0, credits: 0 },
      month: { calls: 1, usd: 0.007, credits: 0 },
    });
  });

  it("applies retention to calls, snapshots and raw bodies", async () => {
    const old = call({ provider: "tavily", sentAt: daysAgo(40) });
    const middle = call({ provider: "tavily", sentAt: daysAgo(10) });
    const fresh = call({ provider: "tavily", sentAt: daysAgo(1) });
    for (const response of [old, middle, fresh]) await save(response, { raw: { body: true } });
    for (const days of [40, 1]) {
      await store.saveBalance({
        provider: "tavily",
        keyFingerprint: "aaaaaaaa",
        takenAt: new Date(daysAgo(days)),
        unit: "credits",
        used: 1,
        remaining: 1,
        quota: null,
      });
    }

    expect(await store.cleanup({ callDays: 0, rawDays: 0 })).toEqual({ calls: 0, raws: 0 });
    expect(await store.cleanup({ callDays: 30, rawDays: 7 })).toEqual({ calls: 1, raws: 1 });
    expect(await store.getCall(old.id)).toBeNull();
    expect(await store.getCall(middle.id)).not.toHaveProperty("raw");
    expect(await store.getCall(fresh.id)).toHaveProperty("raw");
    expect((await store.sql`SELECT count(*)::int AS n FROM gateway.balance_snapshots`)[0]?.n).toBe(
      1,
    );
  });
});
