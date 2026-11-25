#!/usr/bin/env node
/**
 * Automated Verification Suite for Issues #455, #460, #461, #462
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #455: Implement bounded cache invalidation and stale detection
 * - Issue #460: Create local contributor diagnostics command
 * - Issue #461: Implement explainable risk scoring for high-impact actions
 * - Issue #462: Add release gate for migrations and recovery evidence
 *
 * Each issue verifies:
 * 1. Normal path
 * 2. Failure path
 * 3. Retry path
 * 4. Authorization path
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-455-462.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #455, #460, #461, #462    ");
console.log("============================================================\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #455: Bounded Cache Invalidation and Stale Detection
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #455: Bounded Cache Invalidation and Stale Detection...");

const { createBoundedCache } = await import("../core/cache/bounded-cache.ts");
const { StaleProjectionDetector } = await import("../core/cache/stale-detector.ts");

const MAINTAINER_AUTH = { role: "maintainer", permissions: ["admin:recovery"] };
const VIEWER_AUTH = { role: "viewer", permissions: [] };

// 1. Normal Path: Bounded capacity & LRU eviction
let mockClock = 1_700_000_000_000;
const boundedCache = createBoundedCache({
  maxEntries: 3,
  ttlMs: 5_000,
  now: () => mockClock,
  name: "test.bounded"
});

boundedCache.set("key1", "val1", { ledgerSequence: 100, sourceEntityId: "entity-A" });
boundedCache.set("key2", "val2", { ledgerSequence: 101, sourceEntityId: "entity-A" });
boundedCache.set("key3", "val3", { ledgerSequence: 102, sourceEntityId: "entity-B" });

assert.equal(boundedCache.stats().size, 3, "#455 cache size must be 3");
assert.deepEqual(boundedCache.get("key1"), { ok: true, value: "val1" }, "#455 normal read succeeds");

// LRU eviction on adding 4th item (key2 was least recently read)
boundedCache.set("key4", "val4", { ledgerSequence: 103, sourceEntityId: "entity-C" });
assert.equal(boundedCache.stats().size, 3, "#455 bound must hold at maxEntries=3");
assert.deepEqual(boundedCache.get("key2"), { ok: false, code: "cache_miss" }, "#455 LRU key2 must be evicted");

// 2. Failure Path: Expired TTL, ledger stale reads, and stale writes
mockClock += 6_000;
assert.deepEqual(boundedCache.get("key1"), { ok: false, code: "cache_expired" }, "#455 expired key must return cache_expired");

mockClock = 1_700_000_000_000;
boundedCache.set("ledger-key", "fresh", { ledgerSequence: 200 });
// Read behind head is stale
assert.deepEqual(
  boundedCache.get("ledger-key", { minLedgerSequence: 205 }),
  { ok: false, code: "cache_stale" },
  "#455 read requiring higher ledger sequence must return cache_stale"
);

// Stale out-of-order write rejection
const staleWriteRes = boundedCache.set("ledger-key", "old", { ledgerSequence: 190 });
assert.deepEqual(staleWriteRes, { ok: false, code: "cache_stale_write" }, "#455 out-of-order stale write must be rejected");

// 3. Retry Path: getOrLoad retries on transient error, does not cache failure
let loadAttempts = 0;
const flakyLoader = async () => {
  loadAttempts++;
  if (loadAttempts === 1) return { ok: false, code: "network_timeout" };
  return { ok: true, value: "retried_success" };
};

const firstLoad = await boundedCache.getOrLoad("retry-key", flakyLoader);
assert.equal(firstLoad.ok, false, "#455 first flaky load must fail");
assert.equal(boundedCache.get("retry-key").ok, false, "#455 failed load must not be cached");

const secondLoad = await boundedCache.getOrLoad("retry-key", flakyLoader);
assert.equal(secondLoad.ok, true, "#455 second load must succeed via retry");
assert.equal(secondLoad.value, "retried_success");
assert.deepEqual(boundedCache.get("retry-key"), { ok: true, value: "retried_success" });

// 4. Authorization Path: evictStale & entity invalidation
boundedCache.set("ent-1", "v1", { sourceEntityId: "tenant-X" });
boundedCache.set("ent-2", "v2", { sourceEntityId: "tenant-X" });
const invalidatedCount = boundedCache.invalidateEntity("tenant-X");
assert.equal(invalidatedCount, 2, "#455 entity invalidation drops all associated records");

const unauthorizedEvict = boundedCache.evictStale(VIEWER_AUTH, "maintenance sweep");
assert.deepEqual(unauthorizedEvict, { ok: false, code: "cache_unauthorized" }, "#455 unauthorized evictStale rejected");

const authorizedEvict = boundedCache.evictStale(MAINTAINER_AUTH, "maintenance sweep");
assert.equal(authorizedEvict.ok, true, "#455 authorized evictStale succeeds");

console.log("    [PASS] Issue #455: Bounded Cache Invalidation and Stale Detection verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #460: Local Contributor Diagnostics Command
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #460: Local Contributor Diagnostics Command...");

const { runDiagnostics } = await import("../core/diagnostics/diagnostics.ts");
const { DIAGNOSTICS_RUN_PERMISSION } = await import("../core/diagnostics/types.ts");

// 1. Authorization Path: missing actor or missing permission
const missingActorReport = await runDiagnostics({ projectRoot: root });
assert.equal(missingActorReport.authorization.allowed, false, "#460 missing actor must not be allowed");
assert.equal(missingActorReport.authorization.reason, "missing_actor");
assert.equal(missingActorReport.checks.length, 0, "#460 unauthorized run must not execute checks");

const unauthorizedActorReport = await runDiagnostics({
  projectRoot: root,
  actor: { kind: "contributor", id: "guest-user", permissions: [] }
});
assert.equal(unauthorizedActorReport.authorization.allowed, false, "#460 actor without permission must not be allowed");
assert.equal(unauthorizedActorReport.authorization.reason, "missing_permission");

// 2. Normal Path: authorized actor runs diagnostics
const authorizedActor = {
  kind: "maintainer",
  id: "maintainer-1",
  permissions: [DIAGNOSTICS_RUN_PERMISSION]
};

const fullReport = await runDiagnostics({
  projectRoot: root,
  actor: authorizedActor
});

assert.equal(fullReport.authorization.allowed, true, "#460 authorized run must succeed");
assert.ok(fullReport.checks.length >= 5, "#460 should execute standard diagnostic checks");
assert.ok(["healthy", "degraded", "failing"].includes(fullReport.overallStatus));
assert.ok(fullReport.summary.total >= 5);

// 3. Failure & Strict Mode Path: strict mode converts warnings into overall failure
const strictReport = await runDiagnostics({
  projectRoot: root,
  strict: true,
  actor: authorizedActor
});

if (strictReport.summary.warnings > 0) {
  assert.equal(strictReport.overallStatus, "failing", "#460 strict mode must elevate warnings to failure");
}

// 4. Retry Path: diagnostics options support configurable retries and delays
const retryOptionsReport = await runDiagnostics({
  projectRoot: root,
  actor: authorizedActor,
  maxAttempts: 2,
  retryDelayMs: 10
});
assert.equal(retryOptionsReport.authorization.allowed, true, "#460 retry-configured options run successfully");

console.log("    [PASS] Issue #460: Local Contributor Diagnostics Command verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #461: Explainable Risk Scoring for High-Impact Actions
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #461: Explainable Risk Scoring for High-Impact Actions...");

const {
  DEFAULT_TRANSFER_RISK_POLICY,
  assessTransferRisk,
  explainRiskAssessment,
  explainRiskAssessmentForActor
} = await import("../core/transfer-risk/policy.ts");

const NOW = 1_800_000_000_000;
const riskContext = { now: NOW, deviceId: "device-test-1" };

function baseDomainState() {
  const ticket = {
    id: "ticket-1",
    eventId: "event-1",
    tierId: "general",
    ownerAddress: "alice-key",
    priceStroops: 1000,
    status: "issued",
    issuedAt: NOW - 86_400_000,
    validFrom: NOW + 3_600_000,
    validUntil: NOW + 7_200_000,
    fraudFlag: false,
    nonce: 0,
    metadataHash: ""
  };
  return {
    events: new Map([["event-1", { id: "event-1", organizerAddress: "org-key", totalCapacity: 50, issuedCount: 1, status: "active", feeBasisPoints: 0 }]]),
    tickets: new Map([[ticket.id, ticket]]),
    transfers: [],
    processedNonces: new Set(),
    blacklistedAddresses: new Set()
  };
}

function baseTransferRequest(overrides = {}) {
  return {
    id: "xfer-1",
    ticketId: "ticket-1",
    fromAddress: "alice-key",
    toAddress: "bob-key",
    priceStroops: 1000,
    organizerFeeStroops: 50,
    protocolFeeStroops: 50,
    sellerProceedsStroops: 900,
    nonce: "nonce-1",
    ...overrides
  };
}

// 1. Normal Path: clean assessment explains disposition "allow"
const normalAssessment = assessTransferRisk(baseDomainState(), baseTransferRequest(), riskContext);
const normalExplanation = explainRiskAssessment(normalAssessment, DEFAULT_TRANSFER_RISK_POLICY);

assert.equal(normalExplanation.disposition, "allow", "#461 normal transfer allowed");
assert.equal(normalExplanation.score, 0, "#461 clean transfer score is 0");
assert.equal(normalExplanation.signals.length, 0);
assert.equal(normalExplanation.explanations.length, 0);
assert.ok(normalExplanation.summary.includes("allow"), "#461 summary explains allow");

// 2. Failure Path: invalid risk context handles safely without leaking internal thresholds
const invalidCtxAssessment = assessTransferRisk(baseDomainState(), baseTransferRequest(), {
  policy: { ...DEFAULT_TRANSFER_RISK_POLICY, reviewScore: -1 }
});
const invalidExplanation = explainRiskAssessment(invalidCtxAssessment, DEFAULT_TRANSFER_RISK_POLICY);
assert.equal(invalidExplanation.code, "invalid_risk_context", "#461 invalid context flagged");
assert.ok(invalidExplanation.summary.includes("invalid"), "#461 invalid context summary explains failure");

// 3. Retry Path: repeated attempts in retry window triggers repeated_attempts signal
const repeatedAttempts = Array.from({ length: 4 }, (_, i) => ({
  id: `attempt-${i}`,
  request: baseTransferRequest({ id: `att-${i}`, nonce: `n-${i}` }),
  ticketVersion: 0,
  submittedAt: NOW - 500 + i,
  status: "completed",
  score: 0,
  signals: [],
  deviceId: "device-test-1"
}));

const stateWithAttempts = {
  ...baseDomainState(),
  transferRisk: { attempts: repeatedAttempts, audit: [] }
};
const retryAssessment = assessTransferRisk(
  stateWithAttempts,
  baseTransferRequest(),
  { ...riskContext, policy: { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 3 } }
);
const retryExplanation = explainRiskAssessment(retryAssessment, { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 3 });
assert.ok(retryAssessment.signals.includes("repeated_attempts"), "#461 repeated attempts signal detected");
const attemptExplanation = retryExplanation.explanations.find((e) => e.signal === "repeated_attempts");
assert.ok(attemptExplanation, "#461 per-signal explanation generated for repeated_attempts");
assert.equal(attemptExplanation.weight, 40);
assert.ok(attemptExplanation.description.includes("retry window"));

// 4. Authorization Path: explainRiskAssessmentForActor enforces role-based disclosure
const maintainerActor = { role: "maintainer", id: "staff-1" };
const attendeeActor = { role: "attendee", id: "user-123" };

const privilegedView = explainRiskAssessmentForActor(retryAssessment, maintainerActor);
assert.ok("policyThresholds" in privilegedView, "#461 privileged actor sees policyThresholds");
assert.ok("explanations" in privilegedView, "#461 privileged actor sees signal explanations");

const sanitizedView = explainRiskAssessmentForActor(retryAssessment, attendeeActor);
assert.equal(sanitizedView.isSanitized, true, "#461 unprivileged actor receives sanitized view");
assert.equal("policyThresholds" in sanitizedView, false, "#461 unprivileged actor does NOT see policyThresholds");
assert.equal("explanations" in sanitizedView, false, "#461 unprivileged actor does NOT see signal weights");
assert.ok(sanitizedView.summary.includes("administrative review"), "#461 sanitized summary is informative but safe");

console.log("    [PASS] Issue #461: Explainable Risk Scoring for High-Impact Actions verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #462: Release Gate for Migrations and Recovery Evidence
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #462: Release Gate for Migrations and Recovery Evidence...");

const {
  MigrationReleaseReadinessVerifier,
  verifyMigrationReleaseGate
} = await import("../core/migration/release-readiness.ts");

const maintainerReleaseActor = { role: "maintainer", userId: "rel-mgr-1" };
const guestReleaseActor = { role: "guest", userId: "guest-1" };

const validMigration = {
  id: "20261122_release_gate_v4",
  name: "Add recovery evidence metadata to ledger partitions",
  description: "Upgrades migration partition metadata from v3 to v4",
  fromVersion: 3,
  toVersion: 4,
  riskLevel: "medium",
  rollbackNotes: "Revert partition schema using snapshot snap_v3_state and verify row checksums",
  forwardFixNotes: "Apply patch schema script 20261122_patch_partitions to backfill empty rows",
  dryRun: (records) => ({
    migrationId: "20261122_release_gate_v4",
    targetVersion: 4,
    totalRecords: records.length,
    affectedCount: records.length,
    unchangedCount: 0,
    sampleDiffs: [],
    riskLevel: "medium",
    rollbackNotes: "Revert partition schema",
    forwardFixNotes: "Apply patch script",
    estimatedDurationMs: 80
  }),
  apply: async (records) => records.map((r) => ({ ...r, version: 4 }))
};

// 1. Authorization Path: unauthorized actor rejected before inspection
const unauthorizedGateReport = await verifyMigrationReleaseGate(
  {
    releaseId: "rel-test-unauth",
    targetVersion: 4,
    migrations: [validMigration]
  },
  guestReleaseActor
);

assert.equal(unauthorizedGateReport.ready, false, "#462 guest actor must not be ready");
assert.equal(unauthorizedGateReport.status, "UNAUTHORIZED", "#462 guest actor status must be UNAUTHORIZED");
assert.equal(unauthorizedGateReport.rollbackEvidence.length, 0);

// 2. Normal Path: authorized actor evaluates valid plan, produces recovery evidence
const authorizedGateReport = await verifyMigrationReleaseGate(
  {
    releaseId: "rel-test-auth",
    targetVersion: 4,
    migrations: [validMigration],
    snapshotId: "snap-valid-v3",
    snapshotData: { partitionCount: 12, rows: 48000 }
  },
  maintainerReleaseActor
);

assert.equal(authorizedGateReport.ready, true, "#462 authorized release plan must be approved");
assert.equal(authorizedGateReport.status, "APPROVED");
assert.equal(authorizedGateReport.rollbackEvidence.length, 1, "#462 must produce 1 rollback evidence bundle");
const evidence = authorizedGateReport.rollbackEvidence[0];
assert.equal(evidence.migrationId, validMigration.id);
assert.equal(evidence.fromVersion, 3);
assert.equal(evidence.toVersion, 4);
assert.ok(evidence.rollbackScriptHash.length === 64, "#462 rollback script hash must be SHA-256");
assert.ok(evidence.snapshotChecksum.length === 64, "#462 snapshot checksum must be SHA-256");
assert.ok(evidence.evidenceId.length > 0);

// 3. Failure Path: missing rollback notes causes rejection
const flawedMigration = {
  ...validMigration,
  id: "20261122_flawed_v4",
  rollbackNotes: "" // Missing rollback notes
};

const failedGateReport = await verifyMigrationReleaseGate(
  {
    releaseId: "rel-test-flawed",
    targetVersion: 4,
    migrations: [flawedMigration]
  },
  maintainerReleaseActor
);

assert.equal(failedGateReport.ready, false, "#462 plan missing rollback notes must be rejected");
assert.equal(failedGateReport.status, "REJECTED");
assert.ok(failedGateReport.discrepancies?.some((d) => d.includes("rollback procedure")));

// 4. Retry Path: readiness probes with transient failures retry and succeed
let probeAttempts = 0;
const retryableProbe = {
  name: "storage_snapshot_connectivity",
  check: () => {
    probeAttempts++;
    return probeAttempts >= 2; // Fails attempt 1, passes attempt 2
  },
  retryable: true
};

const probeReport = await verifyMigrationReleaseGate(
  {
    releaseId: "rel-test-probe",
    targetVersion: 4,
    migrations: [validMigration],
    probes: [retryableProbe],
    maxRetries: 3,
    initialBackoffMs: 5
  },
  maintainerReleaseActor
);

assert.equal(probeReport.ready, true, "#462 probe retried and release approved");
assert.equal(probeAttempts, 2, "#462 probe must have retried twice");

console.log("    [PASS] Issue #462: Release Gate for Migrations and Recovery Evidence verified\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#455, #460, #461, #462) VERIFIED [PASS]    ");
console.log("============================================================");
