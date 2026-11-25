/**
 * Deployment Rollback Verification Checks — extended coverage (#450)
 *
 * Covers the normal, failure, retry, and authorization paths for the
 * post-deployment rollback verification suite.  Every check is read-only
 * by design; this file verifies that guarantee holds regardless of input.
 *
 * Run individually:
 *   npm test -- core/recovery/__tests__/rollback-verification-checks
 */

import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  formatRollbackReport,
  verifyEventCapacityAndIssuanceInvariants,
  verifyExternalReferencesAndFraudControls,
  verifyPartiallyProcessedRedemptions,
  verifyPendingOperationsAndInFlightTransfers,
  verifyProtocolVersionCompatibility,
  verifyReleaseRollback,
  verifyWorkerJobPayloadCompatibility,
  type ProtocolDataset,
  type RollbackTarget,
} from "../rollback-verifier";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const KEY_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10)).publicKey();
const KEY_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 20)).publicKey();
const KEY_C = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 30)).publicKey();

const VALID_TX_HASH = "deadbeef00112233deadbeef00112233deadbeef00112233deadbeef00112233";

const DEFAULT_TARGET: RollbackTarget = {
  targetVersion: "2.0.0",
  rolledBackFromVersion: "2.1.0",
  rollbackTimestamp: 1_700_000_000_000,
};

function emptyDataset(): ProtocolDataset {
  return {
    events: [],
    tickets: [],
    transfers: [],
    redemptions: [],
    workerJobs: [],
    fraudRecords: [],
  };
}

function minimalCleanDataset(): ProtocolDataset {
  return {
    events: [
      {
        id: "evt-1",
        name: "Summit",
        organizerAddress: KEY_A,
        capacity: 100,
        status: "active",
        protocolVersion: "2.0.0",
        createdAt: 1_699_000_000_000,
      },
    ],
    tickets: [
      {
        id: "tkt-1",
        eventId: "evt-1",
        owner: KEY_A,
        tier: "general",
        status: "issued",
        protocolVersion: "2.0.0",
        externalRef: VALID_TX_HASH,
        issuedAt: 1_699_000_010_000,
        updatedAt: 1_699_000_010_000,
      },
    ],
    transfers: [
      {
        id: "xfer-1",
        ticketId: "tkt-1",
        fromOwner: KEY_A,
        toOwner: KEY_B,
        status: "accepted",
        protocolVersion: "2.0.0",
        initiatedAt: 1_699_000_020_000,
        expiresAt: 1_699_003_620_000,
        settledAt: 1_699_000_030_000,
      },
    ],
    redemptions: [
      {
        id: "rdm-1",
        ticketId: "tkt-1",
        eventId: "evt-1",
        redeemedBy: KEY_A,
        nonce: "nonce-safe-abc",
        protocolVersion: "2.0.0",
        redeemedAt: 1_699_000_050_000,
        isConfirmed: true,
      },
    ],
    workerJobs: [
      {
        id: "job-1",
        jobType: "ticket_notification",
        status: "succeeded",
        payloadVersion: "2.0.0",
        payload: { ticketId: "tkt-1" },
        createdAt: 1_699_000_010_000,
        updatedAt: 1_699_000_015_000,
      },
    ],
    fraudRecords: [
      {
        id: "fraud-1",
        account: KEY_C,
        ruleId: "freq_transfer",
        protocolVersion: "2.0.0",
        flaggedAt: 1_699_000_040_000,
        isManualReviewPending: false,
      },
    ],
  };
}

// ─── Normal path ──────────────────────────────────────────────────────────────

