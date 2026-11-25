/**
 * Stale Cache and Stale Index Detector (#236)
 *
 * Provides inspection of cached projections and index mappings to identify staleness,
 * version skew, ledger drift, and orphan references, outputting automated repair recommendations
 * and operator-visible evidence.
 */

import { recordAudit } from "@/core/audit/audit";
import { hasPermission } from "@/core/auth/types";
import type { AuthContext } from "@/core/auth/middleware";
import { sha256Hex } from "@/core/ledger/sha256";
import type {
  CacheEntry,
  IndexEntry,
  InspectionContext,
  RepairPreview,
  RepairRecommendation,
  RepairResult,
  StaleFinding,
  StaleInspectionReport
} from "./types";

export class StaleProjectionDetector {
  /**
   * Inspects cache projections and index tables for stale data.
   * Completely read-only: does not modify input collections.
   */
  public static inspect(
    caches: readonly CacheEntry[],
    indexes: readonly IndexEntry[],
    context: InspectionContext
  ): StaleInspectionReport {
    const nowMs =
      context.now instanceof Date
        ? context.now.getTime()
        : typeof context.now === "number"
          ? context.now
          : Date.now();

    const maxDrift = context.maxToleratedDriftLedgers ?? 5;
    const primarySet = context.primaryEntityIds
      ? new Set(context.primaryEntityIds)
      : null;

    const findings: StaleFinding[] = [];
    const recommendations: RepairRecommendation[] = [];

    let staleCachesCount = 0;
    let staleIndexesCount = 0;

    // 1. Inspect Caches
    for (const entry of caches) {
      const cachedAtMs =
        typeof entry.cachedAt === "string"
          ? new Date(entry.cachedAt).getTime()
          : entry.cachedAt;
      // An unreadable timestamp gives a NaN age, and `NaN > ttl` is false, so
      // the entry used to pass as fresh forever. Its age is unknown, so it is
      // treated as expired instead (#359).
      const unreadable = !Number.isFinite(cachedAtMs);
      const ageMs = unreadable ? 0 : Math.max(0, nowMs - cachedAtMs);

      if (unreadable) {
        staleCachesCount += 1;
        const findingId = `stale-cache-ttl-${entry.key}`;
        findings.push({
          id: findingId,
          kind: "cache",
          targetKey: entry.key,
          staleReason: "ttl_expired",
          severity: "warning",
          ageMs,
          details: `Cache entry has an unreadable cachedAt (${String(entry.cachedAt)}); its age is unknown, so it is treated as expired`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: entry.key,
          kind: "cache",
          staleReason: "ttl_expired",
          severity: "warning",
          recommendedAction: "evict",
          scope: "single",
          operatorGuidance: `Evict key "${entry.key}": its timestamp cannot be read, so its freshness cannot be proven.`,
          remediationPayload: { key: entry.key, action: "evict" }
        });
        continue;
      }

      // Check TTL expiration
      if (entry.ttlMs > 0 && ageMs > entry.ttlMs) {
        staleCachesCount += 1;
        const findingId = `stale-cache-ttl-${entry.key}`;
        findings.push({
          id: findingId,
          kind: "cache",
          targetKey: entry.key,
          staleReason: "ttl_expired",
          severity: ageMs > entry.ttlMs * 3 ? "warning" : "info",
          ageMs,
          details: `Cache entry expired (${ageMs}ms old > TTL ${entry.ttlMs}ms)`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: entry.key,
          kind: "cache",
          staleReason: "ttl_expired",
          severity: ageMs > entry.ttlMs * 3 ? "warning" : "info",
          recommendedAction: "evict",
          scope: "single",
          operatorGuidance: `Evict key "${entry.key}" from cache store or let the next query fetch fresh state.`,
          remediationPayload: { key: entry.key, action: "evict" }
        });
        continue;
      }

      // Check Schema Version Mismatch
      if (entry.version < context.currentSchemaVersion) {
        staleCachesCount += 1;
        const findingId = `stale-cache-ver-${entry.key}`;
        findings.push({
          id: findingId,
          kind: "cache",
          targetKey: entry.key,
          staleReason: "version_mismatch",
          severity: "warning",
          ageMs,
          observedVersion: entry.version,
          expectedVersion: context.currentSchemaVersion,
          details: `Cache entry format v${entry.version} is behind current schema v${context.currentSchemaVersion}`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: entry.key,
          kind: "cache",
          staleReason: "version_mismatch",
          severity: "warning",
          recommendedAction: "resync",
          scope: "single",
          operatorGuidance: `Resync and re-serialize key "${entry.key}" with schema v${context.currentSchemaVersion}.`,
          remediationPayload: { key: entry.key, targetVersion: context.currentSchemaVersion }
        });
        continue;
      }

      // Check Ledger Sequence Drift
      if (
        typeof context.authoritativeLedgerSequence === "number" &&
        typeof entry.ledgerSequence === "number"
      ) {
        const drift = context.authoritativeLedgerSequence - entry.ledgerSequence;
        if (drift > maxDrift) {
          staleCachesCount += 1;
          const findingId = `stale-cache-seq-${entry.key}`;
          findings.push({
            id: findingId,
            kind: "cache",
            targetKey: entry.key,
            staleReason: "ledger_drift",
            severity: drift > 100 ? "critical" : "warning",
            ageMs,
            observedSequence: entry.ledgerSequence,
            authoritativeSequence: context.authoritativeLedgerSequence,
            details: `Cache projection at ledger ${entry.ledgerSequence} is ${drift} ledgers behind head (${context.authoritativeLedgerSequence})`
          });
          recommendations.push({
            id: `rec-${findingId}`,
            targetKey: entry.key,
            kind: "cache",
            staleReason: "ledger_drift",
            severity: drift > 100 ? "critical" : "warning",
            recommendedAction: "resync",
            scope: "single",
            operatorGuidance: `Re-query Horizon or RPC to refresh projection "${entry.key}" to ledger ${context.authoritativeLedgerSequence}.`,
            remediationPayload: { key: entry.key, headSequence: context.authoritativeLedgerSequence }
          });
          continue;
        }
      }

      // Check Orphaned Source Entity
      if (primarySet && entry.sourceEntityId && !primarySet.has(entry.sourceEntityId)) {
        staleCachesCount += 1;
        const findingId = `stale-cache-orphan-${entry.key}`;
        findings.push({
          id: findingId,
          kind: "cache",
          targetKey: entry.key,
          staleReason: "orphan_reference",
          severity: "warning",
          ageMs,
          details: `Cache entry references deleted or non-existent entity "${entry.sourceEntityId}"`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: entry.key,
          kind: "cache",
          staleReason: "orphan_reference",
          severity: "warning",
          recommendedAction: "evict",
          scope: "single",
          operatorGuidance: `Evict dangling cache entry "${entry.key}" because root record "${entry.sourceEntityId}" is gone.`,
          remediationPayload: { key: entry.key, orphanId: entry.sourceEntityId }
        });
      }
    }

    // 2. Inspect Indexes
    for (const index of indexes) {
      const indexedAtMs =
        typeof index.indexedAt === "string"
          ? new Date(index.indexedAt).getTime()
          : index.indexedAt;
      const ageMs = Number.isFinite(indexedAtMs) ? Math.max(0, nowMs - indexedAtMs) : 0;

      // Check Orphan Target in Index
      if (primarySet && !primarySet.has(index.targetId)) {
        staleIndexesCount += 1;
        const findingId = `stale-index-orphan-${index.indexKey}`;
        findings.push({
          id: findingId,
          kind: "index",
          targetKey: index.indexKey,
          staleReason: "index_inconsistency",
          severity: "critical",
          ageMs,
          details: `Index pointer "${index.indexKey}" references absent target "${index.targetId}"`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: index.indexKey,
          kind: "index",
          staleReason: "index_inconsistency",
          severity: "critical",
          recommendedAction: "reindex",
          scope: "single",
          operatorGuidance: `Rebuild index entry "${index.indexKey}" or delete dangling index pointer.`,
          remediationPayload: { indexKey: index.indexKey, missingTargetId: index.targetId }
        });
        continue;
      }

      // Check Schema Version
      if (index.version < context.currentSchemaVersion) {
        staleIndexesCount += 1;
        const findingId = `stale-index-ver-${index.indexKey}`;
        findings.push({
          id: findingId,
          kind: "index",
          targetKey: index.indexKey,
          staleReason: "version_mismatch",
          severity: "warning",
          ageMs,
          observedVersion: index.version,
          expectedVersion: context.currentSchemaVersion,
          details: `Index metadata schema v${index.version} is older than system schema v${context.currentSchemaVersion}`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: index.indexKey,
          kind: "index",
          staleReason: "version_mismatch",
          severity: "warning",
          recommendedAction: "reindex",
          scope: "partition",
          operatorGuidance: `Trigger index partition rebuild for schema version ${context.currentSchemaVersion}.`,
          remediationPayload: { indexKey: index.indexKey, targetVersion: context.currentSchemaVersion }
        });
      }
    }

    return {
      inspectedAt: new Date(nowMs).toISOString(),
      totalCachesScanned: caches.length,
      staleCachesCount,
      totalIndexesScanned: indexes.length,
      staleIndexesCount,
      findings,
      recommendations,
      clean: findings.length === 0
    };
  }

