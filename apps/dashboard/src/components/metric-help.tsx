import { useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { METRIC_DOCS, type MetricId } from "@/lib/metric-docs";

/** Text with `backticked` spans set as code. */
function Prose({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="rounded-sm bg-muted px-1 font-mono text-[0.95em]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/**
 * A metric's label that explains, on hover, focus or tap, what the figure means
 * and how it is computed. The dotted underline marks it as explained.
 */
export function MetricHelp({ metric, children }: { metric: MetricId; children: ReactNode }) {
  const doc = METRIC_DOCS[metric];
  // Tooltips open on hover and focus only; a tap opens it too, for touch screens.
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-help text-left underline decoration-current/40 decoration-dotted underline-offset-[3px]"
          onClick={() => setOpen(true)}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        collisionPadding={12}
        // Popover colours instead of the default inverted ones, so it matches the cards in either
        // theme. The arrow is the only svg inside and takes the same fill.
        className="max-w-sm border bg-popover px-3 py-2.5 text-left text-pretty text-popover-foreground shadow-md [&_svg]:bg-popover [&_svg]:fill-popover"
      >
        <p className="font-semibold">{doc.title}</p>
        <p className="mt-1">
          <Prose text={doc.meaning} />
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {doc.logic.map((line) => (
            <li key={line}>
              <Prose text={line} />
            </li>
          ))}
        </ul>
        <p className="mt-2 border-t pt-1.5 font-mono text-[10px] text-muted-foreground">
          {doc.source}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
