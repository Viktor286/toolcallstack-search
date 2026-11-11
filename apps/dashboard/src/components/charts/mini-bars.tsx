import { bucketLabel } from "@/lib/format";

interface Props {
  /** One entry per bucket, oldest first. */
  buckets: { start: string; calls: number; failures: number }[];
  color: string;
  /** Names what the bars show, for screen readers. */
  label: string;
}

/**
 * Calls per hour as small columns, with the failed share stacked in the
 * failure colour. It shows the shape of a day, not exact values: each column
 * carries its numbers as a tooltip.
 */
export function MiniBars({ buckets, color, label }: Props) {
  const top = Math.max(...buckets.map((bucket) => bucket.calls), 1);
  const calls = buckets.reduce((sum, bucket) => sum + bucket.calls, 0);
  const failures = buckets.reduce((sum, bucket) => sum + bucket.failures, 0);
  return (
    <div
      role="img"
      aria-label={`${label}: ${calls} calls, ${failures} failed`}
      className="flex h-10 items-end gap-px border-b border-[var(--chart-axis)]"
    >
      {buckets.map((bucket) => (
        <span
          key={bucket.start}
          title={`${bucketLabel(bucket.start, "hour")}: ${bucket.calls} calls${bucket.failures > 0 ? `, ${bucket.failures} failed` : ""}`}
          className="flex h-full min-w-0 flex-1 flex-col-reverse"
        >
          {bucket.calls > 0 && (
            <span
              className="flex flex-col"
              style={{ height: `${Math.max((bucket.calls / top) * 100, 8)}%` }}
            >
              {bucket.failures > 0 && (
                <span
                  className="rounded-t-[2px]"
                  style={{
                    background: "var(--status-critical)",
                    flexGrow: bucket.failures,
                    flexBasis: 0,
                    minHeight: 2,
                  }}
                />
              )}
              <span
                className={bucket.failures > 0 ? "" : "rounded-t-[2px]"}
                style={{
                  background: color,
                  flexGrow: bucket.calls - bucket.failures,
                  flexBasis: 0,
                }}
              />
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
