import {
  Activity,
  CircleDollarSign,
  Clock,
  Gauge,
  HeartPulse,
  Hourglass,
  Timer,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { MiniBars } from "@/components/charts/mini-bars";
import { MetricHelp } from "@/components/metric-help";
import { ProviderName } from "@/components/provider-name";
import { StatusLabel, type StatusKind } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProviderInfo, Status } from "@/lib/api";
import { hourLink } from "@/lib/call-filters";
import type { MetricId } from "@/lib/metric-docs";
import { ago, compact, ms, usd } from "@/lib/format";
import {
  LOW_DATA,
  balanceText,
  capReachedAt,
  isStale,
  meterLevel,
  runwayHours,
  runwayLabel,
  statusLabel,
  successLabel,
  type Balance,
  type ProviderActivity,
} from "@/lib/overview";
import { providerColor } from "@/lib/providers";

type Health = Status["providers"][number];
type Period = NonNullable<NonNullable<ProviderInfo["budget"]>["daily"]>;

const LEVEL_COLOR = {
  normal: "var(--magnitude)",
  warning: "var(--status-warning)",
  critical: "var(--status-critical)",
} as const;

export function Row({
  label,
  icon: Icon,
  help,
  children,
  muted = false,
}: {
  label: string;
  icon?: LucideIcon;
  /** Explains the figure on hover. */
  help?: MetricId;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {Icon && <Icon className="size-3.5 shrink-0 self-center" aria-hidden />}
        {help ? <MetricHelp metric={help}>{label}</MetricHelp> : label}
      </dt>
      <dd
        className={`min-w-0 truncate text-right tabular-nums ${muted ? "text-muted-foreground" : "font-medium"}`}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Spend against a cap; the track is a lighter step of the fill's own hue. The
 * fill turns amber from 80% and red at the cap, and a day's meter says when it
 * would fill at the pace so far.
 */
function BudgetMeter({
  title,
  period,
  now,
  forecast = false,
}: {
  title: string;
  period: Period;
  now: number;
  forecast?: boolean;
}) {
  const units = (["calls", "usd", "credits"] as const).filter(
    (unit) => period.caps[unit] !== undefined,
  );
  return (
    <>
      {units.map((unit) => {
        const cap = period.caps[unit] ?? 0;
        const spent = period.spent[unit];
        const show = (value: number) => (unit === "usd" ? usd(value) : compact(value));
        const reaches = forecast ? capReachedAt(spent, cap, now) : null;
        const label = `${title} ${unit === "usd" ? "spend" : unit}`;
        return (
          <div key={unit} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">
                <MetricHelp metric="budget">{title}</MetricHelp>
              </span>
              <span className="font-medium tabular-nums">
                {show(spent)} of {show(cap)}
                {unit === "usd" ? "" : ` ${unit}`}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={cap}
              aria-valuenow={Math.min(spent, cap)}
              className="mt-1 h-1.5 rounded-full"
              style={{ background: "var(--magnitude-track)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${cap > 0 ? Math.min(100, (spent / cap) * 100) : 100}%`,
                  background: LEVEL_COLOR[meterLevel(spent, cap)],
                }}
              />
            </div>
            {reaches && (
              <p className="mt-1 text-xs text-muted-foreground">
                At this pace the cap is reached around{" "}
                {reaches.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

function LastError({ provider, linked }: { provider: Health; linked: boolean }) {
  const [open, setOpen] = useState(false);
  const error = provider.lastError;
  if (!error || provider.status === "healthy") return null;
  const long = error.message.length > 140;
  return (
    <p className="pt-1 text-xs break-words text-muted-foreground">
      {linked ? (
        <Link
          className="underline underline-offset-2 hover:text-foreground"
          to={`/calls?provider=${provider.id}&ok=false`}
        >
          Last error
        </Link>
      ) : (
        "Last error"
      )}{" "}
      ({ago(error.at)}): {error.type}.{" "}
      {open || !long ? error.message : `${error.message.slice(0, 140)}…`}
      {long && (
        <>
          {" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setOpen(!open)}
          >
            {open ? "less" : "more"}
          </button>
        </>
      )}
    </p>
  );
}

interface Props {
  provider: Health;
  info?: ProviderInfo;
  balance?: Balance;
  /** Undefined while there is no call log to draw it from. */
  activity?: ProviderActivity;
  store: Status["store"];
  now: number;
}

export function ProviderCard({ provider, info, balance, activity, store, now }: Props) {
  const linked = store === "ok";
  const name = <ProviderName id={provider.id} label={info?.name ?? provider.id} />;
  const kind: StatusKind = provider.status;
  const text = balanceText(balance, info, store);
  const runway = balance ? runwayHours(balance) : null;
  const runwayNote = runway === null ? null : runwayLabel(runway);
  const stale = balance ? isStale(balance.latest.takenAt, now) : false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">
          {linked ? (
            <Link
              to={`/calls?provider=${provider.id}`}
              className="hover:underline underline-offset-4"
              title={`Show ${info?.name ?? provider.id} calls`}
            >
              {name}
            </Link>
          ) : (
            name
          )}
        </CardTitle>
        <MetricHelp metric="health">
          <StatusLabel kind={kind} label={statusLabel(provider)} />
        </MetricHelp>
      </CardHeader>
      <CardContent>
        {activity && (
          <div className="mb-3">
            <MiniBars
              buckets={activity.hourly}
              color={providerColor(provider.id)}
              label={`${info?.name ?? provider.id} calls per hour, last 24 hours`}
              hrefFor={(start) => hourLink(provider.id, start)}
            />
            <div className="mt-1 flex justify-between text-[11px] text-[var(--chart-muted)]">
              <span>24 h ago</span>
              <span>now</span>
            </div>
          </div>
        )}
        <dl className="space-y-1.5">
          <Row label="Median latency" icon={Timer} help="medianLatency">
            {ms(provider.medianLatencyMs)}
          </Row>
          {activity?.p95 != null && (
            <Row label="p95, worst hour" icon={Gauge} help="p95WorstHour">
              {ms(activity.p95)}
            </Row>
          )}
          <Row
            label="Success"
            icon={HeartPulse}
            help="success"
            muted={provider.recentCalls < LOW_DATA}
          >
            {successLabel(provider)}
          </Row>
          {activity && (
            <>
              <Row label="Calls, 24 h" icon={Activity} help="calls24h">
                {compact(activity.calls)}
                {activity.failures > 0 && ` · ${compact(activity.failures)} failed`}
              </Row>
              <Row label="Cost, 24 h" icon={CircleDollarSign} help="cost24h">
                {/* No calls cost nothing; "unknown" is for calls without a price. */}
                {usd(activity.calls === 0 ? 0 : activity.cost)}
              </Row>
            </>
          )}
          <Row label="Last success" icon={Clock} help="lastSuccess">
            {ago(provider.lastOkAt)}
          </Row>
          {provider.queueDepth > 0 && (
            <Row label="Queued now" icon={Hourglass} help="queuedNow">
              {provider.queueDepth}
            </Row>
          )}
          <Row label="Balance" icon={Wallet} help="balance" muted={!text.known}>
            {text.text}
          </Row>
          {balance && (runwayNote || stale) && (
            <p className="text-right text-xs text-muted-foreground">
              {runwayNote && `lasts ${runwayNote} at the recent pace`}
              {runwayNote && stale && " · "}
              {stale && (
                <span style={{ color: "var(--status-warning)" }}>
                  snapshot {ago(balance.latest.takenAt)}
                </span>
              )}
            </p>
          )}
          {info?.budget?.daily && (
            <BudgetMeter title="Today" period={info.budget.daily} now={now} forecast />
          )}
          {info?.budget?.monthly && (
            <BudgetMeter title="This month" period={info.budget.monthly} now={now} />
          )}
          {provider.budgetBlocked && (
            <p className="pt-1 text-xs text-muted-foreground">{provider.budgetBlocked}</p>
          )}
          <LastError provider={provider} linked={linked} />
        </dl>
      </CardContent>
    </Card>
  );
}
