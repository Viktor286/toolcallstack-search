import { CircleAlert, CircleCheck, CircleHelp, CircleMinus, CircleX } from "lucide-react";

const STATES = {
  healthy: { icon: CircleCheck, color: "var(--status-good)", label: "Healthy" },
  ok: { icon: CircleCheck, color: "var(--status-good)", label: "OK" },
  degraded: { icon: CircleAlert, color: "var(--status-warning)", label: "Degraded" },
  down: { icon: CircleX, color: "var(--status-critical)", label: "Down" },
  failed: { icon: CircleX, color: "var(--status-critical)", label: "Failed" },
  unknown: { icon: CircleHelp, color: "var(--chart-muted)", label: "No calls yet" },
  off: { icon: CircleMinus, color: "var(--chart-muted)", label: "Not configured" },
} as const;

export type StatusKind = keyof typeof STATES;

/** A state shown as icon plus words; the colour is on the icon only and never the sole signal. */
export function StatusLabel({ kind, label }: { kind: StatusKind; label?: string }) {
  const state = STATES[kind];
  const Icon = state.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <Icon className="size-4 shrink-0" style={{ color: state.color }} aria-hidden />
      {label ?? state.label}
    </span>
  );
}
