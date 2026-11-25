import { describe, expect, it } from "vitest";
import {
  MigrationReleaseReadinessVerifier,
  verifyMigrationReleaseGate,
  type MigrationReleaseConfig,
  type ReadinessActor,
  type ReadinessProbe
} from "../release-readiness";
import type { MigrationDefinition } from "../types";

interface SchemaRecord {
  id: string;
  name: string;
  schemaVersion: number;
}

describe("Release Gate for Migrations and Recovery Evidence (#462)", () => {
  const maintainerActor: ReadinessActor = {
    role: "maintainer",
    userId: "user_rel_gate_maint"
  };

  const guestActor: ReadinessActor = {
    role: "guest",
    userId: "guest_visitor"
  };

  const mockMigration: MigrationDefinition<SchemaRecord, SchemaRecord> = {
    id: "20261122_release_gate_v5",
    name: "Partition rollback journal tables",
    description: "Splits monolithic journal into partition tables",
    fromVersion: 4,
    toVersion: 5,
    riskLevel: "medium",
    rollbackNotes: "Revert partition schema using snapshot snap_v4_state; restore indices",
    forwardFixNotes: "Run patch 20261122_patch_journals to repair any orphaned records",
    dryRun: (records) => ({
      migrationId: "20261122_release_gate_v5",
      targetVersion: 5,
      totalRecords: records.length,
      affectedCount: records.length,
      unchangedCount: 0,
      sampleDiffs: [],
      riskLevel: "medium",
      rollbackNotes: "Revert partition schema using snapshot",
      forwardFixNotes: "Run patch 20261122_patch_journals",
      estimatedDurationMs: 150
    }),
    apply: async (records) => records.map((r) => ({ ...r, schemaVersion: 5 }))
  };

  describe("Normal Path", () => {
    it("approves fully compliant migration release plan and produces recovery evidence", async () => {
      const config: MigrationReleaseConfig<SchemaRecord, SchemaRecord> = {
        releaseId: "rel_20261122_gate_v5",
        targetVersion: 5,
        migrations: [mockMigration],
        snapshotId: "snap_v4_state",
        snapshotData: { journalCount: 12000, checksum: "abc123state" }
      };

      const report = await verifyMigrationReleaseGate(config, maintainerActor);

      expect(report.ready).toBe(true);
      expect(report.status).toBe("APPROVED");
      expect(report.discrepancies).toBeUndefined();
      expect(report.rollbackEvidence).toHaveLength(1);

      const evidence = report.rollbackEvidence[0];
      expect(evidence.migrationId).toBe("20261122_release_gate_v5");
      expect(evidence.rollbackScriptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.snapshotChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.fromVersion).toBe(4);
      expect(evidence.toVersion).toBe(5);
    });
  });

  describe("Failure Paths", () => {
    it("rejects migration plan with missing rollback procedure notes", async () => {
      const incompleteMigration: MigrationDefinition<SchemaRecord, SchemaRecord> = {
        ...mockMigration,
        id: "20261122_missing_rollback",
        rollbackNotes: "" // Missing
      };

      const config: MigrationReleaseConfig<SchemaRecord, SchemaRecord> = {
        releaseId: "rel_missing_rollback",
        targetVersion: 5,
        migrations: [incompleteMigration]
      };

      const report = await verifyMigrationReleaseGate(config, maintainerActor);

      expect(report.ready).toBe(false);
      expect(report.status).toBe("REJECTED");
      expect(report.discrepancies?.some((d) => d.includes("rollback procedure"))).toBe(true);
    });

    it("rejects critical risk migration without explicit allowCriticalRisk flag", async () => {
      const criticalMigration: MigrationDefinition<SchemaRecord, SchemaRecord> = {
        ...mockMigration,
        id: "20261122_critical_migration",
        riskLevel: "critical"
      };

      const config: MigrationReleaseConfig<SchemaRecord, SchemaRecord> = {
        releaseId: "rel_critical_blocked",
        targetVersion: 5,
        migrations: [criticalMigration],
        allowCriticalRisk: false
      };

      const report = await verifyMigrationReleaseGate(config, maintainerActor);

      expect(report.ready).toBe(false);
      expect(report.status).toBe("REJECTED");
      expect(report.discrepancies?.some((d) => d.includes("Critical risk"))).toBe(true);
    });
  });

  describe("Retry Path", () => {
    it("retries transient probe failures and approves when probe passes within retry budget", async () => {
      let attempts = 0;
      const transientProbe: ReadinessProbe = {
        name: "storage_health_probe",
        check: () => {
          attempts++;
          return attempts >= 2;
        },
        retryable: true
      };

      const config: MigrationReleaseConfig<SchemaRecord, SchemaRecord> = {
        releaseId: "rel_probe_retry",
        targetVersion: 5,
        migrations: [mockMigration],
        probes: [transientProbe],
        maxRetries: 3,
        initialBackoffMs: 5
      };

      const report = await verifyMigrationReleaseGate(config, maintainerActor);

      expect(report.ready).toBe(true);
      expect(report.status).toBe("APPROVED");
      expect(attempts).toBe(2);
    });
  });

  describe("Authorization Path", () => {
    it("denies release gate evaluation for unauthorized actors", async () => {
      const config: MigrationReleaseConfig<SchemaRecord, SchemaRecord> = {
        releaseId: "rel_unauth_attempt",
        targetVersion: 5,
        migrations: [mockMigration]
      };

      const report = await verifyMigrationReleaseGate(config, guestActor);

      expect(report.ready).toBe(false);
      expect(report.status).toBe("UNAUTHORIZED");
      expect(report.discrepancies?.some((d) => d.includes("Unauthorized"))).toBe(true);
      expect(report.rollbackEvidence).toHaveLength(0);
    });
  });
});
