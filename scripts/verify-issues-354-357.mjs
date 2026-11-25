#!/usr/bin/env node
/**
 * Automated Verification Test Suite for Issues #354, #355, #356, #357
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #354: Build dry-run preview for destructive maintainer actions
 * - Issue #355: Implement signed webhook replay-window enforcement
 * - Issue #356: Add stale-cache detection with repair recommendations
 * - Issue #357: Create end-to-end failure injection for critical workflows
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-354-357.mjs
 */

import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #354, #355, #356, #357    ");
console.log("============================================================\n");

// -------------------------------------------------------------
// TEST 1: ISSUE #354 - Dry-Run Preview for Destructive Actions
// -------------------------------------------------------------
console.log("--> Testing Issue #354: Dry-Run Preview for Destructive Maintainer Actions...");
const { DestructiveActionPreviewEngine } = await import("../core/auth/destructive-preview.ts");

const maintainerKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10));
const viewerKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 20));
const baseTime = 1700000000000;
let currentTime = baseTime;

const previewEngine = new DestructiveActionPreviewEngine({
  now: () => currentTime
});

// 1. Normal Path: Generate pure dry-run preview
const previewResult = previewEngine.generatePreview({
  action: "emergency_killswitch",
  target: "horizon-proxy",
  parameters: { mode: "maintenance" },
  requestedBy: maintainerKey.publicKey(),
  liveStateSnapshot: { status: "active", trafficBlocked: false }
});

assert.equal(previewResult.ok, true, "Dry-run preview generation must succeed");
const preview = previewResult.value;
assert.equal(preview.action, "emergency_killswitch");
assert.equal(preview.riskLevel, "high");
assert.equal(preview.reversibility, "reversible");
assert.equal(preview.status, "valid");
assert.equal(preview.stateDelta.predictedAfterState.trafficBlocked, true);
assert.equal(preview.rollbackPlan.isAutomated, true);
assert.ok(preview.previewDigest.length === 64, "Must generate 64-char SHA-256 digest");

// 2. Authorization Path: Reject unauthorized actor role
const unauthResult = previewEngine.generatePreview(
  {
    action: "emergency_killswitch",
    target: "horizon-proxy",
    requestedBy: viewerKey.publicKey()
  },
  { role: "viewer", userId: "viewer-101" }
);
assert.equal(unauthResult.ok, false, "Must reject unauthorized viewer role");
assert.equal(unauthResult.code, "unauthorized_actor");

// 3. Failure Path: Validate required action parameters
const invalidParamResult = previewEngine.generatePreview({
  action: "batch_ticket_burn",
  target: "event-1",
  parameters: { ticketIds: [] },
  requestedBy: maintainerKey.publicKey()
});
assert.equal(invalidParamResult.ok, false, "Must fail validation on empty ticketIds");
assert.equal(invalidParamResult.code, "validation_failed");

// 4. Retry & Drift Protection Path: Detect live state divergence
const driftedVerification = previewEngine.verifyPreviewForExecution(
  preview.previewId,
  { status: "paused" }, // Drifted from { status: "active" }
  preview.previewDigest
);
assert.equal(driftedVerification.ok, false, "Must reject execution if live state drifted");
assert.equal(driftedVerification.code, "state_drift_detected");

// Clean verification matches
const cleanVerification = previewEngine.verifyPreviewForExecution(
  preview.previewId,
  { status: "active", trafficBlocked: false },
  preview.previewDigest
);
assert.equal(cleanVerification.ok, true, "Must accept execution when live state is untouched");

console.log("    [PASS] Issue #354: Dry-Run Preview for Destructive Actions verified\n");

// -------------------------------------------------------------
// TEST 2: ISSUE #355 - Signed Webhook Replay-Window Enforcement
// -------------------------------------------------------------
console.log("--> Testing Issue #355: Signed Webhook Replay-Window Enforcement...");
const { WebhookVerifier } = await import("../core/webhooks/verification.ts");

const webhookVerifier = new WebhookVerifier({
  replayWindowSeconds: 300,
  maxClockSkew: 60,
  nonceDeduplication: true
});
const webhookSecret = "whsec_test_secret_355";

