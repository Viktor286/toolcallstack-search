/** 842 ms, 1.24 s, 43.9 s */
export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value < 1) return "<1 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

/** $0.0050, $1.24; fractions of a cent keep four decimals so small calls do not read as free. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value === 0) return "$0";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** 1,284 / 12.9K / 4.2M */
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (Math.abs(value) < 10_000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return "–";
  const value = (part / whole) * 100;
  return `${value > 0 && value < 1 ? value.toFixed(1) : Math.round(value)}%`;
}

export function time(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
}

/** Label for a time bucket on a chart axis. */
export function bucketLabel(iso: string, bucket: "hour" | "day"): string {
  const date = new Date(iso);
  return bucket === "hour"
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The cost figure the gateway says to trust for a call. */
export function callCost(usage: { costUsd?: number; estimatedCostUsd?: number }): number | null {
  return usage.costUsd ?? usage.estimatedCostUsd ?? null;
}
