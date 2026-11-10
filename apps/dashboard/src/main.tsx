import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { CallsPage } from "@/pages/calls";
import { OverviewPage } from "@/pages/overview";
import { PlaygroundPage } from "@/pages/playground";
import { UsagePage } from "@/pages/usage";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A wrong key or a gateway without a database will not fix itself by retrying.
      retry: (count, error) =>
        !(error instanceof ApiError && [401, 503].includes(error.status)) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter basename="/ui">
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<OverviewPage />} />
              <Route path="calls" element={<CallsPage />} />
              <Route path="usage" element={<UsagePage />} />
              <Route path="playground" element={<PlaygroundPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
