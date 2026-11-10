import { useState } from "react";

export interface TimeSeries {
  id: string;
  label: string;
  color: string;
  /** One value per bucket, in bucket order. */
  values: number[];
}

interface Props {
  /** Bucket labels along the x axis, oldest first. */
  buckets: string[];
  series: TimeSeries[];
  format: (value: number) => string;
  /** Names what the bars count, for screen readers. */
  label: string;
}

/** Round up to 1, 2 or 5 times a power of ten, so axis ticks are clean numbers. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

/**
 * Stacked columns over time. Segments are separated by a 2px gap in the
 * surface colour rather than by strokes; hovering or focusing a column lists
 * every series in that bucket.
 */
export function StackedTimeBars({ buckets, series, format, label }: Props) {
  const [active, setActive] = useState<number | null>(null);
  const totals = buckets.map((_, index) =>
    series.reduce((sum, s) => sum + (s.values[index] ?? 0), 0),
  );
  const top = niceCeiling(Math.max(...totals, 0));
  const ticks = [0, top / 2, top];
  // Too many labels collide: show about seven, and only every other one of those on a phone.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 7));

  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="flex" role="img" aria-label={label}>
        <div className="relative w-10 shrink-0 text-right text-[11px] tabular-nums text-[var(--chart-muted)]">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-2 translate-y-1/2"
              // The plot is 200px tall and sits above a 24px row of bucket labels.
              style={{ bottom: `${24 + (tick / top) * 200}px` }}
            >
              {format(tick)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="relative h-[200px]">
            {ticks.map((tick) => (
              <div
                key={tick}
                className="absolute inset-x-0 h-px"
                style={{
                  bottom: `${(tick / top) * 100}%`,
                  background: tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)",
                }}
              />
            ))}
            <div className="absolute inset-0 flex items-end">
              {buckets.map((bucket, index) => (
                <button
                  key={bucket + index}
                  type="button"
                  className="group flex h-full min-w-0 flex-1 cursor-default items-end justify-center outline-none"
                  aria-label={`${bucket}: ${series.map((s) => `${s.label} ${format(s.values[index] ?? 0)}`).join(", ")}`}
                  onPointerEnter={() => setActive(index)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                >
                  <span
                    className="flex w-full max-w-6 flex-col-reverse gap-[2px] opacity-100 transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80"
                    style={{ height: `${((totals[index] ?? 0) / top) * 100}%` }}
                  >
                    {series
                      .filter((s) => (s.values[index] ?? 0) > 0)
                      .map((s, position, shown) => (
                        <span
                          key={s.id}
                          className="w-full"
                          style={{
                            background: s.color,
                            flexGrow: s.values[index],
                            flexBasis: 0,
                            minHeight: 2,
                            // Only the data end is rounded; the baseline stays square.
                            borderRadius: position === shown.length - 1 ? "4px 4px 0 0" : 0,
                          }}
                        />
                      ))}
                  </span>
                </button>
              ))}
            </div>
            {active !== null && (
              <div
                className="pointer-events-none absolute top-0 z-10 w-max max-w-56 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
                style={
                  active < buckets.length / 2
                    ? { left: `calc(${((active + 1) / buckets.length) * 100}% + 4px)` }
                    : {
                        right: `calc(${((buckets.length - active) / buckets.length) * 100}% + 4px)`,
                      }
                }
              >
                <div className="mb-1 text-muted-foreground">{buckets[active]}</div>
                {series
                  .filter((s) => (s.values[active] ?? 0) > 0)
                  .map((s) => (
                    <div key={s.id} className="flex items-center gap-2">
                      <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                      <span className="font-semibold tabular-nums text-foreground">
                        {format(s.values[active] ?? 0)}
                      </span>
                      <span className="text-muted-foreground">{s.label}</span>
                    </div>
                  ))}
                {(totals[active] ?? 0) === 0 && (
                  <div className="text-muted-foreground">No calls</div>
                )}
              </div>
            )}
          </div>
          <div className="flex h-6 items-end text-[11px] text-[var(--chart-muted)]">
            {buckets.map((bucket, index) => (
              <span
                key={bucket + index}
                className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap"
              >
                {index % labelEvery === 0 && (
                  <span className={index % (labelEvery * 2) === 0 ? "" : "hidden sm:inline"}>
                    {bucket}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