// Register authorized subscriber
webhookVerifier.registerSubscriber({
  id: "sub-355",
  url: "https://partner.com/events",
  secret: webhookSecret,
  events: ["payment.settled"],
  active: true,
  createdAt: new Date(),
  failureCount: 0,
  successCount: 0
});

// 1. Normal Path: Verify fresh signed message
const webhookMessage = webhookVerifier.createSignedMessage(
  { event: "payment.settled", tx: "stellar-tx-1" },
  webhookSecret
);
const validResult = webhookVerifier.verifyReplayWindow(webhookMessage, webhookSecret, {
  now: webhookMessage.signature.timestamp
});
assert.equal(validResult.valid, true, "Fresh message must pass replay window verification");

// 2. Replay Failure Path: Replay attack with identical nonce rejected
const replayResult = webhookVerifier.verifyReplayWindow(webhookMessage, webhookSecret, {
  now: webhookMessage.signature.timestamp + 1
});
assert.equal(replayResult.valid, false, "Replayed nonce must be rejected");
assert.equal(replayResult.code, "replay_attack_detected");

// 3. Stale Window Failure Path: Message outside replay window rejected
const staleMessage = webhookVerifier.createSignedMessage({ event: "payment.settled" }, webhookSecret);
staleMessage.signature.timestamp = Math.floor(Date.now() / 1000) - 350;
const staleResult = webhookVerifier.verifyReplayWindow(staleMessage, webhookSecret);
assert.equal(staleResult.valid, false, "Stale message must be rejected");
assert.equal(staleResult.code, "replay_window_expired");

// 4. Authorization Path: Validate subscriber permissions
const authSuccess = webhookVerifier.verifySubscriberAuthorization("sub-355", "payment.settled", webhookSecret);
assert.equal(authSuccess.ok, true, "Authorized subscriber must pass check");

const authUnauthEvent = webhookVerifier.verifySubscriberAuthorization("sub-355", "admin.wipe", webhookSecret);
assert.equal(authUnauthEvent.ok, false, "Unsubscribed event must be denied");
assert.equal(authUnauthEvent.code, "unauthorized_event");

// 5. Retry Path: Exponential backoff calculation
const backoff1 = webhookVerifier.computeRetryBackoffMs(1, 1000, 30000);
assert.ok(backoff1 >= 2000, "Backoff for attempt 1 must be >= 2000ms");

console.log("    [PASS] Issue #355: Signed Webhook Replay-Window Enforcement verified\n");

// -------------------------------------------------------------
// TEST 3: ISSUE #356 - Stale-Cache Detection with Repair Recommendations
// -------------------------------------------------------------
console.log("--> Testing Issue #356: Stale-Cache Detection with Repair Recommendations...");
const { StaleProjectionDetector } = await import("../core/cache/stale-detector.ts");

const testCacheEntries = [
  {
    key: "cache:account:GA356",
    value: { balance: "500.00" },
    cachedAt: baseTime - 120000,
    ttlMs: 60000,
    version: 1,
    ledgerSequence: 49950
  }
];

const testIndexEntries = [
  {
    indexKey: "idx:orphan",
    targetId: "DELETED_ENTITY_356",
    indexedAt: baseTime - 1000,
    version: 1
  }
];

const inspectionCtx = {
  now: baseTime,
  currentSchemaVersion: 1,
  authoritativeLedgerSequence: 50000,
  primaryEntityIds: new Set(["cache:account:GA356"]),
  maxToleratedDriftLedgers: 5
};

// 1. Normal Path: Inspect and generate recommendations & dry-run preview
const inspection = StaleProjectionDetector.inspect(testCacheEntries, testIndexEntries, inspectionCtx);
assert.equal(inspection.clean, false, "Staleness must be detected");
assert.equal(inspection.staleCachesCount, 1);
assert.equal(inspection.staleIndexesCount, 1);

const previewRepair = StaleProjectionDetector.previewRepair(inspection.recommendations[0], testCacheEntries[0]);
assert.equal(previewRepair.action, "evict");
assert.equal(previewRepair.rollbackSupported, true);
assert.ok(previewRepair.previewDigest.length === 64, "Must compute preview digest");

// 2. Authorization Path: Enforce admin:recovery permission
const unauthRepair = StaleProjectionDetector.executeRepairAuthorized(
  inspection.recommendations[0],
  { onEvict: () => true },
  { role: "viewer", userId: "viewer-1" }
);
assert.equal(unauthRepair.success, false, "Must reject repair without admin:recovery role");
assert.equal(unauthRepair.errorCode, "permission_denied");

