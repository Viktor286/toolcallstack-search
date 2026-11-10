import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startTracing } from "../src/tracing.ts";

const exporter = new InMemorySpanExporter();
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent" }),
    env: {},
    sleep: async () => {},
    tracing: startTracing({}, { exporter }),
    transport: async (request) => {
      throw new Error(`unexpected upstream request to ${request.url}`);
    },
  });
});
afterAll(() => app.close());
beforeEach(() => exporter.reset());

const search = (payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { traceparent: `00-${TRACE_ID}-b7ad6b7169203331-01` },
    payload: { provider: "demo-a", query: "secret query text", ...payload },
  });

const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().filter((span) => span.name === name);

describe("tracing", () => {
  it("is off unless an OTLP endpoint is configured", () => {
    expect(startTracing({})).toBeNull();
    expect(
      startTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_SDK_DISABLED: "true" }),
    ).toBeNull();
  });

  it("puts a search span with one upstream span under the caller's trace", async () => {
    const reply = await search({ options: { latencyMs: 1 } });
    expect(reply.statusCode).toBe(200);

    const [searchSpan] = named("search demo-a");
    const [upstream] = named("upstream demo-a");
    expect(searchSpan && upstream).toBeTruthy();
    expect(spans().every((span) => span.spanContext().traceId === TRACE_ID)).toBe(true);
    expect(upstream!.parentSpanContext?.spanId).toBe(searchSpan!.spanContext().spanId);
    // The search span hangs off a request span, which hangs off the caller's span.
    const parents = spans().map((span) => span.parentSpanContext?.spanId);
    expect(parents).toContain("b7ad6b7169203331");
    expect(spans().map((span) => span.spanContext().spanId)).toContain(
      searchSpan!.parentSpanContext?.spanId,
    );

    expect(searchSpan!.attributes).toMatchObject({
      "search.provider": "demo-a",
      "search.call_id": reply.json().id,
      "search.results": 10,
      "search.retries": 0,
      "search.cost_usd": 0,
    });
    expect(upstream!.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "server.address": "demo-a",
      "search.attempt": 1,
    });
    expect(upstream!.attributes["search.phase.ttfb_ms"]).toBeGreaterThan(0);
  });

  it("never records the query text", async () => {
    await search({ options: { latencyMs: 1 } });
    expect(
      JSON.stringify(spans().map((span) => [span.name, span.attributes, span.events])),
    ).not.toContain("secret query");
  });

  it("records every attempt and the retry between them", async () => {
    await search({ maxRetries: 1, options: { latencyMs: 1, status: 503 } });
    const [searchSpan] = named("search demo-a");
    expect(named("upstream demo-a").map((span) => span.attributes["search.attempt"])).toEqual([
      1, 2,
    ]);
    expect(searchSpan!.attributes).toMatchObject({
      "search.retries": 1,
      "error.type": "upstream_error",
    });
    expect(searchSpan!.status.code).toBe(2);
    expect(searchSpan!.events.map((event) => event.name)).toEqual(["retry"]);
  });

  it("leaves health checks out", async () => {
    await app.inject("/health");
    expect(spans()).toHaveLength(0);
  });
});
