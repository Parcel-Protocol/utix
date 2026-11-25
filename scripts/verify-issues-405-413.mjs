#!/usr/bin/env node
/**
 * Automated Executable Verification Suite for Issues #405, #406, #407, #413
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #405: Implement ownership transfer acceptance and expiry
 * - Issue #406: Add deployment rollback verification checks
 * - Issue #407: Build permission-diff preview before policy changes
 * - Issue #413: Build privacy-safe export with field-level authorization
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-405-413.mjs
 */

import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #405, #406, #407, #413    ");
console.log("============================================================\n");

// =========================================================================
// ISSUE #405: Ownership Transfer Acceptance and Expiry
// =========================================================================
console.log("--> Testing Issue #405: Ownership Transfer Acceptance and Expiry...");
const {
  OwnershipTransferStore,
  MIN_EXPIRY_MS,
  MAX_EXPIRY_MS
} = await import("../core/ownership/ownership.ts");
const { createIdempotencyStore } = await import("../core/idempotency/idempotency.ts");

const store = new OwnershipTransferStore(createIdempotencyStore());
const owner = { kind: "user", id: "account:GALICE1234567890" };
const recipient = { kind: "user", id: "account:GBOB1234567890" };
const thirdParty = { kind: "user", id: "account:GEVE1234567890" };
const maintainer = { kind: "maintainer", id: "maintainer:ADMIN" };

// 1. Normal Path: Propose and Accept with State Settlement
const now = 1_700_000_000_000;
const proposeRes = store.initiate({
  resourceId: "batch-405-01",
  resourceType: "ticket_batch",
  currentOwner: owner.id,
  proposedOwner: recipient.id,
  actor: owner,
  expiresInMs: 3_600_000,
  now
});
assert.equal(proposeRes.ok, true, "Propose must succeed for current owner");
const proposal = proposeRes.value;
assert.equal(proposal.status, "pending", "Status must be pending");
assert.equal(store.getActiveTransferForResource("ticket_batch", "batch-405-01", now)?.id, proposal.id);

const acceptRes = store.accept({
  transferId: proposal.id,
  actor: recipient,
  now: now + 60_000
});
assert.equal(acceptRes.ok, true, "Accept must succeed for recipient");
assert.equal(acceptRes.value.status, "accepted", "Status must transition to accepted");
assert.equal(store.getActiveTransferForResource("ticket_batch", "batch-405-01", now + 60_000), null, "Active pointer must be cleared");

// 2. Failure Path: Invalid Recipient, Self Transfer, Settled Re-accept
const selfTransfer = store.initiate({
  resourceId: "res-self",
  currentOwner: owner.id,
  proposedOwner: owner.id,
  actor: owner
});
assert.equal(selfTransfer.ok, false, "Self transfer must fail");
assert.equal(selfTransfer.code, "cannot_transfer_to_self");

const reAccept = store.accept({
  transferId: proposal.id,
  actor: recipient
});
assert.equal(reAccept.ok, false, "Already settled transfer re-accept must fail");
assert.equal(reAccept.code, "transfer_already_settled");

// 3. Authorization Path: Non-recipient cannot accept; Non-owner cannot initiate
const unauthPropose = store.initiate({
  resourceId: "res-unauth",
  currentOwner: owner.id,
  proposedOwner: recipient.id,
  actor: thirdParty
});
assert.equal(unauthPropose.ok, false, "Third party cannot initiate transfer");
assert.equal(unauthPropose.code, "unauthorized_not_owner");

const propForAuth = store.initiate({
  resourceId: "res-auth-test",
  currentOwner: owner.id,
  proposedOwner: recipient.id,
  actor: owner
});
assert.equal(propForAuth.ok, true);
const unauthAccept = store.accept({
  transferId: propForAuth.value.id,
  actor: thirdParty
});
assert.equal(unauthAccept.ok, false, "Third party cannot accept transfer");
assert.equal(unauthAccept.code, "unauthorized_not_recipient");

