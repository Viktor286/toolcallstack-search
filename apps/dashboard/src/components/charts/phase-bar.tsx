import { MetricHelp } from "@/components/metric-help";
import { ms } from "@/lib/format";
import type { MetricId } from "@/lib/metric-docs";

interface Stage {
  name: string;
  value: number | null;
  color: string;
  help: MetricId;
}

interface Props {
  queuedMs: number;
  phases: {
    dnsMs: number | null;
    connectMs: number | null;
    tlsMs: number | null;
    ttfbMs: number;
    downloadMs: number;
    connectionReused: boolean;
  } | null;
}

/**
 * Where one upstream request spent its time, as consecutive stages. The bar
 * shows proportions; the list under it gives every value, so nothing depends
 * on reading a thin segment.
 */
export function PhaseBar({ queuedMs, phases }: Props) {
  const stages: Stage[] = [
    {
      name: "Queue",
      value: queuedMs,
      color: "var(--phase-queue)",
      help: "phaseQueue",
    },
    { name: "DNS", value: phases?.dnsMs ?? null, color: "var(--phase-1)", help: "phaseDns" },
    {
      name: "Connect",
      value: phases?.connectMs ?? null,
      color: "var(--phase-2)",
      help: "phaseConnect",
    },
    { name: "TLS", value: phases?.tlsMs ?? null, color: "var(--phase-3)", help: "phaseTls" },
    {
      name: "First byte",
      value: phases?.ttfbMs ?? null,
      color: "var(--phase-4)",
      help: "phaseTtfb",
    },
    {
      name: "Download",
      value: phases?.downloadMs ?? null,
      color: "var(--phase-5)",
      help: "phaseDownload",
    },
  ];
  const total = stages.reduce((sum, stage) => sum + (stage.value ?? 0), 0);
  const shown = stages.filter((stage) => (stage.value ?? 0) > 0);

  return (
    <div>
      {total > 0 && (
        <div className="flex h-3 gap-[2px]" role="img" aria-label="Time per stage">
          {shown.map((stage, index) => (
            <span
              key={stage.name}
              title={`${stage.name}: ${ms(stage.value)}`}
              style={{
                background: stage.color,
                flexGrow: stage.value ?? 0,
                flexBasis: 0,
                minWidth: 2,
                borderRadius: index === shown.length - 1 ? "0 4px 4px 0" : 0,
              }}
            />
          ))}
        </div>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        {stages.map((stage) => (
          <div key={stage.name} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: stage.color }} />
            <dt className="text-muted-foreground">
              <MetricHelp metric={stage.help}>{stage.name}</MetricHelp>
            </dt>
            <dd className="ml-auto font-medium tabular-nums">
              {stage.value === null ? (phases?.connectionReused ? "reused" : "–") : ms(stage.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
