#!/usr/bin/env node
/**
 * Automated Verification Test Suite for Issues #344, #345, #350, #351
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #344: Implement deterministic duplicate detection and merge review
 * - Issue #345: Add high-cardinality telemetry redaction and sampling
 * - Issue #350: Add deterministic rollback tests for failed external side effects
 * - Issue #351: Implement bounded batch processing for large datasets
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-344-351.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #344, #345, #350, #351    ");
console.log("============================================================\n");

// -------------------------------------------------------------
// TEST 1: ISSUE #350 - Deterministic Rollback for External Side Effects
// -------------------------------------------------------------
console.log("--> Testing Issue #350: Deterministic Rollback for Failed External Side Effects...");
const {
  createOperationStorage,
  runOperation,
  rollbackOperation,
  rollbackOperationAuthorized,
  createSideEffectDispatcher
} = await import("../core/operations/index.ts");

const opStorage = createOperationStorage();
const compensationLog = [];
const idempotencyKeysUsed = [];

const multiStepFlow = {
  kind: "stellar_payment_and_escrow",
  steps: [
    {
      id: "reserve_escrow",
      run: () => ({ status: "succeeded", output: { escrowId: "esc-1" }, committed: true }),
      rollback: (input) => {
        compensationLog.push("unreserve_escrow");
        idempotencyKeysUsed.push(input.idempotencyKey);
        return { status: "rolled_back", output: { unreserved: true } };
      }
    },
    {
      id: "lock_collateral",
      run: () => ({ status: "succeeded", output: { collateralId: "col-1" }, committed: true }),
      rollback: (input) => {
        compensationLog.push("unlock_collateral");
        idempotencyKeysUsed.push(input.idempotencyKey);
        return { status: "rolled_back", output: { unlocked: true } };
      }
    },
    {
      id: "submit_payment",
      run: () => ({ status: "failed", errorCode: "upstream_tx_rejected", committed: false })
    }
  ]
};

const opOpts = {
  operationId: "op-verify-350",
  context: { amount: 100 },
  storage: opStorage,
  now: () => 1_700_000_000_000,
  newCorrelationId: () => "corr-350"
};

// 1. Initial execution fails at step 3
const runOutcome = await runOperation(multiStepFlow, opOpts);
assert.equal(runOutcome.ok, true, "runOperation should return ok Result containing failure progress");
assert.equal(runOutcome.value.state, "failed");
assert.equal(runOutcome.value.errorCode, "upstream_tx_rejected");

// 2. Authorization check on rollback: viewer denied, maintainer allowed
const viewerAuth = { role: "viewer", userId: "user-v" };
const maintainerAuth = { role: "maintainer", userId: "admin-m" };

const deniedRollback = await rollbackOperationAuthorized(viewerAuth, multiStepFlow, opOpts);
assert.equal(deniedRollback.ok, false);
assert.equal(deniedRollback.code, "permission_denied");

// 3. Rollback executes compensations in reverse order (LIFO)
const rollbackOutcome = await rollbackOperationAuthorized(maintainerAuth, multiStepFlow, opOpts, "upstream_tx_rejected");
assert.equal(rollbackOutcome.ok, true, "Rollback must succeed");
assert.deepEqual(compensationLog, ["unlock_collateral", "unreserve_escrow"], "Compensation must execute in LIFO order");
assert.equal(idempotencyKeysUsed[0], "operation:op-verify-350:step:lock_collateral:rollback");
assert.equal(idempotencyKeysUsed[1], "operation:op-verify-350:step:reserve_escrow:rollback");

// 4. Verify SideEffectDispatcher rollback
const dispatchStoreMap = new Map();
const dispatchStore = {
  read: (id) => dispatchStoreMap.get(id),
  write: (job) => void dispatchStoreMap.set(job.id, job),
  list: () => [...dispatchStoreMap.values()]
};
const dispatcher = createSideEffectDispatcher({
  store: dispatchStore,
  maxAttempts: 2,
  newId: () => "dispatch-job-350"
});

const dispatched = dispatcher.submit({
  operation: "transfer.submit",
  idempotencyKey: "tx-side-effect-key-1",
  payload: { amount: 500 }
});
await dispatcher.run(dispatched.job.id, () => {});

let undoCalls = 0;
const rbDispatcher = await dispatcher.rollbackAuthorized(maintainerAuth, "dispatch-job-350", async () => {
  undoCalls++;
});
assert.equal(rbDispatcher.ok, true);
assert.equal(undoCalls, 1);
assert.equal(dispatchStore.read("dispatch-job-350").status, "rolled_back");

console.log("    [PASS] Issue #350 verified: Deterministic Rollback for Failed External Side Effects\n");

// -------------------------------------------------------------
// TEST 2: ISSUE #351 - Bounded Batch Processing for Large Datasets
// -------------------------------------------------------------
console.log("--> Testing Issue #351: Bounded Batch Processing for Large Datasets...");
const {
  processBoundedBatch,
  processBoundedBatchAuthorized,
  rollbackBatch,
  rollbackBatchAuthorized,
  createMemoryCheckpointStore,
  validateBatchOptions
} = await import("../core/batch/index.ts");

// 1. Validation checks
assert.equal(validateBatchOptions({ batchSize: 0 }).ok, false);
assert.equal(validateBatchOptions({ batchSize: 1001 }).ok, false);
assert.equal(validateBatchOptions({ maxConcurrency: 0 }).ok, false);
assert.equal(validateBatchOptions({ maxConcurrency: 25 }).ok, false);

// 2. Normal batch run with memory checkpoint store
const batchItems = Array.from({ length: 150 }, (_, i) => ({
  id: `batch-item-${i + 1}`,
  value: (i + 1) * 2
}));

const batchCheckpointStore = createMemoryCheckpointStore();
const processedItemsLog = [];

const batchProcessor = {
  processItem: (item) => {
    processedItemsLog.push(item.id);
    return { ok: true, value: item.value };
  },
  rollbackItem: (item) => {
    const idx = processedItemsLog.indexOf(item.id);
    if (idx !== -1) processedItemsLog.splice(idx, 1);
  }
};

const batchResult = await processBoundedBatch("job-verify-351", batchItems, batchProcessor, {
  batchSize: 50,
  maxConcurrency: 5,
  checkpointStore: batchCheckpointStore
});

assert.equal(batchResult.ok, true);
assert.equal(batchResult.value.totalItems, 150);
assert.equal(batchResult.value.processedCount, 150);
assert.equal(batchResult.value.succeededCount, 150);
assert.equal(batchResult.value.batchesCount, 3);
assert.equal(batchResult.value.status, "completed");

// 3. Authorization check
const authBatchDenied = await processBoundedBatchAuthorized(viewerAuth, "job-auth-351", batchItems.slice(0, 5), batchProcessor);
assert.equal(authBatchDenied.ok, false);
assert.equal(authBatchDenied.code, "permission_denied");

const authBatchAllowed = await processBoundedBatchAuthorized(maintainerAuth, "job-auth-351", batchItems.slice(0, 5), batchProcessor);
assert.equal(authBatchAllowed.ok, true);

// 4. Batch Rollback check
const rbBatch = await rollbackBatchAuthorized(maintainerAuth, "job-verify-351", batchItems, batchResult.value.results, batchProcessor, {
  checkpointStore: batchCheckpointStore
});
assert.equal(rbBatch.ok, true);
assert.equal(rbBatch.value.rolledBackCount, 150);

console.log("    [PASS] Issue #351 verified: Bounded Batch Processing for Large Datasets\n");

// -------------------------------------------------------------
// TEST 3: ISSUE #345 - High-Cardinality Telemetry Redaction & Sampling
// -------------------------------------------------------------
console.log("--> Testing Issue #345: High-Cardinality Telemetry Redaction & Sampling...");
const {
  protectTelemetry,
  configureTelemetryProtectionAuthorized,
  createProtectionSnapshot,
  restoreProtectionSnapshot,
  resetTelemetryProtection
} = await import("../core/telemetry/protection.ts");

resetTelemetryProtection();

// 1. Secret scrubbing and high-cardinality normalization
const protectedTelemetry = protectTelemetry({
  op: "horizon.payment_submit",
  secretSeed: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  apiToken: "Bearer secret-token-xyz",
  txHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  correlationId: "12345678-1234-1234-1234-123456789abc"
});

assert.equal(protectedTelemetry.sampled, true);
assert.equal(protectedTelemetry.event.secretSeed, "[REDACTED]");
assert.equal(protectedTelemetry.event.apiToken, "[REDACTED]");
assert.equal(protectedTelemetry.event.txHash, "[HIGH_CARDINALITY_TRUNCATED]");
assert.equal(protectedTelemetry.event.correlationId, "[HIGH_CARDINALITY_TRUNCATED]");

// 2. 100% Failure capture guarantee even at 0% sample rate
const failureSample = protectTelemetry(
  { op: "auth.check", result: "failure", errorCode: "bad_signature" },
  { sampleRate: 0.0, priorityFailureSampling: true }
);
assert.equal(failureSample.sampled, true, "Failure events must NEVER be dropped by sampling");

// 3. Authorization check and rollback snapshots
const telemetryAuthDenied = configureTelemetryProtectionAuthorized(viewerAuth, { sampleRate: 0.1 });
assert.equal(telemetryAuthDenied.ok, false);
assert.equal(telemetryAuthDenied.code, "permission_denied");

const snapBefore = createProtectionSnapshot();
const telemetryAuthAllowed = configureTelemetryProtectionAuthorized(maintainerAuth, { sampleRate: 0.25 });
assert.equal(telemetryAuthAllowed.ok, true);
assert.equal(createProtectionSnapshot().sampleRate, 0.25);

restoreProtectionSnapshot(snapBefore);
assert.equal(createProtectionSnapshot().sampleRate, undefined);

console.log("    [PASS] Issue #345 verified: High-Cardinality Telemetry Redaction & Sampling\n");

// -------------------------------------------------------------
// TEST 4: ISSUE #344 - Deterministic Duplicate Detection & Merge Review
// -------------------------------------------------------------
console.log("--> Testing Issue #344: Deterministic Duplicate Detection & Merge Review...");
const {
  createMergePlan,
  applyReview,
  applyReviewAuthorized,
  rollbackReview,
  rollbackReviewAuthorized
} = await import("../features/duplicate-transaction-scanner/lib/review.ts");

const candidateGroup = {
  id: "fp-group-344",
  fingerprint: {
    value: "fp-group-344",
    sourceAccount: "GAA...SOURCE",
    opTypesSorted: ["payment"],
    feeCharged: "100",
    memoType: "none",
    memo: "",
    network: "testnet",
    timeBucket: 1000
  },
  transactions: [
    {
      hash: "2222222222222222222222222222222222222222222222222222222222222222",
      sourceAccount: "GAA...SOURCE",
      feeCharged: "100",
      memoType: "none",
      memo: "",
      createdAt: "2026-10-21T10:05:00.000Z",
      operationTypes: ["payment"],
      ledger: 5002,
      successful: true
    },
    {
      hash: "1111111111111111111111111111111111111111111111111111111111111111",
      sourceAccount: "GAA...SOURCE",
      feeCharged: "100",
      memoType: "none",
      memo: "",
      createdAt: "2026-10-21T10:00:00.000Z",
      operationTypes: ["payment"],
      ledger: 5001,
      successful: true
    }
  ],
  state: "pending"
};

// 1. Merge plan generation with deterministic primary selection
const mergePlan = createMergePlan(candidateGroup);
assert.equal(mergePlan.groupId, "fp-group-344");
assert.equal(mergePlan.primaryTransaction.ledger, 5001, "Earliest ledger must be selected as primary");
assert.equal(mergePlan.primaryTransaction.hash, "1111111111111111111111111111111111111111111111111111111111111111");
assert.equal(mergePlan.duplicateTransactions.length, 1);
assert.ok(mergePlan.confidenceScore >= 0.85);

// 2. Authorization check on review
const reviewDenied = applyReviewAuthorized(viewerAuth, candidateGroup, {
  groupId: candidateGroup.id,
  action: "confirm",
  actorId: "viewer-1"
});
assert.equal(reviewDenied.ok, false);
assert.equal(reviewDenied.code, "permission_denied");

const reviewAllowed = applyReviewAuthorized(maintainerAuth, candidateGroup, {
  groupId: candidateGroup.id,
  action: "confirm",
  actorId: "admin-1"
});
assert.equal(reviewAllowed.ok, true);
assert.equal(reviewAllowed.value.state, "confirmed");

// 3. Rollback of review decision
const rbReviewDenied = rollbackReviewAuthorized(viewerAuth, reviewAllowed.value, { actorId: "viewer-1" });
assert.equal(rbReviewDenied.ok, false);
assert.equal(rbReviewDenied.code, "permission_denied");

const rbReviewAllowed = rollbackReviewAuthorized(maintainerAuth, reviewAllowed.value, { actorId: "admin-1" });
assert.equal(rbReviewAllowed.ok, true);
assert.equal(rbReviewAllowed.value.state, "deferred");

console.log("    [PASS] Issue #344 verified: Deterministic Duplicate Detection & Merge Review\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#344, #345, #350, #351) VERIFIED SUCCESSFULLY");
console.log("============================================================\n");

