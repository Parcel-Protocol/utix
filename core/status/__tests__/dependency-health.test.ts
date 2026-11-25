import { describe, expect, it } from "vitest";
import { buildDependencyPublicStatus, parseDependencySignals } from "../dependency-health";

describe("dependency-aware public status", () => {
  it("fails visibly when probes are absent or invalid", () => {
    const response = buildDependencyPublicStatus({}, Date.UTC(2026, 10, 1), parseDependencySignals({ horizon: "excellent", soroban_rpc: null }));
    expect(response.status).toBe(200);
    if (!("feed" in response.body)) throw Error("missing status feed");
    expect(response.body.feed.status).toBe("degraded");
    expect(response.body.feed.components.every((item) => item.status === "degraded")).toBe(true);
  });

  it("marks a critical dependency outage without leaking private diagnostics", () => {
    const state = parseDependencySignals({ horizon: "down", soroban_rpc: "healthy", secretToken: "do-not-publish", horizonUrl: "private.internal" });
    const response = buildDependencyPublicStatus({}, Date.UTC(2026, 10, 1), state);
    if (!("feed" in response.body)) throw Error("missing status feed");
    expect(response.body.feed.status).toBe("major_outage");
    expect(response.body.feed.components).toEqual(expect.arrayContaining([
      { id: "horizon", name: "Horizon API", status: "major_outage" },
      { id: "soroban_rpc", name: "Soroban RPC", status: "operational" }
    ]));
    expect(JSON.stringify(response.body)).not.toContain("do-not-publish");
    expect(JSON.stringify(response.body)).not.toContain("private.internal");
  });

  it("preserves an operator maintenance notice with dependency signals", () => {
    const now = Date.UTC(2026, 10, 1);
    const response = buildDependencyPublicStatus({ UTIX_SERVICE_MODE: "maintenance" }, now, { horizon: "healthy", soroban_rpc: "healthy" });
    if (!("notice" in response.body)) throw Error("missing notice");
    expect(response.body.notice).toBeDefined();
  });
});