  /**
   * Generates a pure, dry-run repair preview before executing mutations (#356).
   * Time complexity: O(1).
   * Space complexity: O(1).
   */
  public static previewRepair(
    recommendation: RepairRecommendation,
    snapshot?: CacheEntry | IndexEntry
  ): RepairPreview {
    const previewId = `repair-prev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reversibility = snapshot ? "reversible" : (recommendation.recommendedAction === "evict" ? "partially_reversible" : "irreversible");
    const riskLevel = recommendation.severity === "critical" ? "high" : (recommendation.recommendedAction === "reindex" ? "medium" : "low");

    let predictedEffect = "";
    switch (recommendation.recommendedAction) {
      case "evict":
        predictedEffect = `Evict key "${recommendation.targetKey}" from cache. Next read will load fresh authoritative state.`;
        break;
      case "resync":
        predictedEffect = `Re-query Horizon or RPC to refresh projection "${recommendation.targetKey}".`;
        break;
      case "reindex":
        predictedEffect = `Rebuild index mapping "${recommendation.targetKey}" to match primary entity store.`;
        break;
      default:
        predictedEffect = `Dispatch repair job for "${recommendation.targetKey}".`;
        break;
    }

    const previewDigest = sha256Hex(JSON.stringify({
      previewId,
      targetKey: recommendation.targetKey,
      action: recommendation.recommendedAction,
      staleReason: recommendation.staleReason,
      snapshot
    }));

    return {
      previewId,
      targetKey: recommendation.targetKey,
      kind: recommendation.kind,
      action: recommendation.recommendedAction,
      staleReason: recommendation.staleReason,
      riskLevel,
      reversibility,
      scope: recommendation.scope,
      predictedEffect,
      rollbackSupported: Boolean(snapshot),
      backupSnapshot: snapshot,
      previewDigest
    };
  }

  /**
   * Applies an automated repair recommendation with an auditable outcome.
   * Handles failure and retry paths gracefully.
   */
  public static executeRepair(
    recommendation: RepairRecommendation,
    handlers: {
      onEvict?: (key: string) => boolean | Promise<boolean>;
      onReindex?: (key: string, payload?: Record<string, unknown>) => boolean | Promise<boolean>;
      onResync?: (key: string, payload?: Record<string, unknown>) => boolean | Promise<boolean>;
    }
  ): RepairResult {
    const timestamp = new Date().toISOString();
    let success = false;
    let message = "";
    let errorCode: string | undefined;

    try {
      if (recommendation.recommendedAction === "evict") {
        if (handlers.onEvict) {
          const res = handlers.onEvict(recommendation.targetKey);
          success = Boolean(res);
          if (!success) {
            errorCode = "eviction_failed";
            message = `Eviction handler returned false for key "${recommendation.targetKey}"`;
          } else {
            message = `Successfully evicted stale entry "${recommendation.targetKey}"`;
          }
        } else {
          success = true;
          message = `Successfully evicted stale entry "${recommendation.targetKey}"`;
        }
      } else if (recommendation.recommendedAction === "reindex") {
        if (handlers.onReindex) {
          const res = handlers.onReindex(recommendation.targetKey, recommendation.remediationPayload);
          success = Boolean(res);
          if (!success) {
            errorCode = "reindex_failed";
            message = `Reindex handler returned false for key "${recommendation.targetKey}"`;
          } else {
            message = `Successfully reindexed "${recommendation.targetKey}"`;
          }
        } else {
          success = true;
          message = `Successfully reindexed "${recommendation.targetKey}"`;
        }
      } else if (recommendation.recommendedAction === "resync") {
        if (handlers.onResync) {
          const res = handlers.onResync(recommendation.targetKey, recommendation.remediationPayload);
          success = Boolean(res);
          if (!success) {
            errorCode = "resync_failed";
            message = `Resync handler returned false for key "${recommendation.targetKey}"`;
          } else {
            message = `Successfully initiated resync for "${recommendation.targetKey}"`;
          }
        } else {
          success = true;
          message = `Successfully initiated resync for "${recommendation.targetKey}"`;
        }
      } else {
        message = `Queued background repair job for "${recommendation.targetKey}"`;
        success = true;
      }
    } catch (err: unknown) {
      success = false;
      errorCode = "handler_exception";
      message = `Repair execution failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const evidence = {
      targetKey: recommendation.targetKey,
      action: recommendation.recommendedAction,
      staleReason: recommendation.staleReason,
      severity: recommendation.severity,
      payload: recommendation.remediationPayload,
      executedAt: timestamp,
      errorCode
    };

    recordAudit({
      action: "projection.repaired",
      actor: { kind: "system", id: "stale_projection_repairer" },
      target: { kind: recommendation.kind, id: recommendation.targetKey },
      outcome: success ? "allowed" : "denied",
      after: evidence,
      at: timestamp,
      reason: recommendation.staleReason
    });

    return {
      recommendationId: recommendation.id,
      success,
      actionExecuted: recommendation.recommendedAction,
      targetKey: recommendation.targetKey,
      timestamp,
      message,
      evidence,
      retryable: !success,
      errorCode,
      rollbackSupported: recommendation.recommendedAction === "evict" || recommendation.recommendedAction === "resync"
    };
  }

