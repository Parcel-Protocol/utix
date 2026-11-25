/**
 * Retention enforcement for sensitive metadata (#retention-sensitive-metadata)
 *
 * Covers retention lifecycle specifically for high-sensitivity metadata kinds:
 *   admin_config_audit  — events produced by admin-config changes
 *   compliance_snapshot — compliance snapshot envelopes
 *   audit_event         — raw audit events exported for review
 *
 * Tests verify:
 *   Normal path   — TTL expiry, maxRecords cap, sensitive-field scrub
 *   Failure path  — policy validation, reason validation, transient errors
 *   Retry path    — recovery after transient failure, retry exhaustion
 *   Authorization — maintainer and system actors allowed; user actors denied
 *
 * Edge cases and recovery / rollback notes
 * ─────────────────────────────────────────
 * • Records are sorted by timestamp ascending before the maxRecords cap is
 *   applied, so the OLDEST records are dropped first (FIFO eviction). This
 *   ensures the most recent evidence is always preserved.
 *
 * • TTL eviction uses the record's `at` field (ISO-8601). Records without a
 *   recognisable timestamp are treated as "now" and are always retained — this
 *   is intentionally conservative (do not delete what you cannot date).
 *
 * • `scrubSensitiveFields: true` redacts in-place values whose keys match the
 *   sensitive-key pattern (secret, key, token, password, auth, credential,
 *   bearer, cookie, seed, passphrase) and embedded Stellar secrets / Bearer
 *   tokens in string values. The scrub happens before retention decisions so
 *   that even retained records cannot carry live secrets.
 *
 * • `dryRun: true` previews deletions without committing them: retainedRecords
 *   equals the full input, and dryRun is true in the result.
 *
 * • On retry exhaustion the caller should:
 *     1. Log the error with enough context to identify the record batch.
 *     2. Wait for the backing storage to recover (the backing store is external
 *        to this module; this module does not own the rollback).
 *     3. Re-invoke enforceRetention with the same policy and options. Because
 *        no records are mutated until the call succeeds (all-or-nothing), no
 *        partial state can accumulate.
 *
 * • If a retention sweep is interrupted mid-flight (process crash), it can
 *   be re-run safely: `enforceRetention` is idempotent over its input — it
 *   reads the records but never writes them back; the caller owns the actual
 *   deletion. Re-running simply re-computes the same decision.
 *
 * Contract preservation
 * ──────────────────────
 * Tests use only the public API:
 *   core/audit/retention — OperationalDataRetentionManager, scrubSensitiveValue,
 *                          RetentionPolicy, DeletionOptions, RetentionSweepResult
 *
 * The `RetentionSweepResult` shape, `RetentionErrorCode` literals, and
 * authorization semantics (user = denied; maintainer / system = allowed)
 * are part of the public contract and must not regress.
 */

import { describe, expect, it } from "vitest";
import {
  OperationalDataRetentionManager,
  scrubSensitiveValue,
  type DeletionOptions,
  type RetentionPolicy
} from "../retention";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const maintainer = { kind: "maintainer" as const, id: "ada" };
const system = { kind: "system" as const };
const user = { kind: "user" as const, id: "viewer-1" };

/** Fake admin_config audit-event metadata records. */
const adminConfigAuditRecords = [
  {
    id: "acfg-ev-1",
    at: "2026-01-10T00:00:00.000Z",
    action: "admin.config_changed",
    outcome: "allowed",
    target: "network.endpoint",
    actor: "ada",
    before: "https://horizon-testnet.stellar.org",
    after: "https://horizon-mainnet.stellar.org",
    apiKey: "sk-secret-12345"
  },
  {
    id: "acfg-ev-2",
    at: "2026-06-01T00:00:00.000Z",
    action: "admin.config_changed",
    outcome: "denied",
    target: "network.endpoint",
    actor: "viewer-1",
    errorCode: "admin_config_not_allowed",
    bearerToken: "Bearer eyJhbGciOiJIUzI1NiJ9.test"
  },
  {
    id: "acfg-ev-3",
    at: "2026-10-20T00:00:00.000Z",
    action: "admin.config_changed",
    outcome: "allowed",
    target: "role.default",
    actor: "bob"
  }
];

