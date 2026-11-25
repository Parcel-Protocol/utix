/**
 * Operational Data Retention and Deletion Service (#259)
 *
 * Implements retention lifecycle, secure deletion, and scrub validation
 * for sensitive operational data (audit logs, exports, notifications, idempotency).
 */

import { createHash } from "node:crypto";
import { err, ok, type Result } from "@/core/result/result";
import type { AuditActor } from "./audit";

export type RetentionErrorCode =
  | "retention_denied"
  | "retention_failed"
  | "retention_retries_exhausted"
  | "invalid_policy"
  | "invalid_deletion_request"
  | "verification_failed";

export interface DeletionVerificationProof {
  readonly recordKind: string;
  readonly verifiedAt: string;
  readonly verifiedBy: AuditActor;
  readonly deletedIdsCount: number;
  readonly activeRecordsCount: number;
  readonly verifiedNonExistence: boolean;
  readonly ttlCompliant: boolean;
  readonly capacityCompliant: boolean;
  readonly scrubCompliant: boolean;
  readonly stateDigest: string;
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export interface RetentionEnforcementVerificationResult<T = unknown> {
  readonly sweep: RetentionSweepResult<T>;
  readonly verification: DeletionVerificationProof;
}

export interface RetentionPolicy {
  readonly recordKind: string;
  readonly maxRecords?: number;
  readonly ttlMs?: number;
  readonly scrubSensitiveFields?: boolean;
}

export interface DeletionOptions {
  readonly actor: AuditActor;
  readonly reason: string;
  readonly dryRun?: boolean;
  readonly maxRetries?: number;
  readonly retryBackoffMs?: number;
  readonly now?: () => number;
  readonly simulateTransientFailures?: number;
}

export interface RetentionSweepResult<T = unknown> {
  readonly recordKind: string;
  readonly totalScanned: number;
  readonly retainedCount: number;
  readonly deletedCount: number;
  readonly dryRun: boolean;
  readonly scrubbedFieldsCount: number;
  readonly retainedRecords: readonly T[];
  readonly durationMs: number;
}

const EMBEDDED_SECRET_PATTERN = /\b[SM][A-Z2-7]{55}\b/g;
const EMBEDDED_BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+\b/gi;
const SENSITIVE_KEY_PATTERN = /secret|seed|key|token|password|passphrase|auth|credential|bearer|cookie/i;

function containsUnredactedSensitiveValue(value: unknown, key?: string): boolean {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return value !== "[REDACTED]";
  if (typeof value === "string") return EMBEDDED_SECRET_PATTERN.test(value) || EMBEDDED_BEARER_PATTERN.test(value);
  if (Array.isArray(value)) return value.some((item) => containsUnredactedSensitiveValue(item));
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([name, child]) => containsUnredactedSensitiveValue(child, name));
  return false;
}

export function scrubSensitiveValue(value: unknown): { scrubbed: unknown; modified: boolean } {
  if (value === null || value === undefined) {
    return { scrubbed: value, modified: false };
  }

  if (typeof value === "string") {
    let modified = false;
    let result = value;
    if (EMBEDDED_SECRET_PATTERN.test(result)) {
      result = result.replace(EMBEDDED_SECRET_PATTERN, "[REDACTED]");
      modified = true;
    }
    if (EMBEDDED_BEARER_PATTERN.test(result)) {
      result = result.replace(EMBEDDED_BEARER_PATTERN, "[REDACTED]");
      modified = true;
    }
    return { scrubbed: result, modified };
  }

  if (Array.isArray(value)) {
    let modified = false;
    const arrayResult = value.map((item) => {
      const child = scrubSensitiveValue(item);
      if (child.modified) modified = true;
      return child.scrubbed;
    });
    return { scrubbed: arrayResult, modified };
  }

  if (typeof value === "object") {
    let modified = false;
    const objectResult: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        objectResult[k] = "[REDACTED]";
        modified = true;
      } else {
        const child = scrubSensitiveValue(v);
        if (child.modified) modified = true;
        objectResult[k] = child.scrubbed;
      }
    }
    return { scrubbed: objectResult, modified };
  }

  return { scrubbed: value, modified: false };
}

