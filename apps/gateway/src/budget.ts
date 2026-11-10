import type { Usage } from "./schema.ts";

export interface BudgetCaps {
  /** Successful (billed) calls. */
  calls?: number;
  /** Dollars: the reported cost of a call, or else its list-price estimate. */
  usd?: number;
  /** Credits as the provider reports them per call. */
  credits?: number;
}

export interface Budget {
  /** Per UTC day. */
  daily?: BudgetCaps;
  /** Per UTC calendar month. */
  monthly?: BudgetCaps;
  /** Stop when the provider's reported account balance is at or below this, in its own unit. */
  minRemaining?: number;
}

export type Spend = Required<BudgetCaps>;

const UNITS = ["calls", "usd", "credits"] as const;
const zero = (): Spend => ({ calls: 0, usd: 0, credits: 0 });

interface State {
  dayKey: string;
  monthKey: string;
  day: Spend;
  month: Spend;
  /** Requests sent but not yet answered; they count toward the call caps. */
  inFlight: number;
  remaining: number | null;
}

/**
 * Spend caps per provider, so a free tier or a prepaid balance cannot be
 * drained by accident. Spend is counted in memory per UTC day and month and
 * can be seeded from the call log, so a restart does not reset it. Dollar and
 * credit caps are only known once a call returns, so they can be overshot by
 * the calls in flight at that moment.
 */
export class BudgetTracker {
  readonly #budgets: Record<string, Budget | undefined>;
  readonly #states = new Map<string, State>();
  readonly #now: () => Date;

  constructor(budgets: Record<string, Budget | undefined>, now: () => Date = () => new Date()) {
    this.#budgets = budgets;
    this.#now = now;
  }

  #state(provider: string): State {
    const iso = this.#now().toISOString();
    const dayKey = iso.slice(0, 10);
    const monthKey = iso.slice(0, 7);
    let state = this.#states.get(provider);
    if (!state) {
      state = { dayKey, monthKey, day: zero(), month: zero(), inFlight: 0, remaining: null };
      this.#states.set(provider, state);
    }
    if (state.dayKey !== dayKey) {
      state.dayKey = dayKey;
      state.day = zero();
    }
    if (state.monthKey !== monthKey) {
      state.monthKey = monthKey;
      state.month = zero();
    }
    return state;
  }

  /** Start of the current UTC day and month, for seeding from the call log. */
  windows(): { dayStart: Date; monthStart: Date } {
    const now = this.#now();
    return {
      dayStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    };
  }

  /** Add spend recorded before this process started. */
  seed(provider: string, day: Spend, month: Spend): void {
    const state = this.#state(provider);
    for (const unit of UNITS) {
      state.day[unit] += day[unit];
      state.month[unit] += month[unit];
    }
  }

  setBalance(provider: string, remaining: number | null): void {
    this.#state(provider).remaining = remaining;
  }

  /** Why the provider may not be called right now, or null when it may. */
  blocked(provider: string): string | null {
    const budget = this.#budgets[provider];
    if (!budget) return null;
    const state = this.#state(provider);
    for (const [period, caps, spent] of [
      ["daily", budget.daily, state.day],
      ["monthly", budget.monthly, state.month],
    ] as const) {
      for (const unit of UNITS) {
        const cap = caps?.[unit];
        if (cap === undefined) continue;
        const used = unit === "calls" ? spent.calls + state.inFlight : spent[unit];
        if (used >= cap) {
          const reset = period === "daily" ? "00:00 UTC" : "the start of next month (UTC)";
          return `${period} budget for '${provider}' is used up (${round(spent[unit])} of ${cap} ${unit}); it resets at ${reset}`;
        }
      }
    }
    if (
      budget.minRemaining !== undefined &&
      state.remaining !== null &&
      state.remaining <= budget.minRemaining
    ) {
      return `account balance for '${provider}' (${round(state.remaining)}) is at or below the floor of ${budget.minRemaining}`;
    }
    return null;
  }

  /** Claim a slot for one upstream request; returns the reason when the budget forbids it. */
  reserve(provider: string): string | null {
    const reason = this.blocked(provider);
    if (reason === null) this.#state(provider).inFlight += 1;
    return reason;
  }

  /** Release a reserved slot, recording the spend when the request was answered with results. */
  settle(provider: string, usage: Usage | null): void {
    const state = this.#state(provider);
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (!usage) return;
    const spend = {
      calls: 1,
      usd: usage.costUsd ?? usage.estimatedCostUsd ?? 0,
      credits: usage.credits ?? 0,
    };
    for (const unit of UNITS) {
      state.day[unit] += spend[unit];
      state.month[unit] += spend[unit];
    }
  }

  /** Caps and current spend, or null when the provider has no budget. */
  snapshot(provider: string) {
    const budget = this.#budgets[provider];
    if (!budget) return null;
    const state = this.#state(provider);
    return {
      daily: period(budget.daily, state.day),
      monthly: period(budget.monthly, state.month),
      minRemaining: budget.minRemaining ?? null,
      remaining: state.remaining,
      blocked: this.blocked(provider),
    };
  }

  /** Spend of every provider that has been called or seeded, for metrics. */
  spent(): { provider: string; period: "daily" | "monthly"; spend: Spend }[] {
    return [...this.#states.keys()].flatMap((provider) => {
      const state = this.#state(provider);
      return [
        { provider, period: "daily" as const, spend: state.day },
        { provider, period: "monthly" as const, spend: state.month },
      ];
    });
  }
}

const period = (caps: BudgetCaps | undefined, spent: Spend) =>
  caps
    ? {
        caps,
        spent: { calls: spent.calls, usd: round(spent.usd), credits: round(spent.credits) },
      }
    : null;

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