  /**
   * Authorized repair boundary (#356). Enforces admin:recovery permission before modifying cache/index.
   *
   * Time complexity: O(1).
   * Space complexity: O(1).
   */
  public static executeRepairAuthorized(
    recommendation: RepairRecommendation,
    handlers: {
      onEvict?: (key: string) => boolean | Promise<boolean>;
      onReindex?: (key: string, payload?: Record<string, unknown>) => boolean | Promise<boolean>;
      onResync?: (key: string, payload?: Record<string, unknown>) => boolean | Promise<boolean>;
    },
    auth: AuthContext
  ): RepairResult {
    const isAllowed = auth.role === "maintainer" || hasPermission(auth.role, "admin:recovery");
    if (!isAllowed) {
      const timestamp = new Date().toISOString();
      const evidence = {
        targetKey: recommendation.targetKey,
        action: recommendation.recommendedAction,
        unauthorizedUser: auth.userId,
        unauthorizedRole: auth.role
      };

      try {
        recordAudit({
          action: "projection.repaired",
          actor: { kind: "user", id: auth.userId ?? "unknown" },
          target: { kind: recommendation.kind, id: recommendation.targetKey },
          outcome: "denied",
          after: evidence,
          at: timestamp,
          reason: "permission_denied"
        });
      } catch {
        // Non-fatal
      }

      return {
        recommendationId: recommendation.id,
        success: false,
        actionExecuted: recommendation.recommendedAction,
        targetKey: recommendation.targetKey,
        timestamp,
        message: "Repair authorization denied: requires admin:recovery permission",
        evidence,
        retryable: false,
        errorCode: "permission_denied"
      };
    }

    return this.executeRepair(recommendation, handlers);
  }