// 4. Expiry and Batch Sweep Path
const expiredPropose = store.initiate({
  resourceId: "res-exp-test",
  currentOwner: owner.id,
  proposedOwner: recipient.id,
  actor: owner,
  expiresInMs: 60_000,
  now
});
assert.equal(expiredPropose.ok, true);
const sweptCount = store.sweepExpired(now + 120_000);
assert.equal(sweptCount >= 1, true, "Expired proposal must be swept");
assert.equal(store.getTransfer(expiredPropose.value.id, now + 120_000)?.status, "expired");

// 5. Retry and Idempotency Path
const idemPropose1 = store.initiate({
  resourceId: "res-idem",
  currentOwner: owner.id,
  proposedOwner: recipient.id,
  actor: owner,
  idempotencyKey: "idem-key-405-test"
});
assert.equal(idemPropose1.ok, true);
const idemPropose2 = store.initiate({
  resourceId: "res-idem",
  currentOwner: owner.id,
  proposedOwner: recipient.id,
  actor: owner,
  idempotencyKey: "idem-key-405-test"
});
assert.equal(idemPropose2.ok, true);
assert.equal(idemPropose2.value.id, idemPropose1.value.id, "Idempotent proposal must replay same record");

console.log("  [PASS] Issue #405: Ownership Transfer Acceptance and Expiry fully verified.\n");

// =========================================================================
// ISSUE #406: Deployment Rollback Verification Checks
// =========================================================================
console.log("--> Testing Issue #406: Deployment Rollback Verification Checks...");
const {
  verifyDeploymentRollback,
  retryDeploymentRollback,
  formatRollbackReport
} = await import("../core/recovery/rollback-verifier.ts");

const ALICE_PUB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();
const BOB_PUB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x44)).publicKey();

const rollbackTarget = {
  targetVersion: "1.0.0",
  rolledBackFromVersion: "2.0.0",
  rollbackTimestamp: 1_700_000_000_000
};

