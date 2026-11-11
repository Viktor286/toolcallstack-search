/**
 * Why a search call failed. Kept free of dependencies so the dashboard can
 * import it without bundling the gateway's schema library.
 */
export const errorTypes = [
  "unknown_provider",
  "not_configured",
  "timeout",
  "network",
  "rate_limited",
  "throttled",
  "budget_exceeded",
  /** The provider rejected the gateway's API key for it (401, 403). */
  "auth_error",
  /** The provider's account is out of credits or over its plan (402, Tavily's 432 and 433). */
  "quota_exceeded",
  /** The provider rejected the request itself (400, 404, 422), usually because of `options`. */
  "upstream_invalid_request",
  "upstream_error",
  "bad_response",
] as const;

export type ErrorType = (typeof errorTypes)[number];

/**
 * Failures that happen before anything reaches the provider, or that the
 * caller caused, so they say nothing about the provider's health.
 */
export const NOT_THE_PROVIDER: readonly ErrorType[] = [
  "unknown_provider",
  "not_configured",
  "throttled",
  "budget_exceeded",
  "upstream_invalid_request",
];
