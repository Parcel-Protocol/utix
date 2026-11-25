import { describe, expect, it } from "vitest";
import path from "node:path";
import { runDiagnostics } from "../diagnostics";
import { DIAGNOSTICS_RUN_PERMISSION } from "../types";

const root = path.resolve(__dirname, "../../..");

describe("Contributor Diagnostics Command Gate (#460)", () => {
  const maintainer = {
    kind: "maintainer",
    id: "admin-actor",
    permissions: [DIAGNOSTICS_RUN_PERMISSION]
  };

  const unprivilegedContributor = {
    kind: "contributor",
    id: "guest-contrib",
    permissions: []
  };

  describe("Normal Path", () => {
    it("runs complete diagnostics report when actor is authorized", async () => {
      const report = await runDiagnostics({
        projectRoot: root,
        actor: maintainer
      });

      expect(report.authorization?.allowed).toBe(true);
      expect(report.checks.length).toBeGreaterThanOrEqual(5);
      expect(report.summary.total).toBeGreaterThanOrEqual(5);
      expect(["healthy", "degraded", "failing"]).toContain(report.overallStatus);
    });
  });

  describe("Failure Path", () => {
    it("fails early when strict mode is active and any warnings are detected", async () => {
      const report = await runDiagnostics({
        projectRoot: root,
        strict: true,
        actor: maintainer
      });

      if (report.summary.warnings > 0) {
        expect(report.overallStatus).toBe("failing");
      }
      expect(report.summary.total).toBeGreaterThanOrEqual(5);
    });
  });

  describe("Retry Path", () => {
    it("accepts configurable retry options for flaky environment checks", async () => {
      const report = await runDiagnostics({
        projectRoot: root,
        actor: maintainer,
        maxAttempts: 3,
        retryDelayMs: 20
      });

      expect(report.authorization?.allowed).toBe(true);
      expect(report.checks.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("Authorization Path", () => {
    it("returns unauthorized status when actor is completely missing", async () => {
      const report = await runDiagnostics({ projectRoot: root });
      expect(report.authorization?.allowed).toBe(false);
      expect(report.authorization?.reason).toBe("missing_actor");
      expect(report.checks).toHaveLength(0);
    });

    it("returns unauthorized status when actor lacks diagnostics:run permission", async () => {
      const report = await runDiagnostics({
        projectRoot: root,
        actor: unprivilegedContributor
      });

      expect(report.authorization?.allowed).toBe(false);
      expect(report.authorization?.reason).toBe("missing_permission");
      expect(report.checks).toHaveLength(0);
    });
  });
});
