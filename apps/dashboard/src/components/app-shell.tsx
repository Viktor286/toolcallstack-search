import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Moon, Sun } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiKey, setApiKey } from "@/lib/api";

const PAGES = [
  { to: "/", label: "Overview" },
  { to: "/calls", label: "Calls" },
  { to: "/usage", label: "Usage" },
  { to: "/playground", label: "Playground" },
];

function useTheme() {
  const [dark, setDark] = useState(() => {
    // `?theme=light` or `?theme=dark` wins, so a link can pin the look.
    const asked = new URLSearchParams(window.location.search).get("theme");
    if (asked === "light" || asked === "dark") return asked === "dark";
    try {
      const saved = localStorage.getItem("toolcallstack-search.theme");
      if (saved) return saved === "dark";
    } catch {
      // Fall through to the system preference.
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return {
    dark,
    toggle: () => {
      setDark((value) => {
        try {
          localStorage.setItem("toolcallstack-search.theme", value ? "light" : "dark");
        } catch {
          // The choice then lasts for this page only.
        }
        return !value;
      });
    },
  };
}

/** Asks for the gateway API key; shown on demand and whenever the gateway answers 401. */
export function ApiKeyForm({ onSaved }: { onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(getApiKey);
  const save = (event: FormEvent) => {
    event.preventDefault();
    setApiKey(value.trim());
    void queryClient.invalidateQueries();
    onSaved?.();
  };
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2">
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Label htmlFor="api-key">Gateway API key</Label>
        <Input
          id="api-key"
          type="password"
          autoComplete="off"
          placeholder="Leave empty if the gateway needs none"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <Button type="submit">Save</Button>
    </form>
  );
}

export function AppShell() {
  const theme = useTheme();
  const [keyOpen, setKeyOpen] = useState(false);
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold tracking-tight">toolcallstack-search</span>
          <nav className="order-last flex w-full flex-wrap gap-1 text-sm sm:order-none sm:w-auto sm:flex-1">
            {PAGES.map((page) => (
              <NavLink
                key={page.to}
                to={page.to}
                end={page.to === "/"}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 transition-colors ${
                    isActive
                      ? "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`
                }
              >
                {page.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Set the gateway API key"
              aria-expanded={keyOpen}
              onClick={() => setKeyOpen((open) => !open)}
            >
              <KeyRound />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={theme.dark ? "Switch to light theme" : "Switch to dark theme"}
              onClick={theme.toggle}
            >
              {theme.dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
        {keyOpen && (
          <div className="mx-auto max-w-6xl px-4 pb-4">
            <div className="max-w-md">
              <ApiKeyForm onSaved={() => setKeyOpen(false)} />
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
