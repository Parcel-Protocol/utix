import { describe, expect, it } from "vitest";
import path from "node:path";
import { runDiagnostics } from "../diagnostics";
import { DIAGNOSTICS_RUN_PERMISSION } from "../types";

const root = path.resolve(__dirname, "../../..");

describe("Diagnostics command authorization (#416)", () => {
  it("returns an authorization failure with no checks when actor is missing", async () => {
    const report = await runDiagnostics({ projectRoot: root });
    expect(report.authorization).toEqual({ allowed: false, reason: "missing_actor" });
    expect(report.checks).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it("returns an authorization failure when actor lacks the permission", async () => {
    const report = await runDiagnostics({
      projectRoot: root,
      actor: { kind: "contributor", id: "user-1", permissions: [] }
    });
    expect(report.authorization).toEqual({ allowed: false, reason: "missing_permission" });
    expect(report.checks).toEqual([]);
  });

  it("runs all checks when actor has the diagnostics:run permission", async () => {
    const report = await runDiagnostics({
      projectRoot: root,
      actor: { kind: "maintainer", id: "user-1", permissions: [DIAGNOSTICS_RUN_PERMISSION] }
    });
    expect(report.authorization).toEqual({ allowed: true });
    expect(report.checks.length).toBe(5);
    expect(report.summary.total).toBe(5);
    expect(["healthy", "degraded", "failing"]).toContain(report.overallStatus);
  });

  it("supports strict mode treating warnings as failures", async () => {
    const report = await runDiagnostics({
      projectRoot: root,
      strict: true,
      actor: { kind: "maintainer", id: "user-1", permissions: [DIAGNOSTICS_RUN_PERMISSION] }
    });
    // With strict mode, any warning makes the overall status "failing".
    if (report.summary.warnings > 0) {
      expect(report.overallStatus).toBe("failing");
    }
    expect(report.summary.total).toBe(5);
  });
});