const cleanDataset = {
  events: [
    {
      id: "ev-main",
      name: "Main Festival",
      organizerAddress: ALICE_PUB,
      capacity: 500,
      status: "active",
      protocolVersion: "1.0.0",
      createdAt: 1_700_000_000_000
    }
  ],
  tickets: [
    {
      id: "tk-main-1",
      eventId: "ev-main",
      owner: BOB_PUB,
      tier: "vip",
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

// 1. Normal Path: Clean rollback report passes
const cleanRollback = verifyDeploymentRollback(cleanDataset, rollbackTarget, {
  caller: { role: "maintainer", id: "admin-rb" }
});
assert.equal(cleanRollback.ok, true, "Clean rollback verification must succeed");
assert.equal(cleanRollback.value.passed, true);
assert.equal(cleanRollback.value.isClean, true);
assert.equal(cleanRollback.value.requiresManualRepair, false);

// 2. Failure Path: Violations detected
const dirtyDataset = {
  ...cleanDataset,
  transfers: [
    {
      id: "xfer-stranded",
      ticketId: "tk-main-1",
      fromOwner: ALICE_PUB,
      toOwner: BOB_PUB,
      status: "pending",
      protocolVersion: "2.0.0", // rolled back release
      initiatedAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000
    }
  ],
  redemptions: [
    {
      id: "redemp-unconfirmed",
      ticketId: "tk-main-1",
      eventId: "ev-main",
      redeemedBy: BOB_PUB,
      nonce: "nonce-unconfirmed",
      protocolVersion: "2.0.0",
      redeemedAt: 1_700_000_000_000,
      isConfirmed: false
    }
  ]
};
const dirtyRollback = verifyDeploymentRollback(dirtyDataset, rollbackTarget, {
  caller: { role: "maintainer" }
});
assert.equal(dirtyRollback.ok, true);
assert.equal(dirtyRollback.value.passed, false, "Dirty rollback must not pass");
assert.equal(dirtyRollback.value.requiresManualRepair, true, "Must flag manual repair required");
assert.equal(dirtyRollback.value.manualRepairRecords.length >= 2, true);

// 3. Authorization Path: Non-maintainer denied
const deniedRollback = verifyDeploymentRollback(cleanDataset, rollbackTarget, {
  caller: { role: "viewer" }
});
assert.equal(deniedRollback.ok, false);
assert.equal(deniedRollback.code, "unauthorized");

// 4. Retry Path: Retry helper succeeds
let retryAttempts = 0;
const retryResult = retryDeploymentRollback(() => {
  retryAttempts += 1;
  if (retryAttempts < 2) return { ok: false, code: "invalid_target_version" };
  return cleanRollback;
}, 3);
assert.equal(retryResult.ok, true);
assert.equal(retryAttempts, 2);

console.log("  [PASS] Issue #406: Deployment Rollback Verification Checks fully verified.\n");

// =========================================================================
// ISSUE #407: Permission-Diff Preview Before Policy Changes
// =========================================================================
console.log("--> Testing Issue #407: Permission-Diff Preview Before Policy Changes...");
const { PermissionDiffEngine } = await import("../core/policy/permissionDiff.ts");

const maintainerCtx = { role: "maintainer", userId: "admin-diff" };
const viewerCtx = { role: "viewer", userId: "viewer-diff" };

const currentPolicy = {
  viewer: ["view:tools", "view:dashboard"],
  maintainer: [
    "view:tools",
    "view:dashboard",
    "admin:health",
    "admin:recovery",
    "admin:metrics",
    "admin:replay"
  ],
  service: ["admin:health", "admin:metrics"]
};

// 1. Normal Path: Diff generation and rollback snapshot
const proposedPolicy = {
  ...currentPolicy,
  service: ["admin:health", "view:tools"]
};
const diffReportRes = PermissionDiffEngine.generateDiffReport(currentPolicy, proposedPolicy, {
  caller: maintainerCtx
});
assert.equal(diffReportRes.ok, true, "Diff report must generate successfully");
const report = diffReportRes.value;
assert.equal(report.totalAddedCount, 1);
assert.equal(report.totalRemovedCount, 1);
assert.equal(report.rollbackSnapshot.service.includes("admin:metrics"), true);

// 2. Failure Path: Critical Escalation Blocked
const criticalProposed = {
  ...currentPolicy,
  viewer: ["view:tools", "view:dashboard", "admin:recovery"]
};
const applyRes = PermissionDiffEngine.applyRolePolicyChange(currentPolicy, criticalProposed, {
  caller: maintainerCtx
});
assert.equal(applyRes.ok, false, "Critical escalation to viewer must be blocked");
assert.equal(applyRes.code, "critical_escalation_blocked");

// 3. Authorization Path: Non-maintainer caller denied
const viewerDiffRes = PermissionDiffEngine.generateDiffReport(currentPolicy, proposedPolicy, {
  caller: viewerCtx
});
assert.equal(viewerDiffRes.ok, false);
assert.equal(viewerDiffRes.code, "unauthorized");

// 4. Retry Path: Transient error retry
let diffAttempts = 0;
const diffRetry = PermissionDiffEngine.retryDiffReport(() => {
  diffAttempts += 1;
  if (diffAttempts < 2) return { ok: false, code: "empty_permissions" };
  return diffReportRes;
}, 3);
assert.equal(diffRetry.ok, true);
assert.equal(diffAttempts, 2);

console.log("  [PASS] Issue #407: Permission-Diff Preview Before Policy Changes fully verified.\n");

// =========================================================================
// ISSUE #413: Privacy-Safe Export with Field-Level Authorization
// =========================================================================
console.log("--> Testing Issue #413: Privacy-Safe Export with Field-Level Authorization...");
const {
  exportRecords,
  createExportIdempotencyStore,
  createExportQuotaStore,
  EXPORT_CURRENT_SCHEMA_VERSION
} = await import("../core/export/exporter.ts");
const { createMemoryQuotaStorage, createQuotaStore } = await import("../core/quota/quota.ts");

createExportIdempotencyStore(createIdempotencyStore());
createExportQuotaStore(createQuotaStore({ storage: createMemoryQuotaStorage() }));

const exportSource = {
  recordType: "telemetry_audit",
  schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
  scope: "own",
  fieldRules: [
    { field: "adminNotes", minScope: "maintainer", onDenied: "mask" },
    { field: "internalDebug", minScope: "maintainer", onDenied: "omit" },
    { field: "billingCode", requiredPermissions: ["export:billing"], onDenied: "omit" }
  ],
  collect: () => [
    {
      id: "tx-413-001",
      amount: "250.00",
      currency: "USDC",
      adminNotes: "Internal KYC Flag",
      internalDebug: "trace-98765",
      billingCode: "BILL-SECRET-777",
      embeddedSecret: "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW"
    }
  ]
};

// 1. Normal Path: Safe user export masks/omits unauthorized fields and scrubs secret seeds
const userExport = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    actor: { kind: "user", id: "user-413" }
  },
  [exportSource]
);
assert.equal(userExport.ok, true, "User export must succeed");
const userRecord = userExport.value.records[0];
assert.equal(userRecord.id, "tx-413-001");
assert.equal(userRecord.amount, "250.00");
assert.equal(userRecord.adminNotes, "[FILTERED: UNAUTHORIZED]", "adminNotes must be masked");
assert.equal(userRecord.internalDebug, undefined, "internalDebug must be omitted");
assert.equal(userRecord.billingCode, undefined, "billingCode must be omitted without permission");
assert.equal(userRecord.embeddedSecret, "[REDACTED]", "Raw secret seed must be scrubbed");

// 2. Granular Permission Path: User with export:billing receives billingCode
const billingUserExport = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    actor: { kind: "user", id: "user-billing", permissions: ["export:billing"] }
  },
  [exportSource]
);
assert.equal(billingUserExport.ok, true);
assert.equal(billingUserExport.value.records[0].billingCode, "BILL-SECRET-777");

