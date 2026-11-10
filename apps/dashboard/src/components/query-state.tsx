import { ApiKeyForm } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";

/** What to show instead of a page's content when its data could not be loaded. */
export function QueryError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 401) {
    return (
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>This gateway needs an API key</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiKeyForm />
        </CardContent>
      </Card>
    );
  }
  if (error instanceof ApiError && error.type === "store_unavailable") {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>No call log</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The gateway is running without a database, so it keeps no history. Set{" "}
          <code className="text-foreground">DATABASE_URL</code> on the gateway and restart it to see
          calls, usage and cost here.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Could not reach the gateway</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "Unknown error"}. Check that the gateway is
        running, then reload.
      </CardContent>
    </Card>
  );
}

export function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
