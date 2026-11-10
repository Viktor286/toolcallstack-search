import type { z } from "zod";
import type {
  BatchResponse,
  SearchResponse,
  StatsResponse,
  UsageResponse,
  callsResponseSchema,
  providerInfoSchema,
  statusResponseSchema,
} from "../../../gateway/src/schema.ts";

// Types come straight from the gateway's schemas, so the UI cannot drift from the API.
export type { BatchResponse, SearchResponse, StatsResponse, UsageResponse };
export type ProviderInfo = z.infer<typeof providerInfoSchema>;
export type Status = z.infer<typeof statusResponseSchema>;
export type CallsPage = z.infer<typeof callsResponseSchema>;
export type Phases = NonNullable<SearchResponse["timing"]["phases"]>;

const KEY_STORAGE = "toolcallstack-search.apiKey";

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private windows may refuse storage; the key then lasts for this page only.
  }
}

export class ApiError extends Error {
  status: number;
  type: string;
  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/**
 * Call the gateway. Search endpoints answer failures with a normal response
 * body (`ok: false`), so only responses without one become an ApiError.
 */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const key = getApiKey();
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (response.ok) return data as T;
  if (data && typeof data === "object" && "timing" in data) return data as T;
  const error = (data as { error?: { type?: string; message?: string } } | null)?.error;
  throw new ApiError(
    response.status,
    error?.type ?? "http_error",
    error?.message ?? `The gateway answered ${response.status}`,
  );
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