// 3. Failure Path: strictFields denies unpermitted requested fields
const strictExport = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    actor: { kind: "user", id: "user-413" },
    fields: ["id", "adminNotes"],
    strictFields: true
  },
  [exportSource]
);
assert.equal(strictExport.ok, false);
assert.equal(strictExport.code, "field_authorization_denied");

// 4. Authorization Path: Maintainer receives full unmasked authorized fields
const maintainerExport = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "maintainer",
    actor: { kind: "maintainer", id: "admin-413" }
  },
  [exportSource]
);
assert.equal(maintainerExport.ok, true);
assert.equal(maintainerExport.value.records[0].adminNotes, "Internal KYC Flag");
assert.equal(maintainerExport.value.records[0].internalDebug, "trace-98765");

// 5. Retry and Idempotency Path: Identical replay with key
const idemExport1 = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    actor: { kind: "user", id: "user-413" },
    idempotencyKey: "idem-key-export-413"
  },
  [exportSource]
);
assert.equal(idemExport1.ok, true);
const idemExport2 = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    actor: { kind: "user", id: "user-413" },
    idempotencyKey: "idem-key-export-413"
  },
  [exportSource]
);
assert.equal(idemExport2.ok, true);
assert.equal(idemExport2.value.generatedAt, idemExport1.value.generatedAt, "Replay must return cached artifact");

console.log("  [PASS] Issue #413: Privacy-Safe Export with Field-Level Authorization fully verified.\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#405, #406, #407, #413) VERIFIED 100% OK!  ");
console.log("============================================================");
