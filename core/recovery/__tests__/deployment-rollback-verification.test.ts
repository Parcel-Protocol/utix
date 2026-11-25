import { describe, expect, it } from "vitest";
import {
  verifyDeploymentRollback,
  retryDeploymentRollback,
  type ProtocolDataset,
  type RollbackTarget
} from "../rollback-verifier";
import { Keypair } from "@stellar/stellar-sdk";

const ALICE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x11)).publicKey();
const BOB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x22)).publicKey();

const TARGET: RollbackTarget = {
  targetVersion: "1.0.0",
  rolledBackFromVersion: "2.0.0",
  rollbackTimestamp: 1_700_000_000_000
};

function cleanDataset(): ProtocolDataset {
  return {
    events: [
      {
        id: "ev-1",
        name: "Conference 2026",
        organizerAddress: ALICE,
        capacity: 100,
        status: "active",
        protocolVersion: "1.0.0",
        createdAt: 1_700_000_000_000
      }
    ],
    tickets: [
      {
        id: "t-1",
        eventId: "ev-1",
        owner: BOB,
        tier: "general",
        status: "issued",
        protocolVersion: "1.0.0",
        issuedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000
      }
    ],
    transfers: [],
    redemptions: [],
    workerJobs: [],
    fraudRecords: []
  };
}

describe("Issue #406: Deployment Rollback Verification Checks", () => {
  describe("normal path", () => {
    it("successfully verifies clean post-rollback dataset", () => {
      const res = verifyDeploymentRollback(cleanDataset(), TARGET, {
        caller: { role: "maintainer", id: "admin-1" }
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const report = res.value;
      expect(report.passed).toBe(true);
      expect(report.isClean).toBe(true);
      expect(report.requiresManualRepair).toBe(false);
      expect(report.failedChecks).toBe(0);
      expect(report.manualRepairRecords).toHaveLength(0);
    });
  });

  describe("failure paths and violation detection", () => {
    it("flags active transfers and unconfirmed redemptions under rolled-back version", () => {
      const dataset: ProtocolDataset = {
        ...cleanDataset(),
        transfers: [
          {
            id: "xfer-bad-1",
            ticketId: "t-1",
            fromOwner: ALICE,
            toOwner: BOB,
            status: "pending",
            protocolVersion: "2.0.0", // rolled back
            initiatedAt: 1_700_000_000_000,
            expiresAt: 1_700_003_600_000
          }
        ],
        redemptions: [
          {
            id: "redemp-bad-1",
            ticketId: "t-1",
            eventId: "ev-1",
            redeemedBy: BOB,
            nonce: "nonce-1",
            protocolVersion: "2.0.0",
            redeemedAt: 1_700_000_000_000,
            isConfirmed: false
          }
        ]
      };

      const res = verifyDeploymentRollback(dataset, TARGET, {
        caller: { role: "maintainer" }
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const report = res.value;
      expect(report.passed).toBe(false);
      expect(report.isClean).toBe(false);
      expect(report.requiresManualRepair).toBe(true);
      expect(report.manualRepairRecords.length).toBeGreaterThanOrEqual(2);

      const transferRepair = report.manualRepairRecords.find((r) => r.recordId === "xfer-bad-1");
      expect(transferRepair).toBeDefined();
      expect(transferRepair?.severity).toBe("critical");

      const redempRepair = report.manualRepairRecords.find((r) => r.recordId === "redemp-bad-1");
      expect(redempRepair).toBeDefined();
      expect(redempRepair?.severity).toBe("critical");
    });

    it("rejects invalid target version parameters", () => {
      const invalidTarget: RollbackTarget = {
        targetVersion: "2.0.0",
        rolledBackFromVersion: "2.0.0", // identical version
        rollbackTimestamp: 1_700_000_000_000
      };

      const res = verifyDeploymentRollback(cleanDataset(), invalidTarget, {
        caller: { role: "maintainer" }
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("invalid_target_version");
    });
  });

  describe("authorization path", () => {
    it("denies verification when caller is not maintainer", () => {
      const res = verifyDeploymentRollback(cleanDataset(), TARGET, {
        caller: { role: "viewer", id: "user-1" }
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("unauthorized");
    });

    it("permits verification when caller is maintainer", () => {
      const res = verifyDeploymentRollback(cleanDataset(), TARGET, {
        caller: { role: "maintainer", id: "admin-sec" }
      });

      expect(res.ok).toBe(true);
    });
  });

  describe("retry path", () => {
    it("successfully retries transient failures", () => {
      let attempts = 0;
      const fn = () => {
        attempts += 1;
        if (attempts < 3) {
          return { ok: false as const, code: "invalid_target_version" as const };
        }
        return verifyDeploymentRollback(cleanDataset(), TARGET, {
          caller: { role: "maintainer" }
        });
      };

      const result = retryDeploymentRollback(fn, 3);
      expect(result.ok).toBe(true);
      expect(attempts).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("handles an empty dataset cleanly without errors", () => {
      const emptyDataset: ProtocolDataset = {
        events: [],
        tickets: [],
        transfers: [],
        redemptions: [],
        workerJobs: [],
        fraudRecords: []
      };

      const res = verifyDeploymentRollback(emptyDataset, TARGET, {
        caller: { role: "maintainer" }
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.passed).toBe(true);
        expect(res.value.isClean).toBe(true);
      }
    });

    it("detects redemptions processed under rolled-back protocol version", () => {
      const dataset: ProtocolDataset = {
        ...cleanDataset(),
        redemptions: [
          {
            id: "redemp-confirmed",
            ticketId: "t-1",
            eventId: "ev-1",
            redeemedBy: BOB,
            nonce: "nonce-confirmed",
            protocolVersion: "2.0.0", // TARGET.rolledBackFromVersion is "2.0.0"
            redeemedAt: 1_700_000_000_000,
            isConfirmed: true
          }
        ]
      };

      const res = verifyDeploymentRollback(dataset, TARGET, {
        caller: { role: "maintainer" }
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const check = res.value.checks.find((c) => c.name === "partially_processed_redemptions");
        expect(check?.passed).toBe(false);
      }
    });
  });
});
