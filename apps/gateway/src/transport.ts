import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

export interface TransportRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Covers the whole exchange, from opening the connection to the last body byte. */
  timeoutMs: number;
}

/**
 * Where the time of one upstream request went. The phases follow each other
 * without gaps, so they add up to the request's latency. Connection phases are
 * null when a kept-alive connection was reused.
 */
export interface Phases {
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  /** From the connection being ready (request written) to the response headers arriving. */
  ttfbMs: number;
  /** From the response headers to the last byte of the body. */
  downloadMs: number;
  connectionReused: boolean;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  phases: Phases;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

function decoded(response: http.IncomingMessage): Readable {
  switch (response.headers["content-encoding"]) {
    case "gzip":
      return response.pipe(zlib.createGunzip());
    case "br":
      return response.pipe(zlib.createBrotliDecompress());
    case "deflate":
      return response.pipe(zlib.createInflate());
    default:
      return response;
  }
}

/**
 * HTTP client on node:http(s) rather than fetch, because socket events are the
 * only way to time DNS, connect, TLS and first byte separately.
 */
export function createTransport(): Transport {
  const agents = {
    "http:": new http.Agent({ keepAlive: true }),
    "https:": new https.Agent({ keepAlive: true }),
  };

  return (request) =>
    new Promise((resolve, reject) => {
      const url = new URL(request.url);
      const secure = url.protocol === "https:";
      const started = performance.now();
      let dnsAt: number | null = null;
      let connectAt: number | null = null;
      let tlsAt: number | null = null;
      let reused = false;
      let settled = false;

      const outgoing = (secure ? https : http).request(url, {
        method: request.method,
        agent: agents[secure ? "https:" : "http:"],
        headers: {
          "accept-encoding": "gzip, br",
          ...request.headers,
          ...(request.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(request.body)) }),
        },
      });

      const timer = setTimeout(() => {
        const error = new Error(`no response within ${request.timeoutMs} ms`);
        error.name = "TimeoutError";
        outgoing.destroy(error);
      }, request.timeoutMs);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      outgoing.on("socket", (socket) => {
        reused = outgoing.reusedSocket;
        if (reused) return;
        socket.once("lookup", () => (dnsAt = performance.now()));
        socket.once("connect", () => (connectAt = performance.now()));
        socket.once("secureConnect", () => (tlsAt = performance.now()));
      });
      outgoing.on("error", fail);
      outgoing.on("response", (response) => {
        const headersAt = performance.now();
        const chunks: Buffer[] = [];
        const body = decoded(response);
        response.on("aborted", () => fail(new Error("connection closed before the body ended")));
        body.on("error", fail);
        body.on("data", (chunk: Buffer) => chunks.push(chunk));
        body.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const ready = tlsAt ?? connectAt ?? started;
          resolve({
            status: response.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(", ") : (value ?? ""),
              ]),
            ),
            text: Buffer.concat(chunks).toString("utf8"),
            phases: {
              dnsMs: dnsAt === null ? null : dnsAt - started,
              connectMs: connectAt === null ? null : connectAt - (dnsAt ?? started),
              tlsMs: tlsAt === null || connectAt === null ? null : tlsAt - connectAt,
              ttfbMs: headersAt - ready,
              downloadMs: performance.now() - headersAt,
              connectionReused: reused,
            },
          });
        });
      });
      outgoing.end(request.body);
    });
}