  /**
   * Rolls back an erroneous repair by restoring the captured backup snapshot (#356).
   */
  public static rollbackRepair(
    backupSnapshot: CacheEntry | IndexEntry,
    handlers: {
      onRestoreCache?: (entry: CacheEntry) => boolean | Promise<boolean>;
      onRestoreIndex?: (entry: IndexEntry) => boolean | Promise<boolean>;
    },
    auth?: AuthContext
  ): RepairResult {
    if (auth) {
      const isAllowed = auth.role === "maintainer" || hasPermission(auth.role, "admin:recovery");
      if (!isAllowed) {
        return {
          recommendationId: "rollback",
          success: false,
          actionExecuted: "restore",
          targetKey: "key" in backupSnapshot ? backupSnapshot.key : backupSnapshot.indexKey,
          timestamp: new Date().toISOString(),
          message: "Rollback authorization denied: requires admin:recovery permission",
          evidence: {},
          retryable: false,
          errorCode: "permission_denied"
        };
      }
    }

    const timestamp = new Date().toISOString();
    let success = false;
    let message = "";
    const targetKey = "key" in backupSnapshot ? backupSnapshot.key : backupSnapshot.indexKey;

    try {
      if ("key" in backupSnapshot && handlers.onRestoreCache) {
        success = Boolean(handlers.onRestoreCache(backupSnapshot));
        message = `Successfully rolled back and restored cache key "${targetKey}"`;
      } else if ("indexKey" in backupSnapshot && handlers.onRestoreIndex) {
        success = Boolean(handlers.onRestoreIndex(backupSnapshot));
        message = `Successfully rolled back and restored index pointer "${targetKey}"`;
      } else {
        success = true;
        message = `Restored snapshot for "${targetKey}"`;
      }
    } catch (err) {
      success = false;
      message = `Rollback failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    recordAudit({
      action: "projection.restored",
      actor: { kind: "system", id: "stale_projection_repairer" },
      target: { kind: "key" in backupSnapshot ? "cache" : "index", id: targetKey },
      outcome: success ? "allowed" : "denied",
      at: timestamp,
      reason: "repair_rollback"
    });

    return {
      recommendationId: `rollback-${targetKey}`,
      success,
      actionExecuted: "restore",
      targetKey,
      timestamp,
      message,
      evidence: { targetKey, restoredAt: timestamp }
    };
  }

  /**
   * Computes exponential backoff for failed repair retries.
   */
  public static computeRepairRetryBackoffMs(attemptNumber: number, baseMs: number = 1000, maxMs: number = 30000): number {
    // NaN, negative or fractional attempts used to yield NaN or sub-base
    // delays (#359). The attempt is clamped to a whole number ≥ 0, so the
    // delay is always within [0, maxMs] and never below `baseMs` (when baseMs ≤ maxMs).
    const ceiling = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0;
    const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
    const attempt = Number.isNaN(attemptNumber) ? 0 : Math.max(0, Math.floor(attemptNumber));
    return Math.min(ceiling, base * Math.pow(2, attempt));
  }
}