/** Fake compliance_snapshot metadata records. */
const complianceSnapshotRecords = [
  {
    id: "snap-1",
    at: "2026-01-05T00:00:00.000Z",
    eventId: "evt-001",
    event: "admin.config_changed",
    integrityHash: "abc123",
    schemaVersion: 1,
    internalSecret: "SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKDIOHGZPFGDPGQVC4TUKWGLW"
  },
  {
    id: "snap-2",
    at: "2026-09-01T00:00:00.000Z",
    eventId: "evt-002",
    event: "authorization.granted",
    integrityHash: "def456",
    schemaVersion: 1
  },
  {
    id: "snap-3",
    at: "2026-10-20T00:00:00.000Z",
    eventId: "evt-003",
    event: "freeze.bypassed",
    integrityHash: "ghi789",
    schemaVersion: 1
  }
];

/** Fake audit_event export metadata. */
const auditEventExportRecords = [
  {
    id: "aexp-1",
    at: "2026-02-01T00:00:00.000Z",
    format: "ndjson",
    rowCount: 42,
    exportedBy: "ada",
    authToken: "Bearer export-token-secret-xyz"
  },
  {
    id: "aexp-2",
    at: "2026-08-15T00:00:00.000Z",
    format: "csv",
    rowCount: 15,
    exportedBy: "bob"
  },
  {
    id: "aexp-3",
    at: "2026-10-21T00:00:00.000Z",
    format: "json",
    rowCount: 7,
    exportedBy: "ada"
  }
];

// ── Normal path ───────────────────────────────────────────────────────────────

