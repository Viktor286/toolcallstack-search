import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { TransportRequest } from "../src/transport.ts";

const phases = {
  dnsMs: null,
  connectMs: null,
  tlsMs: null,
  ttfbMs: 5,
  downloadMs: 1,
  connectionReused: true,
};

const tavilyBody = {
  results: [
    {
      url: "https://a.com/1",
      title: "One",
      content: `first   line\n${"x".repeat(700)}`,
      published_date: "Wed, 16 Sep 2026 18:00:14 GMT",
    },
    { url: "https://a.com/2", title: "", content: "" },
  ],
  usage: { credits: 1 },
};

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.toReversed()) await close();
  cleanup = [];
});

/** A listening gateway with a fake upstream, and an MCP client connected to it. */
async function connect(overrides: Record<string, string> = {}, token?: string) {
  const upstream: TransportRequest[] = [];
  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", ...overrides }),
    env: { TAVILY_API_KEY: "t", YOU_API_KEY: "y" },
    sleep: async () => {},
    transport: async (request) => {
      upstream.push(request);
      return request.url.includes("tavily")
        ? { status: 200, headers: {}, text: JSON.stringify(tavilyBody), phases }
        : { status: 401, headers: {}, text: JSON.stringify({ error: "bad key" }), phases };
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  cleanup.push(() => app.close());
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  return { app, url, upstream, client, transport };
}

describe("MCP endpoint", () => {
  it("lists the tools with their input schemas", async () => {
    const { client, transport } = await connect();
    await client.connect(transport);
    cleanup.push(() => client.close());
    expect(client.getServerVersion()).toMatchObject({ name: "toolcallstack-search" });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "list_providers",
      "web_search",
      "web_search_batch",
    ]);
    const search = tools.find((tool) => tool.name === "web_search")!;
    expect(search.description).toContain("available: tavily, you");
    expect(search.inputSchema.required).toEqual(expect.arrayContaining(["query", "provider"]));
    expect(search.inputSchema.properties).not.toHaveProperty("maxRetries");
    const batch = tools.find((tool) => tool.name === "web_search_batch")!;
    expect(batch.inputSchema.required).toEqual(expect.arrayContaining(["query", "providers"]));
    expect(batch.inputSchema.properties).not.toHaveProperty("provider");
  });

  it("runs web_search and returns readable text plus the full response", async () => {
    const { client, transport, upstream } = await connect();
    await client.connect(transport);
    cleanup.push(() => client.close());
    const result = await client.callTool({
      name: "web_search",
      arguments: { provider: "tavily", query: "hello", maxResults: 2, country: "us" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('2 results from tavily for "hello"');
    expect(text).toContain(
      "1. One\n   https://a.com/1\n   published: 2026-09-16T18:00:14.000Z\n   first line x",
    );
    expect(text).toContain("2. (untitled)\n   https://a.com/2\n   published: unknown");
    expect(text).toContain("…");
    expect(text).toContain("Warnings: country is not supported and was ignored");
    expect(result.structuredContent).toMatchObject({
      provider: "tavily",
      ok: true,
      usage: { credits: 1, costSource: "estimated" },
    });
    expect(JSON.parse(upstream[0]!.body!)).toMatchObject({ query: "hello", max_results: 2 });
  });

  it("falls back, and reports a failure as a tool error", async () => {
    const { client, transport } = await connect();
    await client.connect(transport);
    cleanup.push(() => client.close());
    const recovered = await client.callTool({
      name: "web_search",
      arguments: { provider: "you", fallbacks: ["tavily"], query: "hello" },
    });
    expect(recovered.isError).toBeFalsy();
    expect((recovered.content as { text: string }[])[0]!.text).toContain(
      "Fell back after: you (auth_error)",
    );

    const failed = await client.callTool({
      name: "web_search",
      arguments: { provider: "you", query: "hello" },
    });
    expect(failed.isError).toBe(true);
    expect((failed.content as { text: string }[])[0]!.text).toMatch(
      /^Search with you failed \(auth_error\)/,
    );

    const invalid = await client.callTool({ name: "web_search", arguments: { provider: "you" } });
    expect(invalid.isError).toBe(true);
  });

  it("runs web_search_batch and list_providers", async () => {
    const { client, transport } = await connect();
    await client.connect(transport);
    cleanup.push(() => client.close());
    const batch = await client.callTool({
      name: "web_search_batch",
      arguments: { providers: ["tavily", "you"], query: "hello" },
    });
    expect(batch.isError).toBeFalsy();
    const structured = batch.structuredContent as { batchId: string; responses: { ok: boolean }[] };
    expect(structured.responses.map((response) => response.ok)).toEqual([true, false]);
    expect((batch.content as { text: string }[])[0]!.text).toContain(
      "\n\n---\n\nSearch with you failed",
    );

    const list = await client.callTool({ name: "list_providers", arguments: {} });
    const text = (list.content as { text: string }[])[0]!.text;
    expect(text).toContain("tavily (Tavily): configured");
    expect(text).toContain("exa (Exa): not configured");
    expect((list.structuredContent as { providers: unknown[] }).providers).toHaveLength(7);
  });

  it("requires the gateway API key when one is configured", async () => {
    const denied = await connect({ GATEWAY_API_KEYS: "secret" });
    await expect(denied.client.connect(denied.transport)).rejects.toThrow();

    const allowed = await connect({ GATEWAY_API_KEYS: "secret" }, "secret");
    await allowed.client.connect(allowed.transport);
    cleanup.push(() => allowed.client.close());
    expect((await allowed.client.listTools()).tools).toHaveLength(3);
  });

  it("only accepts POST", async () => {
    const { app } = await connect();
    const response = await app.inject({ method: "GET", url: "/mcp" });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });
});
