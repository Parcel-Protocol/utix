#!/usr/bin/env node
/**
 * Automated Verification Test Suite for Issues #365, #366, #367, #369
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #365: Add strict input size and cardinality limits
 * - Issue #366: Build cross-service event schema drift detection
 * - Issue #367: Implement ownership transfer with expiry and audit history
 * - Issue #369: Create incident runbook with executable recovery checks
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-365-369.mjs
 */

import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #365, #366, #367, #369    ");
console.log("============================================================\n");

// -------------------------------------------------------------
// TEST 1: ISSUE #365 - Strict Input Size & Cardinality Limits
// -------------------------------------------------------------
console.log("--> Testing Issue #365: Strict Input Size and Cardinality Limits...");
const {
  defaultInputLimiter,
  DEFAULT_MAX_COLLECTION_SIZE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_STRING_LENGTH,
  HARD_CEILING_MAX_BYTES
} = await import("../core/schema/limits.ts");

// 1. Normal Path: Inputs within strict bounds
const normalPayload = {
  endpoint: "https://horizon-testnet.stellar.org",
  accounts: ["GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"],
  options: { timeout: 3000, active: true }
};
const normalResult = defaultInputLimiter.enforceLimits(normalPayload);
assert.equal(normalResult.ok, true, "Valid input within bounds must pass");

// 2. Failure Path: Cardinality exceeded
const oversizedArray = new Array(DEFAULT_MAX_COLLECTION_SIZE + 20).fill("test-item");
const cardResult = defaultInputLimiter.enforceLimits({ list: oversizedArray });
assert.equal(cardResult.ok, false, "Array exceeding cardinality must be rejected");
assert.equal(cardResult.code, "cardinality_exceeded");

// 3. Failure Path: Nesting depth exceeded (AST bomb defense)
let deeplyNested = { val: "end" };
for (let i = 0; i < DEFAULT_MAX_DEPTH + 5; i++) {
  deeplyNested = { next: deeplyNested };
}
const depthResult = defaultInputLimiter.enforceLimits(deeplyNested);
assert.equal(depthResult.ok, false, "Deeply nested AST bomb must be rejected");
assert.equal(depthResult.code, "nesting_depth_exceeded");

// 4. Failure Path: Prototype pollution attack
const prototypeAttack = JSON.parse('{"__proto__": {"injected": true}}');
const protoResult = defaultInputLimiter.enforceLimits(prototypeAttack);
assert.equal(protoResult.ok, false, "Prototype property injection must be rejected");
assert.equal(protoResult.code, "disallowed_key_detected");

// 5. Authorization Path: Maintainer elevated limit
const maintainerAuth = { actor: { kind: "maintainer", id: "ops-lead" } };
const userAuth = { actor: { kind: "user", id: "user-1" } };
const elevatedArray = new Array(700).fill("entry");

const userOverride = defaultInputLimiter.enforceLimits(
  { data: elevatedArray },
  { maxCollectionSize: 1000 },
  userAuth
);
assert.equal(userOverride.ok, false, "Non-maintainer override must be refused");
assert.equal(userOverride.code, "unauthorized_override");

const maintainerOverride = defaultInputLimiter.enforceLimits(
  { data: elevatedArray },
  { maxCollectionSize: 1000 },
  maintainerAuth
);
assert.equal(maintainerOverride.ok, true, "Maintainer override within ceiling must be allowed");

