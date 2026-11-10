export interface BarRow {
  id: string;
  label: string;
  value: number | null;
  /** The value as text, shown at the tip of the bar. */
  display: string;
  /** Extra text after the value, e.g. a second statistic. */
  note?: string;
}

/**
 * Horizontal bars comparing one measure across providers. One hue, because the
 * bars differ in magnitude, not in kind; the row label carries identity.
 */
export function BarList({ rows, label }: { rows: BarRow[]; label: string }) {
  const max = Math.max(...rows.map((row) => row.value ?? 0), 0);
  return (
    <ul className="space-y-2.5" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id} className="grid grid-cols-[5.5rem_1fr] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground">{row.label}</span>
          <span className="flex min-w-0 items-center gap-2">
            {row.value !== null && max > 0 && (
              <span
                className="h-3 shrink-0 rounded-r-[4px]"
                style={{
                  width: `${Math.max((row.value / max) * 55, 0.5)}%`,
                  background: "var(--magnitude)",
                }}
              />
            )}
            <span className="font-medium tabular-nums whitespace-nowrap">{row.display}</span>
            {row.note && (
              <span className="hidden truncate text-xs text-muted-foreground tabular-nums sm:inline">
                {row.note}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
