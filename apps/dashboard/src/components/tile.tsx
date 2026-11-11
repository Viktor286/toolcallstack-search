import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/** A headline figure: a large icon in the left column, label, value and note in the right. */
export function Tile({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note?: string;
  icon?: LucideIcon;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4">
        {Icon && (
          <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-7" aria-hidden />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="mt-0.5 text-2xl leading-tight font-semibold">{value}</div>
          {note && <div className="mt-0.5 text-xs text-muted-foreground">{note}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
