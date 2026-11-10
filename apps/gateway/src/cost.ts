import type { Usage } from "./schema.ts";

/** List prices, ignoring free credits, so costs are comparable across providers. */
export interface Pricing {
  /** Price of one billing unit, for providers that report credits per call. */
  perCreditUsd?: number;
  /** Price of one request, for providers billed per call. */
  perRequestUsd?: number;
  /** Results covered by perRequestUsd; further results cost perExtraResultUsd each. */
  includedResults?: number;
  perExtraResultUsd?: number;
}

/** Estimated list-price cost of one successful call, or null when no price is known. */
export function estimateCost(
  pricing: Pricing | undefined,
  credits: number | undefined,
  requestedResults: number,
): number | null {
  if (!pricing) return null;
  if (credits !== undefined && pricing.perCreditUsd !== undefined) {
    return round(credits * pricing.perCreditUsd);
  }
  if (pricing.perRequestUsd === undefined) return null;
  const extra = Math.max(0, requestedResults - (pricing.includedResults ?? Infinity));
  return round(pricing.perRequestUsd + extra * (pricing.perExtraResultUsd ?? 0));
}

/** Fill in the estimate and say which cost figure a consumer should trust. */
export function withCost(
  reported: Pick<Usage, "credits" | "costUsd">,
  pricing: Pricing | undefined,
  requestedResults: number,
): Usage {
  const estimate = estimateCost(pricing, reported.credits, requestedResults);
  return {
    ...reported,
    ...(estimate === null ? {} : { estimatedCostUsd: estimate }),
    costSource:
      reported.costUsd !== undefined ? "reported" : estimate === null ? "unknown" : "estimated",
  };
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