describe("#450 — deployment rollback verification checks", () => {
  describe("normal path", () => {
    it("passes all checks on a clean dataset with no rolled-back records", () => {
      const report = verifyReleaseRollback(minimalCleanDataset(), DEFAULT_TARGET);

      expect(report.isClean).toBe(true);
      expect(report.passed).toBe(true);
      expect(report.requiresManualRepair).toBe(false);
      expect(report.readOnly).toBe(true);
      expect(report.totalChecks).toBe(6);
      expect(report.passedChecks).toBe(6);
      expect(report.failedChecks).toBe(0);
      expect(report.manualRepairRecords).toHaveLength(0);
    });

    it("passes on an empty dataset with no records to inspect", () => {
      const report = verifyReleaseRollback(emptyDataset(), DEFAULT_TARGET);

      expect(report.isClean).toBe(true);
      expect(report.passed).toBe(true);
      expect(report.requiresManualRepair).toBe(false);
    });

    it("honours the custom `now` clock option and treats fresh transfers as non-stale", () => {
      const freshTransferDataset: ProtocolDataset = {
        ...emptyDataset(),
        transfers: [
          {
            id: "xfer-fresh",
            ticketId: "tkt-fresh",
            fromOwner: KEY_A,
            toOwner: KEY_B,
            status: "pending",
            protocolVersion: "2.0.0", // target version — not rolled-back
            initiatedAt: 1_700_000_000_000,
            expiresAt: 1_700_086_400_000,
          },
        ],
      };

      // With `now` = initiatedAt + 1 hour, the transfer is 1 h old — well within the 24 h window
      const report = verifyReleaseRollback(freshTransferDataset, DEFAULT_TARGET, {
        now: () => new Date(1_700_000_000_000 + 3_600_000),
      });

      expect(report.isClean).toBe(true);
    });

    it("produces a human-readable report with all expected sections", () => {
      const report = verifyReleaseRollback(minimalCleanDataset(), DEFAULT_TARGET);
      const formatted = formatRollbackReport(report);

      expect(formatted).toContain("POST-RELEASE ROLLBACK VERIFICATION REPORT");
      expect(formatted).toContain("CLEAN ROLLBACK [PASS]");
      expect(formatted).toContain("READ-ONLY");
      expect(formatted).toContain("2.0.0");
      expect(formatted).toContain("2.1.0");
    });

    it("verifyProtocolVersionCompatibility passes with no rolled-back tickets", () => {
      const { check, repairs } = verifyProtocolVersionCompatibility(minimalCleanDataset(), DEFAULT_TARGET);
      expect(check.passed).toBe(true);
      expect(repairs).toHaveLength(0);
    });

    it("verifyEventCapacityAndIssuanceInvariants passes with valid dataset", () => {
      const { check, repairs } = verifyEventCapacityAndIssuanceInvariants(minimalCleanDataset());
      expect(check.passed).toBe(true);
      expect(repairs).toHaveLength(0);
    });

    it("verifyWorkerJobPayloadCompatibility passes for succeeded and dead-lettered jobs", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        workerJobs: [
          {
            id: "job-done",
            jobType: "sync",
            status: "succeeded",
            payloadVersion: "2.1.0", // rolled-back version — but job is done
            payload: {},
            createdAt: 1_699_000_000_000,
            updatedAt: 1_699_000_010_000,
          },
          {
            id: "job-dl",
            jobType: "sync",
            status: "dead_lettered",
            payloadVersion: "2.1.0",
            payload: {},
            createdAt: 1_699_000_000_000,
            updatedAt: 1_699_000_020_000,
          },
        ],
      };

      const { check } = verifyWorkerJobPayloadCompatibility(dataset, DEFAULT_TARGET);
      expect(check.passed).toBe(true);
    });
  });

  // ─── Failure path ───────────────────────────────────────────────────────────

  describe("failure path", () => {
    it("detects tickets issued under the rolled-back protocol version", () => {
      const dataset: ProtocolDataset = {
        ...minimalCleanDataset(),
        tickets: [
          {
            id: "tkt-rolled-back",
            eventId: "evt-1",
            owner: KEY_A,
            tier: "vip",
            status: "issued",
            protocolVersion: "2.1.0", // rolled-back version
            issuedAt: 1_699_000_010_000,
            updatedAt: 1_699_000_010_000,
          },
        ],
      };

      const { check, repairs } = verifyProtocolVersionCompatibility(dataset, DEFAULT_TARGET);
      expect(check.passed).toBe(false);
      expect(check.severity).toBe("critical");
      expect(check.requiresManualRepair).toBe(true);
      expect(repairs).toHaveLength(1);
      expect(repairs[0].domain).toBe("ticket");
      expect(repairs[0].suggestedAction).toMatch(/2\.0\.0/);
    });

    it("detects pending transfers from the rolled-back version", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        transfers: [
          {
            id: "xfer-bad",
            ticketId: "tkt-x",
            fromOwner: KEY_A,
            toOwner: KEY_B,
            status: "pending",
            protocolVersion: "2.1.0",
            initiatedAt: Date.now() - 1_000,
            expiresAt: Date.now() + 86_400_000,
          },
        ],
      };

      const { check, repairs } = verifyPendingOperationsAndInFlightTransfers(
        dataset,
        DEFAULT_TARGET
      );
      expect(check.passed).toBe(false);
      expect(repairs[0].severity).toBe("critical");
      expect(repairs[0].suggestedAction).toContain("Cancel pending transfer");
    });

    it("detects stale pending transfers that exceeded the max age window", () => {
      const NOW = 1_700_500_000_000;
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        transfers: [
          {
            id: "xfer-stale",
            ticketId: "tkt-stale",
            fromOwner: KEY_A,
            toOwner: KEY_B,
            status: "pending",
            protocolVersion: "2.0.0", // target version but old
            initiatedAt: NOW - 25 * 60 * 60 * 1_000, // 25 hours ago
            expiresAt: NOW + 86_400_000,
          },
        ],
      };

      const { check, repairs } = verifyPendingOperationsAndInFlightTransfers(
        dataset,
        DEFAULT_TARGET,
        { now: () => new Date(NOW) }
      );
      expect(check.passed).toBe(false);
      expect(repairs[0].severity).toBe("warning");
    });

    it("detects unconfirmed redemptions", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        redemptions: [
          {
            id: "rdm-unconfirmed",
            ticketId: "tkt-y",
            eventId: "evt-y",
            redeemedBy: KEY_B,
            nonce: "nonce-xyz",
            protocolVersion: "2.0.0",
            redeemedAt: 1_699_000_050_000,
            isConfirmed: false,
          },
        ],
      };

      const { check, repairs } = verifyPartiallyProcessedRedemptions(dataset, DEFAULT_TARGET);
      expect(check.passed).toBe(false);
      expect(repairs[0].domain).toBe("redemption");
      expect(repairs[0].suggestedAction).toContain("reset ticket status");
    });

    it("detects redemptions processed under the rolled-back version", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        redemptions: [
          {
            id: "rdm-v21",
            ticketId: "tkt-z",
            eventId: "evt-z",
            redeemedBy: KEY_C,
            nonce: "nonce-new",
            protocolVersion: "2.1.0",
            redeemedAt: 1_699_000_050_000,
            isConfirmed: true,
          },
        ],
      };

      const { check } = verifyPartiallyProcessedRedemptions(dataset, DEFAULT_TARGET);
      expect(check.passed).toBe(false);
      expect(check.severity).toBe("critical");
    });

    it("flags active worker jobs with rolled-back payload versions (queued, running, retrying)", () => {
      for (const status of ["queued", "running", "retrying"] as const) {
        const dataset: ProtocolDataset = {
          ...emptyDataset(),
          workerJobs: [
            {
              id: `job-${status}`,
              jobType: "process_v21",
              status,
              payloadVersion: "2.1.0",
              payload: {},
              createdAt: 1_699_000_000_000,
              updatedAt: 1_699_000_010_000,
            },
          ],
        };

        const { check, repairs } = verifyWorkerJobPayloadCompatibility(dataset, DEFAULT_TARGET);
        expect(check.passed).toBe(false);
        expect(repairs[0].suggestedAction).toContain("dead-letter");
      }
    });

    it("flags event capacity overflow", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        events: [
          {
            id: "evt-tiny",
            name: "Tiny Event",
            organizerAddress: KEY_A,
            capacity: 1,
            status: "active",
            protocolVersion: "2.0.0",
            createdAt: 1_699_000_000_000,
          },
        ],
        tickets: [
          {
            id: "tkt-a",
            eventId: "evt-tiny",
            owner: KEY_A,
            tier: "general",
            status: "issued",
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_010_000,
            updatedAt: 1_699_000_010_000,
          },
          {
            id: "tkt-b",
            eventId: "evt-tiny",
            owner: KEY_B,
            tier: "general",
            status: "issued",
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_020_000,
            updatedAt: 1_699_000_020_000,
          },
        ],
      };

      const { check, repairs } = verifyEventCapacityAndIssuanceInvariants(dataset);
      expect(check.passed).toBe(false);
      const capRepair = repairs.find((r) => r.reason.includes("capacity exceeded"));
      expect(capRepair).toBeDefined();
    });

    it("flags duplicate ticket IDs as a critical violation", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        events: [
          {
            id: "evt-2",
            name: "Event 2",
            organizerAddress: KEY_A,
            capacity: 50,
            status: "active",
            protocolVersion: "2.0.0",
            createdAt: 1_699_000_000_000,
          },
        ],
        tickets: [
          {
            id: "tkt-dup",
            eventId: "evt-2",
            owner: KEY_A,
            tier: "general",
            status: "issued",
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_010_000,
            updatedAt: 1_699_000_010_000,
          },
          {
            id: "tkt-dup", // duplicate!
            eventId: "evt-2",
            owner: KEY_B,
            tier: "vip",
            status: "issued",
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_020_000,
            updatedAt: 1_699_000_020_000,
          },
        ],
      };

      const { check, repairs } = verifyEventCapacityAndIssuanceInvariants(dataset);
      expect(check.passed).toBe(false);
      const dupRepair = repairs.find((r) => r.reason.includes("Duplicate ticket identifier"));
      expect(dupRepair?.severity).toBe("critical");
    });

    it("flags tickets referencing non-existent events", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        tickets: [
          {
            id: "tkt-orphan",
            eventId: "evt-does-not-exist",
            owner: KEY_A,
            tier: "general",
            status: "issued",
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_010_000,
            updatedAt: 1_699_000_010_000,
          },
        ],
      };

      const { check, repairs } = verifyEventCapacityAndIssuanceInvariants(dataset);
      expect(check.passed).toBe(false);
      expect(repairs[0].reason).toContain("non-existent eventId");
    });

    it("flags invalid Stellar owner addresses on tickets", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        tickets: [
          {
            id: "tkt-bad-addr",
            eventId: "evt-x",
            owner: "NOT_A_STELLAR_KEY",
            tier: "general",
            status: "issued",
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_010_000,
            updatedAt: 1_699_000_010_000,
          },
        ],
      };

      const { check, repairs } = verifyExternalReferencesAndFraudControls(dataset, DEFAULT_TARGET);
      expect(check.passed).toBe(false);
      expect(repairs.some((r) => r.reason.includes("Invalid Stellar owner public key"))).toBe(true);
    });

    it("flags malformed external Stellar transaction hash references", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        tickets: [
          {
            id: "tkt-bad-ref",
            eventId: "evt-x",
            owner: KEY_A,
            tier: "general",
            status: "issued",
            protocolVersion: "2.0.0",
            externalRef: "short-hash-not-64-chars",
            issuedAt: 1_699_000_010_000,
            updatedAt: 1_699_000_010_000,
          },
        ],
      };

      const { repairs } = verifyExternalReferencesAndFraudControls(dataset, DEFAULT_TARGET);
      expect(repairs.some((r) => r.reason.includes("Malformed external Stellar transaction reference"))).toBe(true);
    });

    it("flags fraud records that were raised under rolled-back version and are pending review", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        fraudRecords: [
          {
            id: "fraud-stale",
            account: KEY_C,
            ruleId: "pattern_A",
            protocolVersion: "2.1.0", // rolled-back
            flaggedAt: 1_699_000_040_000,
            isManualReviewPending: true,
          },
        ],
      };

      const { repairs } = verifyExternalReferencesAndFraudControls(dataset, DEFAULT_TARGET);
      expect(repairs.some((r) => r.reason.includes("raised by rule under rolled-back"))).toBe(true);
    });

    it("produces ROLLBACK REQUIRES ACTION status in formatted report on critical failures", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        redemptions: [
          {
            id: "rdm-fail",
            ticketId: "tkt-f",
            eventId: "evt-f",
            redeemedBy: KEY_B,
            nonce: "nonce-f",
            protocolVersion: "2.1.0",
            redeemedAt: 1_699_000_000_000,
            isConfirmed: false,
          },
        ],
      };

      const report = verifyReleaseRollback(dataset, DEFAULT_TARGET);
      const formatted = formatRollbackReport(report);
      expect(formatted).toContain("ROLLBACK REQUIRES ACTION [FAIL]");
      expect(formatted).toContain("MANUAL REPAIR ACTIONS REQUIRED");
    });
  });

  // ─── Retry path ─────────────────────────────────────────────────────────────

  describe("retry path", () => {
    it("produces deterministic output on repeated calls with the same dataset", () => {
      const dataset = minimalCleanDataset();
      const r1 = verifyReleaseRollback(dataset, DEFAULT_TARGET, { now: () => new Date(1_700_000_000_000) });
      const r2 = verifyReleaseRollback(dataset, DEFAULT_TARGET, { now: () => new Date(1_700_000_000_000) });

      expect(r1.isClean).toBe(r2.isClean);
      expect(r1.totalChecks).toBe(r2.totalChecks);
      expect(r1.passedChecks).toBe(r2.passedChecks);
      expect(r1.manualRepairRecords).toHaveLength(r2.manualRepairRecords.length);
    });

    it("does not mutate the input dataset across multiple runs", () => {
      const dataset = minimalCleanDataset();
      const originalTicketCount = dataset.tickets.length;

      verifyReleaseRollback(dataset, DEFAULT_TARGET);
      verifyReleaseRollback(dataset, DEFAULT_TARGET);

      expect(dataset.tickets.length).toBe(originalTicketCount);
    });

    it("respects the readOnly flag and defaults to true", () => {
      const r1 = verifyReleaseRollback(emptyDataset(), DEFAULT_TARGET);
      const r2 = verifyReleaseRollback(emptyDataset(), DEFAULT_TARGET, { readOnly: true });
      const r3 = verifyReleaseRollback(emptyDataset(), DEFAULT_TARGET, { readOnly: false });

      expect(r1.readOnly).toBe(true);
      expect(r2.readOnly).toBe(true);
      expect(r3.readOnly).toBe(false);
    });

    it("uses a custom maxPendingTransferAgeMs window without throwing", () => {
      const NOW = 1_700_500_000_000;
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        transfers: [
          {
            id: "xfer-custom-window",
            ticketId: "tkt-w",
            fromOwner: KEY_A,
            toOwner: KEY_B,
            status: "pending",
            protocolVersion: "2.0.0",
            initiatedAt: NOW - 2 * 60 * 60 * 1_000, // 2 hours old
            expiresAt: NOW + 86_400_000,
          },
        ],
      };

      // With a custom window of 1 hour the transfer is stale
      const staleReport = verifyReleaseRollback(dataset, DEFAULT_TARGET, {
        now: () => new Date(NOW),
        maxPendingTransferAgeMs: 60 * 60 * 1_000,
      });
      expect(staleReport.isClean).toBe(false);

      // With a window of 3 hours the same transfer is still fresh
      const freshReport = verifyReleaseRollback(dataset, DEFAULT_TARGET, {
        now: () => new Date(NOW),
        maxPendingTransferAgeMs: 3 * 60 * 60 * 1_000,
      });
      expect(freshReport.isClean).toBe(true);
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────────

  describe("edge cases and rollback recovery", () => {
    it("cancelled tickets are excluded from capacity accounting", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        events: [
          {
            id: "evt-cap1",
            name: "Cap Test",
            organizerAddress: KEY_A,
            capacity: 1,
            status: "active",
            protocolVersion: "2.0.0",
            createdAt: 1_699_000_000_000,
          },
        ],
        tickets: [
          {
            id: "tkt-active",
            eventId: "evt-cap1",
            owner: KEY_A,
            tier: "general",
            status: "issued",
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_010_000,
            updatedAt: 1_699_000_010_000,
          },
          {
            id: "tkt-cancelled",
            eventId: "evt-cap1",
            owner: KEY_B,
            tier: "general",
            status: "cancelled", // should not count towards capacity
            protocolVersion: "2.0.0",
            issuedAt: 1_699_000_020_000,
            updatedAt: 1_699_000_030_000,
          },
        ],
      };

      const { check } = verifyEventCapacityAndIssuanceInvariants(dataset);
      expect(check.passed).toBe(true);
    });

    it("fraud records not pending review under rolled-back version are ignored", () => {
      const dataset: ProtocolDataset = {
        ...emptyDataset(),
        fraudRecords: [
          {
            id: "fraud-resolved",
            account: KEY_C,
            ruleId: "rate_limit",
            protocolVersion: "2.1.0",
            flaggedAt: 1_699_000_000_000,
            isManualReviewPending: false, // already resolved
          },
        ],
      };

      const { check } = verifyExternalReferencesAndFraudControls(dataset, DEFAULT_TARGET);
      expect(check.passed).toBe(true);
    });

    it("non-pending transfers in any state are not flagged", () => {
      for (const status of ["accepted", "rejected", "cancelled", "expired"] as const) {
        const dataset: ProtocolDataset = {
          ...emptyDataset(),
          transfers: [
            {
              id: `xfer-${status}`,
              ticketId: "tkt-x",
              fromOwner: KEY_A,
              toOwner: KEY_B,
              status,
              protocolVersion: "2.1.0", // rolled-back version — but not pending
              initiatedAt: Date.now() - 1_000,
              expiresAt: Date.now() + 86_400_000,
            },
          ],
        };

        const { check } = verifyPendingOperationsAndInFlightTransfers(dataset, DEFAULT_TARGET);
        expect(check.passed).toBe(true);
      }
    });

    it("the report timestamp reflects the custom `now` clock", () => {
      const fixedTime = new Date("2026-01-01T00:00:00.000Z");
      const report = verifyReleaseRollback(emptyDataset(), DEFAULT_TARGET, {
        now: () => fixedTime,
      });
      expect(report.timestamp).toEqual(fixedTime);
    });
  });
});