// 6. Retry & Recovery Path: Truncation & Slicing
const oversizedCollection = { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
const sanitized = defaultInputLimiter.sanitizeOrTruncate(oversizedCollection, { maxCollectionSize: 5 });
assert.equal(sanitized.truncated, true);
assert.equal(sanitized.droppedItemsCount, 5);
assert.equal(sanitized.sanitized.items.length, 5);

const slicing = defaultInputLimiter.suggestSlicing(1500, 500);
assert.equal(slicing.recommendedBatchSize, 500);
assert.equal(slicing.totalChunks, 3);

console.log("    [PASS] Issue #365: Strict Input Size & Cardinality Limits verified\n");

// -------------------------------------------------------------
// TEST 2: ISSUE #366 - Cross-Service Event Schema Drift Detection
// -------------------------------------------------------------
console.log("--> Testing Issue #366: Cross-Service Event Schema Drift Detection...");
const { defaultDriftDetector } = await import("../core/contract/drift-detector.ts");

// 1. Normal Path: Clean event payload validation
const validTelemetry = {
  op: "horizon.request",
  actorType: "user",
  result: "success",
  latencyMs: 35,
  correlationId: "corr-issue-366",
  timestamp: new Date().toISOString()
};
const telemetryDrift = defaultDriftDetector.detectDrift("telemetry.event", validTelemetry, {
  producer: "core/telemetry"
});
assert.equal(telemetryDrift.ok, true, "Valid telemetry event must pass drift detection");
assert.equal(telemetryDrift.value.compatible, true);
assert.equal(telemetryDrift.value.hasBreakingDrift, false);

// 2. Failure Path: Missing required field
const invalidTelemetry = {
  op: "horizon.request",
  actorType: "user",
  result: "success",
  // latencyMs missing
  correlationId: "corr-issue-366",
  timestamp: new Date().toISOString()
};
const missingFieldResult = defaultDriftDetector.detectDrift("telemetry.event", invalidTelemetry);
assert.equal(missingFieldResult.ok, false);
assert.equal(missingFieldResult.code, "contract_drift_breaking");

// 3. Authorization Path: Producer boundary enforcement
const unauthorizedProducerResult = defaultDriftDetector.detectDrift("telemetry.event", validTelemetry, {
  producer: "unauthorized/third-party"
});
assert.equal(unauthorizedProducerResult.ok, false);
assert.equal(unauthorizedProducerResult.code, "unauthorized_producer");

// Maintainer override on producer
const maintainerDrift = defaultDriftDetector.detectDrift("telemetry.event", validTelemetry, {
  producer: "unauthorized/third-party",
  actor: { kind: "maintainer", id: "admin-1" }
});
assert.equal(maintainerDrift.ok, true, "Maintainer should be permitted to test or simulate events");

// 4. Retry & Recovery: detectDriftWithRetry & compareSchemas
let transientAttempts = 0;
const transientSupplier = async () => {
  transientAttempts += 1;
  if (transientAttempts < 2) return { op: "in_flight" };
  return validTelemetry;
};
const retryDriftResult = await defaultDriftDetector.detectDriftWithRetry("telemetry.event", transientSupplier, {
  maxRetries: 3,
  backoffMs: 5
});
assert.equal(retryDriftResult.ok, true);
assert.equal(transientAttempts, 2);

const schemaDiff = defaultDriftDetector.compareSchemas(
  { version: "1.0", fields: { id: { type: "string", required: true } } },
  { version: "1.1", fields: { id: { type: "string", required: true }, extra: { type: "string", required: false } } }
);
assert.equal(schemaDiff.compatible, true);

console.log("    [PASS] Issue #366: Cross-Service Event Schema Drift Detection verified\n");

// -------------------------------------------------------------
// TEST 3: ISSUE #367 - Ownership Transfer with Expiry & Audit History
// -------------------------------------------------------------
console.log("--> Testing Issue #367: Ownership Transfer with Expiry and Audit History...");
const { createOwnershipStore } = await import("../core/ownership/ownership.ts");
const { getAuditTrail } = await import("../core/audit/audit.ts");

const ownershipStore = createOwnershipStore();
getAuditTrail().reset();

const keyA = Keypair.random();
const keyB = Keypair.random();
const ownerA = keyA.publicKey();
const recipientB = keyB.publicKey();
const baseTime = 1700000000000;

// 1. Normal Path: Propose -> Audit History Created
const proposeRes = ownershipStore.initiate({
  resourceId: "vault-42",
  resourceType: "vault",
  currentOwner: ownerA,
  proposedOwner: recipientB,
  expiresInMs: 3600_000,
  memo: "Handoff to recipient B",
  actor: { kind: "user", id: ownerA },
  now: baseTime
});
assert.equal(proposeRes.ok, true, "Initiation must succeed");
const proposalId = proposeRes.value.id;

// Verify transfer audit history
const history1 = ownershipStore.getTransferAuditHistory(proposalId);
assert.equal(history1.length, 1);
assert.equal(history1[0].action, "proposed");
assert.equal(history1[0].fromOwner, ownerA);
assert.equal(history1[0].toOwner, recipientB);

// 2. Normal Path: Accept -> Chained Audit Event
const acceptRes = ownershipStore.accept({
  transferId: proposalId,
  actor: { kind: "user", id: recipientB },
  now: baseTime + 60_000
});
assert.equal(acceptRes.ok, true, "Acceptance must succeed");

const history2 = ownershipStore.getTransferAuditHistory(proposalId);
assert.equal(history2.length, 2);
assert.equal(history2[1].action, "accepted");
assert.notEqual(history2[1].auditDigest, history2[0].auditDigest);

// Verify audit history cryptographic integrity
const integrityCheck = ownershipStore.verifyAuditHistoryIntegrity(proposalId);
assert.equal(integrityCheck.ok, true);
assert.equal(integrityCheck.value.verified, true);
assert.equal(integrityCheck.value.eventCount, 2);

// 3. Expiry and Sweep Path
const expiredProposalRes = ownershipStore.initiate({
  resourceId: "vault-expiring",
  resourceType: "vault",
  currentOwner: ownerA,
  proposedOwner: recipientB,
  expiresInMs: 60_000,
  actor: { kind: "user", id: ownerA },
  now: baseTime
});
assert.equal(expiredProposalRes.ok, true);

const swept = ownershipStore.sweepExpired(baseTime + 120_000);
assert.equal(swept, 1, "Exactly 1 proposal should be swept");
const sweepHistory = ownershipStore.getTransferAuditHistory(expiredProposalRes.value.id);
assert.equal(sweepHistory.some((h) => h.action === "swept"), true);

// Verify global audit trail
const globalAudit = getAuditTrail().all();
assert.equal(globalAudit.some((a) => a.action === "ownership.transfer.proposed"), true);
assert.equal(globalAudit.some((a) => a.action === "ownership.transfer.accepted"), true);

console.log("    [PASS] Issue #367: Ownership Transfer with Expiry & Audit History verified\n");

// -------------------------------------------------------------
// TEST 4: ISSUE #369 - Incident Runbook with Executable Recovery Checks
// -------------------------------------------------------------
console.log("--> Testing Issue #369: Incident Runbook with Executable Recovery Checks...");
const { incidentRunbook, registerDefaultProcedures } = await import("../core/incident/runbook.ts");

incidentRunbook.reset();
registerDefaultProcedures();
getAuditTrail().reset();

// 1. Normal Path: Executable recovery checks pass and mitigate incident
const incident1 = incidentRunbook.createIncident({
  severity: "critical",
  title: "Horizon Outage Simulation",
  description: "Primary node failover drill",
  affectedSystems: ["horizon-client", "balance-viewer"]
});

incidentRunbook.setRollbackPlan(incident1.id, {
  targetVersion: "v1.2.0",
  estimatedDuration: 5,
  backupLocation: "s3://backups/snapshot.json",
  communicationScript: "Failover complete",
  validationSteps: [
    {
      name: "RPC connectivity test",
      rollbackOnFailure: true,
      check: async () => true
    },
    {
      name: "Account balance read test",
      rollbackOnFailure: true,
      check: async () => true
    }
  ]
});

const recoveryResult = await incidentRunbook.executeRecoveryChecks(incident1.id, {
  actor: { kind: "operator", id: "ops-engineer" }
});
assert.equal(recoveryResult.ok, true, "Recovery checks must pass");
assert.equal(recoveryResult.value.passed, true);
assert.equal(recoveryResult.value.status, "passed");
assert.equal(recoveryResult.value.executedChecks.length, 2);
assert.equal(recoveryResult.value.rollbackTriggered, false);
assert.equal(recoveryResult.value.auditReceipt.length, 64);

const updatedInc1 = incidentRunbook.getIncident(incident1.id);
assert.equal(updatedInc1.status, "mitigated");

// 2. Failure Path: Failing check triggers rollback
const incident2 = incidentRunbook.createIncident({
  severity: "high",
  title: "State Drift Simulation",
  description: "Unhealthy replica detected",
  affectedSystems: ["sequence-inspector"]
});

incidentRunbook.setRollbackPlan(incident2.id, {
  targetVersion: "v1.0.0",
  estimatedDuration: 2,
  backupLocation: "s3://backups/v1.json",
  communicationScript: "Reverting",
  validationSteps: [
    {
      name: "Strict sequence check",
      rollbackOnFailure: true,
      check: async () => false // FAILS
    }
  ]
});

const failingResult = await incidentRunbook.executeRecoveryChecks(incident2.id, {
  actor: { kind: "operator", id: "ops-engineer" },
  abortOnFirstFailure: true
});
assert.equal(failingResult.ok, false);
assert.equal(failingResult.code, "rollback_execution_failed");

const updatedInc2 = incidentRunbook.getIncident(incident2.id);
assert.equal(updatedInc2.status, "investigating");

// 3. Authorization Path: User actor rejected
const unauthorizedResult = await incidentRunbook.executeRecoveryChecks(incident1.id, {
  actor: { kind: "user", id: "public-client" }
});
assert.equal(unauthorizedResult.ok, false);
assert.equal(unauthorizedResult.code, "unauthorized_operator");

// 4. Retry Path: Transient failure passes on retry
let attemptCount = 0;
const incident3 = incidentRunbook.createIncident({
  severity: "medium",
  title: "Transient Flakiness Drill",
  description: "Network jitter simulation",
  affectedSystems: ["horizon-client"]
});

incidentRunbook.setRollbackPlan(incident3.id, {
  targetVersion: "v1.0.0",
  estimatedDuration: 1,
  backupLocation: "s3://backups/net.json",
  communicationScript: "Checking",
  validationSteps: [
    {
      name: "Flaky network check",
      rollbackOnFailure: true,
      check: async () => {
        attemptCount += 1;
        return attemptCount >= 2;
      }
    }
  ]
});

const retryRecoveryResult = await incidentRunbook.executeRecoveryChecks(incident3.id, {
  actor: { kind: "operator", id: "ops-engineer" },
  maxRetries: 3,
  retryBackoffMs: 5
});
assert.equal(retryRecoveryResult.ok, true);
assert.equal(retryRecoveryResult.value.executedChecks[0].attempts, 2);

console.log("    [PASS] Issue #369: Incident Runbook with Executable Recovery Checks verified\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#365, #366, #367, #369) VERIFIED [PASS]    ");
console.log("============================================================");