describe("retention — admin_config_audit records — normal path", () => {
  it("drops records exceeding the TTL, retains the recent one", async () => {
    const fixedNow = Date.parse("2026-10-22T00:00:00.000Z");
    const policy: RetentionPolicy = {
      recordKind: "admin_config_audit",
      ttlMs: 60 * 24 * 60 * 60 * 1000, // 60 days
      scrubSensitiveFields: false
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      policy,
      { actor: maintainer, reason: "scheduled_retention_sweep", now: () => fixedNow }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalScanned).toBe(3);
    expect(result.value.retainedCount).toBe(1);
    expect(result.value.deletedCount).toBe(2);
    expect(result.value.retainedRecords[0].id).toBe("acfg-ev-3");
    expect(result.value.dryRun).toBe(false);
  });

  it("caps to maxRecords, keeping the most recent by timestamp", async () => {
    const policy: RetentionPolicy = {
      recordKind: "admin_config_audit",
      maxRecords: 2,
      scrubSensitiveFields: false
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      policy,
      { actor: maintainer, reason: "capacity_cap" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.retainedCount).toBe(2);
    expect(result.value.deletedCount).toBe(1);
    // oldest dropped first
    expect(result.value.retainedRecords.map((r) => r.id)).toEqual(["acfg-ev-2", "acfg-ev-3"]);
  });

  it("scrubs sensitive fields (apiKey, bearerToken) in retained records", async () => {
    const policy: RetentionPolicy = {
      recordKind: "admin_config_audit",
      maxRecords: 10,
      scrubSensitiveFields: true
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      policy,
      { actor: maintainer, reason: "scrub_sweep" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.scrubbedFieldsCount).toBeGreaterThanOrEqual(1);
    const records = result.value.retainedRecords as typeof adminConfigAuditRecords;
    expect(records.find((r) => r.id === "acfg-ev-1")!.apiKey).toBe("[REDACTED]");
    expect(records.find((r) => r.id === "acfg-ev-2")!.bearerToken).toBe("[REDACTED]");
    // Non-sensitive fields are preserved.
    expect(records.find((r) => r.id === "acfg-ev-1")!.outcome).toBe("allowed");
  });

  it("dryRun previews deletions without committing them", async () => {
    const policy: RetentionPolicy = {
      recordKind: "admin_config_audit",
      maxRecords: 1
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      policy,
      { actor: maintainer, reason: "dry_run_preview", dryRun: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.dryRun).toBe(true);
    expect(result.value.retainedCount).toBe(3); // nothing deleted in dryRun
    expect(result.value.deletedCount).toBe(2);  // how many *would* be deleted
    expect(result.value.retainedRecords).toHaveLength(3);
  });
});

describe("retention — compliance_snapshot records — normal path", () => {
  it("drops snapshots by TTL and retains only the recent one", async () => {
    const fixedNow = Date.parse("2026-10-22T00:00:00.000Z");
    const policy: RetentionPolicy = {
      recordKind: "compliance_snapshot",
      ttlMs: 45 * 24 * 60 * 60 * 1000, // 45 days
      scrubSensitiveFields: true
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      policy,
      { actor: maintainer, reason: "snapshot_retention_sweep", now: () => fixedNow }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalScanned).toBe(3);
    expect(result.value.retainedCount).toBe(1);
    expect(result.value.retainedRecords[0].id).toBe("snap-3");
  });

  it("scrubs an embedded Stellar secret in a compliance snapshot field", async () => {
    const policy: RetentionPolicy = {
      recordKind: "compliance_snapshot",
      maxRecords: 10,
      scrubSensitiveFields: true
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      policy,
      { actor: maintainer, reason: "secret_scrub_sweep" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snap1 = result.value.retainedRecords.find((r) => r.id === "snap-1") as typeof complianceSnapshotRecords[0];
    // The field name `internalSecret` matches the sensitive-key pattern.
    expect((snap1 as Record<string, unknown>)["internalSecret"]).toBe("[REDACTED]");
    // Non-sensitive fields are preserved.
    expect(snap1.schemaVersion).toBe(1);
    expect(snap1.eventId).toBe("evt-001");
  });

  it("maxRecords=1 retains only the most recent snapshot", async () => {
    const policy: RetentionPolicy = {
      recordKind: "compliance_snapshot",
      maxRecords: 1
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      policy,
      { actor: system, reason: "cron_snapshot_cap" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.retainedCount).toBe(1);
    expect(result.value.retainedRecords[0].id).toBe("snap-3");
    expect(result.value.deletedCount).toBe(2);
  });
});

describe("retention — audit_event_export records — normal path", () => {
  it("enforces TTL on export metadata records", async () => {
    const fixedNow = Date.parse("2026-10-22T00:00:00.000Z");
    const policy: RetentionPolicy = {
      recordKind: "audit_event_export",
      ttlMs: 90 * 24 * 60 * 60 * 1000, // 90 days
      scrubSensitiveFields: true
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      auditEventExportRecords,
      policy,
      { actor: maintainer, reason: "export_meta_ttl_sweep", now: () => fixedNow }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalScanned).toBe(3);
    // aexp-1 (Feb) is > 90 days old; aexp-2 and aexp-3 are within 90 days.
    expect(result.value.retainedCount).toBe(2);
    expect(result.value.deletedCount).toBe(1);
    expect(result.value.retainedRecords.map((r) => r.id)).toEqual(["aexp-2", "aexp-3"]);
  });

  it("scrubs Bearer tokens embedded in export metadata fields", async () => {
    const policy: RetentionPolicy = {
      recordKind: "audit_event_export",
      maxRecords: 10,
      scrubSensitiveFields: true
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      auditEventExportRecords,
      policy,
      { actor: maintainer, reason: "auth_token_scrub" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const aexp1 = result.value.retainedRecords.find((r) => r.id === "aexp-1") as typeof auditEventExportRecords[0];
    expect(aexp1.authToken).toBe("[REDACTED]");
    expect(aexp1.format).toBe("ndjson");
    expect(aexp1.rowCount).toBe(42);
  });
});

// ── Authorization path ────────────────────────────────────────────────────────

describe("retention — sensitive metadata — authorization path", () => {
  it("denies enforceRetention to a user actor on admin_config_audit records", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      { recordKind: "admin_config_audit", maxRecords: 10 },
      { actor: user, reason: "unauthorized_attempt" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("retention_denied");
  });

  it("denies enforceRetention to a user actor on compliance_snapshot records", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      { recordKind: "compliance_snapshot", maxRecords: 10 },
      { actor: user, reason: "unauthorized_snapshot_purge" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("retention_denied");
  });

  it("denies purgeSensitiveOperationalData to a user actor", () => {
    const result = OperationalDataRetentionManager.purgeSensitiveOperationalData(
      adminConfigAuditRecords,
      () => true,
      { actor: user, reason: "unauthorized_purge" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("retention_denied");
  });

  it("allows a system actor to perform retention sweeps on audit_event_export records", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      auditEventExportRecords,
      { recordKind: "audit_event_export", maxRecords: 5 },
      { actor: system, reason: "automated_cron_retention" }
    );

    expect(result.ok).toBe(true);
  });

  it("allows a maintainer actor to purge compliance_snapshot records matching a predicate", () => {
    const result = OperationalDataRetentionManager.purgeSensitiveOperationalData(
      complianceSnapshotRecords,
      (rec) => rec.event === "admin.config_changed",
      { actor: maintainer, reason: "targeted_config_purge" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.purgedCount).toBe(1);
    expect(result.value.remainingRecords).toHaveLength(2);
    expect(result.value.remainingRecords.some((r) => r.event === "admin.config_changed")).toBe(false);
  });
});

// ── Failure path ──────────────────────────────────────────────────────────────

describe("retention — sensitive metadata — failure path", () => {
  it("returns invalid_policy when recordKind is empty", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      { recordKind: "" },
      { actor: maintainer, reason: "check" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_policy");
  });

  it("returns invalid_policy when recordKind is whitespace only", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      { recordKind: "   " },
      { actor: maintainer, reason: "check" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_policy");
  });

  it("returns invalid_deletion_request when reason is blank", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      { recordKind: "admin_config_audit" },
      { actor: maintainer, reason: "   " }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_deletion_request");
  });

  it("returns invalid_deletion_request when reason is empty string", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      { recordKind: "compliance_snapshot" },
      { actor: system, reason: "" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_deletion_request");
  });

  it("purgeSensitiveOperationalData returns invalid_deletion_request on blank reason", () => {
    const result = OperationalDataRetentionManager.purgeSensitiveOperationalData(
      auditEventExportRecords,
      () => true,
      { actor: maintainer, reason: "  " }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_deletion_request");
  });

  it("maxRecords: 0 retains nothing — deleted count equals total scanned", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      { recordKind: "admin_config_audit", maxRecords: 0 },
      { actor: maintainer, reason: "purge_all" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.retainedCount).toBe(0);
    expect(result.value.deletedCount).toBe(3);
    expect(result.value.retainedRecords).toHaveLength(0);
  });

  it("empty input set produces a zero-count result without error", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      [],
      { recordKind: "admin_config_audit", maxRecords: 10 },
      { actor: maintainer, reason: "empty_sweep" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalScanned).toBe(0);
    expect(result.value.retainedCount).toBe(0);
    expect(result.value.deletedCount).toBe(0);
  });
});

// ── Retry path ────────────────────────────────────────────────────────────────

describe("retention — sensitive metadata — retry path", () => {
  it("recovers after transient failures within maxRetries", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      { recordKind: "admin_config_audit", maxRecords: 10 },
      {
        actor: maintainer,
        reason: "retry_recovery_test",
        maxRetries: 3,
        simulateTransientFailures: 2,
        retryBackoffMs: 5
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalScanned).toBe(3);
    expect(result.value.retainedCount).toBe(3);
  });

  it("exhausts retries and returns retention_retries_exhausted", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      { recordKind: "compliance_snapshot", maxRecords: 10 },
      {
        actor: maintainer,
        reason: "retry_exhaustion_test",
        maxRetries: 2,
        simulateTransientFailures: 10, // more failures than retries
        retryBackoffMs: 5
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("retention_retries_exhausted");
  });

  it("re-running after exhaustion succeeds when no transient failures are injected", async () => {
    // Simulate: first run exhausts, then the caller re-runs the same sweep without failure injection.
    const failRun = await OperationalDataRetentionManager.enforceRetention(
      auditEventExportRecords,
      { recordKind: "audit_event_export", maxRecords: 10 },
      {
        actor: maintainer,
        reason: "export_meta_retry_test",
        maxRetries: 1,
        simulateTransientFailures: 5,
        retryBackoffMs: 1
      }
    );
    expect(failRun.ok).toBe(false);

    // Recovery run — no simulated failures.
    const recoveryRun = await OperationalDataRetentionManager.enforceRetention(
      auditEventExportRecords,
      { recordKind: "audit_event_export", maxRecords: 10 },
      { actor: maintainer, reason: "export_meta_retry_test" }
    );

    expect(recoveryRun.ok).toBe(true);
    if (!recoveryRun.ok) return;

    expect(recoveryRun.value.totalScanned).toBe(3);
    expect(recoveryRun.value.retainedCount).toBe(3);
  });

  it("dryRun is preserved correctly through a successful retry", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      { recordKind: "admin_config_audit", maxRecords: 1 },
      {
        actor: maintainer,
        reason: "dry_run_retry_test",
        dryRun: true,
        maxRetries: 2,
        simulateTransientFailures: 1,
        retryBackoffMs: 5
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.dryRun).toBe(true);
    expect(result.value.retainedRecords).toHaveLength(3); // dryRun: no actual deletion
  });
});

// ── Edge cases: cross-kind isolation and sensitive-field scrub ────────────────

describe("retention — sensitive metadata — edge cases", () => {
  it("compliance_snapshot scrub does not touch integrityHash or schemaVersion fields", async () => {
    const policy: RetentionPolicy = {
      recordKind: "compliance_snapshot",
      maxRecords: 10,
      scrubSensitiveFields: true
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      policy,
      { actor: maintainer, reason: "verify_non_sensitive_preserved" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const record of result.value.retainedRecords) {
      expect(typeof record.integrityHash).toBe("string");
      expect(typeof record.schemaVersion).toBe("number");
      expect(record.eventId).toBeTruthy();
    }
  });

  it("admin_config_audit scrub does not alter id, action, outcome, or target fields", async () => {
    const policy: RetentionPolicy = {
      recordKind: "admin_config_audit",
      maxRecords: 10,
      scrubSensitiveFields: true
    };

    const result = await OperationalDataRetentionManager.enforceRetention(
      adminConfigAuditRecords,
      policy,
      { actor: maintainer, reason: "verify_identity_fields_preserved" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const record of result.value.retainedRecords) {
      expect(record.id).toBeTruthy();
      expect(record.action).toBe("admin.config_changed");
      expect(["allowed", "denied"]).toContain(record.outcome);
    }
  });

  it("retaining maxRecords=0 and dryRun=true returns all records with 0 retained", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      complianceSnapshotRecords,
      { recordKind: "compliance_snapshot", maxRecords: 0 },
      { actor: maintainer, reason: "zero_cap_dry_run", dryRun: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // dryRun overrides: retainedRecords = all original records, but deletedCount reflects what WOULD happen.
    expect(result.value.dryRun).toBe(true);
    expect(result.value.retainedRecords).toHaveLength(3);
    expect(result.value.deletedCount).toBe(3);
  });

  it("records without an `at` field are treated as current and are always retained by TTL", async () => {
    const recordsWithoutAt = [
      { id: "no-ts-1", action: "admin.config_changed", outcome: "allowed" },
      { id: "no-ts-2", action: "admin.config_changed", outcome: "denied" }
    ];

    const fixedNow = Date.parse("2026-10-22T00:00:00.000Z");
    const result = await OperationalDataRetentionManager.enforceRetention(
      recordsWithoutAt,
      {
        recordKind: "admin_config_audit",
        ttlMs: 1, // 1 ms TTL — anything older than "now" should be dropped
        scrubSensitiveFields: false
      },
      { actor: maintainer, reason: "no_timestamp_test", now: () => fixedNow }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Records without `at` are treated as `now`, so now - now = 0 <= 1ms TTL → retained.
    expect(result.value.retainedCount).toBe(2);
  });

  it("purgeSensitiveOperationalData in dryRun keeps all records but reports purgedCount", () => {
    const result = OperationalDataRetentionManager.purgeSensitiveOperationalData(
      auditEventExportRecords,
      (rec) => rec.format === "csv",
      { actor: maintainer, reason: "dry_run_purge_test", dryRun: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.purgedCount).toBe(1);
    expect(result.value.remainingRecords).toHaveLength(3); // dryRun: original slice returned
  });

  it("scrubSensitiveValue handles deeply nested object in a compliance snapshot payload", () => {
    const deep = {
      outer: {
        inner: {
          apiToken: "token-should-be-redacted",
          safe: "this is fine"
        }
      },
      surfaceLevel: "also fine"
    };

    const { scrubbed, modified } = scrubSensitiveValue(deep);
    expect(modified).toBe(true);
    const result = scrubbed as typeof deep;
    expect(result.outer.inner.apiToken).toBe("[REDACTED]");
    expect(result.outer.inner.safe).toBe("this is fine");
    expect(result.surfaceLevel).toBe("also fine");
  });

  it("retention result reports recordKind matching the policy input", async () => {
    for (const recordKind of ["admin_config_audit", "compliance_snapshot", "audit_event_export"]) {
      const result = await OperationalDataRetentionManager.enforceRetention(
        [],
        { recordKind },
        { actor: maintainer, reason: "kind_label_check" }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recordKind).toBe(recordKind);
    }
  });

  it("durationMs in result is a non-negative number", async () => {
    const result = await OperationalDataRetentionManager.enforceRetention(
      auditEventExportRecords,
      { recordKind: "audit_event_export", maxRecords: 10 },
      { actor: maintainer, reason: "duration_check" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });
});