export class OperationalDataRetentionManager {
  /**
   * Enforces retention policy on a dataset: deletes records older than TTL
   * or beyond max record capacity, while scrubbing sensitive operational fields.
   *
   * Time Complexity: O(N) where N is the number of records.
   * Space Complexity: O(N) for holding the retained slice.
   */
  public static async enforceRetention<T extends { id?: string; at?: string; timestamp?: string | number | Date }>(
    records: readonly T[],
    policy: RetentionPolicy,
    options: DeletionOptions
  ): Promise<Result<RetentionSweepResult<T>, RetentionErrorCode>> {
    const startTime = Date.now();

    // Authorization Gate
    if (options.actor.kind === "user") {
      return err("retention_denied");
    }

    if (!policy.recordKind || policy.recordKind.trim().length === 0) {
      return err("invalid_policy");
    }

    if (!options.reason || options.reason.trim().length === 0) {
      return err("invalid_deletion_request");
    }

    const maxRetries = options.maxRetries ?? 3;
    let attempts = 0;
    let transientFailuresLeft = options.simulateTransientFailures ?? 0;

    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        if (transientFailuresLeft > 0) {
          transientFailuresLeft -= 1;
          throw new Error("Transient storage read/write lock failure");
        }

        const now = options.now ? options.now() : Date.now();
        const ttlMs = policy.ttlMs;
        const maxRecords = policy.maxRecords !== undefined ? Math.max(0, policy.maxRecords) : Infinity;

        let scrubbedCount = 0;
        const validTimeRecords: { record: T; timestampMs: number }[] = [];

        for (const record of records) {
          let rec = record;
          if (policy.scrubSensitiveFields !== false) {
            const scrubResult = scrubSensitiveValue(record);
            if (scrubResult.modified) {
              scrubbedCount += 1;
              rec = scrubResult.scrubbed as T;
            }
          }

          let ts = now;
          if (rec.at) {
            const parsed = Date.parse(rec.at);
            if (!Number.isNaN(parsed)) ts = parsed;
          } else if (rec.timestamp) {
            const parsed = typeof rec.timestamp === "number" ? rec.timestamp : Date.parse(String(rec.timestamp));
            if (!Number.isNaN(parsed)) ts = parsed;
          }

          if (ttlMs !== undefined) {
            if (now - ts <= ttlMs) {
              validTimeRecords.push({ record: rec, timestampMs: ts });
            }
          } else {
            validTimeRecords.push({ record: rec, timestampMs: ts });
          }
        }

        let retained: T[] = [];
        if (validTimeRecords.length > maxRecords) {
          validTimeRecords.sort((a, b) => a.timestampMs - b.timestampMs);
          const startIndex = validTimeRecords.length - maxRecords;
          retained = validTimeRecords.slice(startIndex).map((item) => item.record);
        } else {
          retained = validTimeRecords.map((item) => item.record);
        }

        const deletedCount = records.length - retained.length;
        const durationMs = Date.now() - startTime;

        return ok({
          recordKind: policy.recordKind,
          totalScanned: records.length,
          retainedCount: options.dryRun ? records.length : retained.length,
          deletedCount,
          dryRun: options.dryRun ?? false,
          scrubbedFieldsCount: scrubbedCount,
          retainedRecords: options.dryRun ? records : retained,
          durationMs
        });
      } catch {
        if (attempts > maxRetries) {
          return err("retention_retries_exhausted");
        }
        if (options.retryBackoffMs && options.retryBackoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.retryBackoffMs));
        }
      }
    }

    return err("retention_retries_exhausted");
  }

  /**
   * Permanently purges specific sensitive records matching a condition.
   * Time Complexity: O(N)
   * Space Complexity: O(N)
   */
  public static purgeSensitiveOperationalData<T>(
    records: readonly T[],
    predicate: (record: T) => boolean,
    options: DeletionOptions
  ): Result<{ purgedCount: number; remainingRecords: readonly T[] }, RetentionErrorCode> {
    if (options.actor.kind === "user") {
      return err("retention_denied");
    }

    if (!options.reason || options.reason.trim().length === 0) {
      return err("invalid_deletion_request");
    }

    try {
      const remaining: T[] = [];
      let purgedCount = 0;

      for (const record of records) {
        if (predicate(record)) {
          purgedCount += 1;
        } else {
          remaining.push(record);
        }
      }

      if (options.dryRun) {
        return ok({
          purgedCount,
          remainingRecords: records
        });
      }

      return ok({
        purgedCount,
        remainingRecords: remaining
      });
    } catch {
      return err("retention_failed");
    }
  }

  /**
   * Cryptographically verifies deletion and retention constraints (#400).
   *
   * Verifies:
   * 1. Non-existence: None of the deleted record IDs appear in the active records.
   * 2. Retention bounds: No active record exceeds the TTL threshold.
   * 3. Capacity bounds: Active records count does not exceed maxRecords.
   * 4. Scrubbing compliance: Active records do not expose unredacted sensitive operational secrets.
   * 5. State integrity: Deterministic SHA-256 state digest over remaining records.
   *
   * Time Complexity: O(N + D) where N is active records and D is deleted IDs.
   * Space Complexity: O(D) for deleted ID set lookup.
   */
  public static verifyDeletion<T extends { id?: string; at?: string; timestamp?: string | number | Date }>(
    activeRecords: readonly T[],
    deletedRecordIds: readonly string[],
    policy: RetentionPolicy,
    options: DeletionOptions
  ): Result<DeletionVerificationProof, RetentionErrorCode> {
    if (options.actor.kind === "user") {
      return err("retention_denied");
    }

    if (!policy.recordKind || policy.recordKind.trim().length === 0) {
      return err("invalid_policy");
    }

    if (!options.reason || options.reason.trim().length === 0) {
      return err("invalid_deletion_request");
    }

    try {
      const violations: string[] = [];
      const deletedSet = new Set(deletedRecordIds);

      // 1. Non-existence confirmation
      let nonExistenceConfirmed = true;
      for (const rec of activeRecords) {
        if (rec.id && deletedSet.has(rec.id)) {
          nonExistenceConfirmed = false;
          violations.push(`Deleted record id "${rec.id}" still present in active records`);
        }
      }

      // 2. TTL compliance check
      const now = options.now ? options.now() : Date.now();
      let ttlCompliant = true;
      if (policy.ttlMs !== undefined) {
        for (const rec of activeRecords) {
          let ts = now;
          if (rec.at) {
            const parsed = Date.parse(rec.at);
            if (!Number.isNaN(parsed)) ts = parsed;
          } else if (rec.timestamp) {
            const parsed = typeof rec.timestamp === "number" ? rec.timestamp : Date.parse(String(rec.timestamp));
            if (!Number.isNaN(parsed)) ts = parsed;
          }
          if (now - ts > policy.ttlMs) {
            ttlCompliant = false;
            violations.push(`Record "${rec.id ?? 'unknown'}" exceeds TTL of ${policy.ttlMs}ms (age: ${now - ts}ms)`);
            break;
          }
        }
      }

      // 3. Capacity compliance check
      let capacityCompliant = true;
      if (policy.maxRecords !== undefined && activeRecords.length > policy.maxRecords) {
        capacityCompliant = false;
        violations.push(`Active records count (${activeRecords.length}) exceeds maximum limit (${policy.maxRecords})`);
      }

      // 4. Scrub compliance check
      let scrubCompliant = true;
      if (policy.scrubSensitiveFields !== false) {
        for (const rec of activeRecords) {
          if (containsUnredactedSensitiveValue(rec)) {
            scrubCompliant = false;
            violations.push(`Active record "${rec.id ?? 'unknown'}" contains unredacted sensitive operational fields`);
            break;
          }
        }
      }

      // 5. State digest computation (SHA-256)
      const sortedIds = activeRecords
        .map((r) => r.id ?? "")
        .filter(Boolean)
        .sort();
      const digestPayload = `${policy.recordKind}:${sortedIds.join(",")}:${deletedRecordIds.length}`;
      const stateDigest = createHash("sha256").update(digestPayload).digest("hex");

      const valid = violations.length === 0;

      return ok({
        recordKind: policy.recordKind,
        verifiedAt: new Date(now).toISOString(),
        verifiedBy: options.actor,
        deletedIdsCount: deletedRecordIds.length,
        activeRecordsCount: activeRecords.length,
        verifiedNonExistence: nonExistenceConfirmed,
        ttlCompliant,
        capacityCompliant,
        scrubCompliant,
        stateDigest,
        valid,
        violations
      });
    } catch {
      return err("verification_failed");
    }
  }

  /**
   * Executes retention sweep and verifies deletion and compliance (#400).
   *
   * Combines policy enforcement with cryptographic verification, returning
   * both sweep statistics and a tamper-evident verification proof.
   *
   * Time Complexity: O(N) where N is number of records.
   * Space Complexity: O(N) for record retention and verification proofs.
   */
  public static async enforceRetentionWithVerification<
    T extends { id?: string; at?: string; timestamp?: string | number | Date }
  >(
    records: readonly T[],
    policy: RetentionPolicy,
    options: DeletionOptions
  ): Promise<Result<RetentionEnforcementVerificationResult<T>, RetentionErrorCode>> {
    const sweepResult = await this.enforceRetention(records, policy, options);
    if (!sweepResult.ok) {
      return err(sweepResult.code);
    }

    const sweep = sweepResult.value;
    const retainedIds = new Set(sweep.retainedRecords.map((record) => record.id).filter(Boolean));
    const retainedSet = new Set(sweep.retainedRecords);
    const deletedIds: string[] = [];

    for (const r of records) {
      if (r.id && !retainedIds.has(r.id) && !retainedSet.has(r)) {
        deletedIds.push(r.id);
      }
    }

    const verificationResult = this.verifyDeletion(
      sweep.retainedRecords,
      deletedIds,
      policy,
      options
    );

    if (!verificationResult.ok) {
      return err(verificationResult.code);
    }

    if (!verificationResult.value.valid && !options.dryRun) {
      return err("verification_failed");
    }

    return ok({
      sweep,
      verification: verificationResult.value
    });
  }
}
