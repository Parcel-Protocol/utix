import { describe, expect, it } from "vitest";
import { StaleProjectionDetector } from "../stale-detector";
import type { CacheEntry, IndexEntry, InspectionContext, RepairRecommendation } from "../types";

describe("Issue #356: Stale-Cache Detection with Repair Recommendations", () => {
  const baseTime = 1700000000000;

  const sampleCache: CacheEntry = {
    key: "account:GAAAAA",
    value: { balance: "250.0000000" },
    cachedAt: baseTime - 120000,
    ttlMs: 60000, // expired!
    version: 1,
    ledgerSequence: 49990
  };

  const sampleIndex: IndexEntry = {
    indexKey: "index:ticket_owner:GAAAAA",
    targetId: "DELETED_TICKET_999",
    indexedAt: baseTime - 5000,
    version: 1
  };

  const context: InspectionContext = {
    now: baseTime,
    currentSchemaVersion: 1,
    authoritativeLedgerSequence: 50000,
    primaryEntityIds: new Set(["account:GAAAAA"]), // targetId DELETED_TICKET_999 is missing!
    maxToleratedDriftLedgers: 5
  };

  describe("Normal Path", () => {
    it("inspects and produces prioritized repair recommendations", () => {
      const report = StaleProjectionDetector.inspect([sampleCache], [sampleIndex], context);

      expect(report.clean).toBe(false);
      expect(report.staleCachesCount).toBe(1);
      expect(report.staleIndexesCount).toBe(1);
      expect(report.recommendations.length).toBe(2);

      const ttlRec = report.recommendations.find(r => r.staleReason === "ttl_expired");
      expect(ttlRec).toBeDefined();
      expect(ttlRec?.recommendedAction).toBe("evict");

      const idxRec = report.recommendations.find(r => r.staleReason === "index_inconsistency");
      expect(idxRec).toBeDefined();
      expect(idxRec?.recommendedAction).toBe("reindex");
    });

    it("generates pure dry-run repair preview with predicted effects and digest", () => {
      const report = StaleProjectionDetector.inspect([sampleCache], [], context);
      const recommendation = report.recommendations[0];

      const preview = StaleProjectionDetector.previewRepair(recommendation, sampleCache);

      expect(preview.previewId).toBeDefined();
      expect(preview.targetKey).toBe(sampleCache.key);
      expect(preview.action).toBe("evict");
      expect(preview.riskLevel).toBe("low");
      expect(preview.reversibility).toBe("reversible");
      expect(preview.rollbackSupported).toBe(true);
      expect(preview.previewDigest).toHaveLength(64);
      expect(preview.predictedEffect).toContain("Evict key");
    });

    it("successfully executes eviction repair", () => {
      let evictedKey = "";
      const recommendation: RepairRecommendation = {
        id: "rec-1",
        targetKey: "account:GAAAAA",
        kind: "cache",
        staleReason: "ttl_expired",
        severity: "warning",
        recommendedAction: "evict",
        scope: "single",
        operatorGuidance: "Evict entry"
      };

      const result = StaleProjectionDetector.executeRepair(recommendation, {
        onEvict: (k) => {
          evictedKey = k;
          return true;
        }
      });

      expect(result.success).toBe(true);
      expect(result.actionExecuted).toBe("evict");
      expect(evictedKey).toBe("account:GAAAAA");
    });
  });

  describe("Authorization Path", () => {
    const recommendation: RepairRecommendation = {
      id: "rec-auth-1",
      targetKey: "account:GAAAAA",
      kind: "cache",
      staleReason: "ledger_drift",
      severity: "critical",
      recommendedAction: "resync",
      scope: "single",
      operatorGuidance: "Resync with Horizon"
    };

    it("rejects repair execution for unauthorized user role", () => {
      const result = StaleProjectionDetector.executeRepairAuthorized(
        recommendation,
        { onResync: () => true },
        { role: "viewer", userId: "usr-viewer" }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("permission_denied");
      expect(result.message).toContain("permission");
    });

    it("allows repair execution for admin:recovery maintainer role", () => {
      let resynced = false;
      const result = StaleProjectionDetector.executeRepairAuthorized(
        recommendation,
        {
          onResync: () => {
            resynced = true;
            return true;
          }
        },
        { role: "maintainer", userId: "maintainer-admin" }
      );

      expect(result.success).toBe(true);
      expect(resynced).toBe(true);
    });
  });

  describe("Failure & Retry Path", () => {
    it("handles repair handler failure and flags as retryable", () => {
      const recommendation: RepairRecommendation = {
        id: "rec-fail",
        targetKey: "account:stale",
        kind: "cache",
        staleReason: "version_mismatch",
        severity: "warning",
        recommendedAction: "resync",
        scope: "single",
        operatorGuidance: "Resync"
      };

      // Handler throws Horizon 429
      const result = StaleProjectionDetector.executeRepair(recommendation, {
        onResync: () => {
          throw new Error("Horizon 429: Rate limit exceeded");
        }
      });

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe("handler_exception");
      expect(result.message).toContain("Rate limit exceeded");
    });

    it("calculates exponential backoff for repair retries", () => {
      const backoff0 = StaleProjectionDetector.computeRepairRetryBackoffMs(0, 1000);
      const backoff1 = StaleProjectionDetector.computeRepairRetryBackoffMs(1, 1000);
      const backoff2 = StaleProjectionDetector.computeRepairRetryBackoffMs(2, 1000);

      expect(backoff0).toBe(1000);
      expect(backoff1).toBe(2000);
      expect(backoff2).toBe(4000);
    });
  });

  describe("Rollback & Restore Path", () => {
    it("rolls back repair and restores backup snapshot", () => {
      let restoredKey = "";
      let restoredVal: unknown = null;

      const rollbackResult = StaleProjectionDetector.rollbackRepair(
        sampleCache,
        {
          onRestoreCache: (entry) => {
            restoredKey = entry.key;
            restoredVal = entry.value;
            return true;
          }
        },
        { role: "maintainer", userId: "maintainer-1" }
      );

      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.actionExecuted).toBe("restore");
      expect(restoredKey).toBe("account:GAAAAA");
      expect(restoredVal).toEqual({ balance: "250.0000000" });
    });

    it("rejects rollback from unauthorized user", () => {
      const rollbackResult = StaleProjectionDetector.rollbackRepair(
        sampleCache,
        { onRestoreCache: () => true },
        { role: "viewer", userId: "viewer-unauthorized" }
      );

      expect(rollbackResult.success).toBe(false);
      expect(rollbackResult.errorCode).toBe("permission_denied");
    });
  });
});