// 3. Execution & Failure Path: Handle handler failure and flag retryable
const failedRepair = StaleProjectionDetector.executeRepair(inspection.recommendations[0], {
  onEvict: () => {
    throw new Error("Simulated storage write timeout");
  }
});
assert.equal(failedRepair.success, false);
assert.equal(failedRepair.retryable, true, "Failed repair must be flagged as retryable");
assert.equal(failedRepair.errorCode, "handler_exception");

// 4. Rollback Path: Restore backup snapshot
let restored = false;
const rollbackRes = StaleProjectionDetector.rollbackRepair(
  testCacheEntries[0],
  {
    onRestoreCache: (entry) => {
      restored = entry.key === "cache:account:GA356";
      return true;
    }
  },
  { role: "maintainer", userId: "admin" }
);
assert.equal(rollbackRes.success, true);
assert.equal(restored, true, "Pre-repair snapshot must be restored");

console.log("    [PASS] Issue #356: Stale-Cache Detection & Repair Recommendations verified\n");

// -------------------------------------------------------------
// TEST 4: ISSUE #357 - End-to-End Failure Injection
// -------------------------------------------------------------
console.log("--> Testing Issue #357: End-to-End Failure Injection for Critical Workflows...");
const { FailureInjectionEngine } = await import("../core/testing/failure-injection.ts");

const failureEngine = new FailureInjectionEngine({
  now: () => currentTime
});

// 1. Authorization Path: Gate rule registration by role
const unauthRuleRes = failureEngine.registerRule(
  {
    id: "fault-unauth",
    workflow: "horizon",
    targetStep: "get_account",
    faultType: "http_error",
    enabled: true
  },
  { role: "viewer", userId: "viewer-1" }
);
assert.equal(unauthRuleRes.ok, false, "Viewer cannot register fault injection rules");
assert.equal(unauthRuleRes.code, "permission_denied");

// Authorized registration succeeds
const authRuleRes = failureEngine.registerRule(
  {
    id: "fault-retry-demo",
    workflow: "critical_payment",
    targetStep: "submit_payment",
    faultType: "http_error",
    faultConfig: { status: 429, message: "Horizon Rate Limit (429)" },
    condition: { triggerAttempt: 1 }, // Fails only attempt 1, recovers on retry
    enabled: true
  },
  { role: "maintainer", userId: "maintainer-admin" }
);
assert.equal(authRuleRes.ok, true, "Maintainer can register fault rules");

// 2. Failure Path: Attempt 1 triggers injected fault
let attempt1Failed = false;
try {
  await failureEngine.wrapAsync("critical_payment", "submit_payment", async () => "ok");
} catch (err) {
  attempt1Failed = true;
  assert.ok(err.message.includes("Horizon Rate Limit (429)"));
}
assert.equal(attempt1Failed, true, "Attempt 1 must fail under failure injection");

// 3. Retry Path: Attempt 2 recovers automatically
const attempt2Result = await failureEngine.wrapAsync("critical_payment", "submit_payment", async () => "ok_recovered");
assert.equal(attempt2Result, "ok_recovered", "Attempt 2 must succeed on retry");

// 4. Storage wrapping resilience
const inMemory = new Map();
const wrappedStorage = failureEngine.wrapStorage(
  {
    read: (k) => inMemory.get(k),
    write: (rec) => {
      inMemory.set(rec.id, rec);
      return true;
    }
  },
  "storage_workflow"
);

failureEngine.registerRule({
  id: "storage-write-fault",
  workflow: "storage_workflow",
  targetStep: "storage_write",
  faultType: "storage_fault",
  faultConfig: { message: "Disk full" },
  enabled: true
});

assert.throws(() => {
  wrappedStorage.write({ id: "rec-1", kind: "test", status: "pending", createdAt: "", updatedAt: "", history: [] });
}, /Disk full/);
assert.equal(inMemory.has("rec-1"), false, "Uncommitted state must not leak after storage fault");

console.log("    [PASS] Issue #357: End-to-End Failure Injection verified\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#354, #355, #356, #357) VERIFIED [PASS]    ");
console.log("============================================================");

