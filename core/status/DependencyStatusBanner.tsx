"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { Button } from "@/core/ui/Button";

type PublicDependency = { id: string; name: string; status: string };
type PublicResponse = { feed?: { components?: PublicDependency[] } };

/** Reads the sanitized public feed; never displays probe errors or endpoints. */
export function DependencyStatusBanner() {
  const [degraded, setDegraded] = useState<PublicDependency[]>([]);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch("/api/dependencies", { cache: "no-store" });
      if (!response.ok) throw new Error("status unavailable");
      const data = await response.json() as PublicResponse;
      const components = data.feed?.components;
      if (!Array.isArray(components)) throw new Error("status unavailable");
      setDegraded(components.filter((component) => component.status !== "operational"));
    } catch {
      // A failed status request must not claim dependencies are healthy.
      setDegraded([{ id: "status", name: "Network services", status: "degraded" }]);
    } finally {
      setChecked(true);
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  if (!checked || degraded.length === 0) return null;
  const names = degraded.map(({ name }) => name).join(", ");

  return (
    <div className="mx-auto max-w-7xl px-4 pt-3 sm:px-6 lg:px-8">
      <StatusMessage
        type="warning"
        title="Some network services are degraded"
        description={
          <div className="space-y-3">
            <p>{names} may be slow or unavailable. Read-only tools may continue to work.</p>
            <Button type="button" onClick={() => void refresh()} disabled={checking}>
              {checking ? "Checking..." : "Check again"}
            </Button>
          </div>
        }
      />
    </div>
  );
}
