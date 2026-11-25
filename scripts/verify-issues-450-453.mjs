#!/usr/bin/env node
/**
 * Automated Verification Suite for Issues #450, #451, #452, #453
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #450: Add deployment rollback verification checks
 * - Issue #451: Build permission-diff preview before policy changes
 * - Issue #452: Implement stable problem-details error taxonomy
 * - Issue #453: Add fuzz tests for malformed and boundary inputs
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-450-453.mjs
 */

import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #450, #451, #452, #453    ");
console.log("============================================================\n");

// ─── Shared keys ─────────────────────────────────────────────────────────────

const KEY_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10)).publicKey();
const KEY_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 20)).publicKey();
const KEY_C = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 30)).publicKey();
const VALID_TX_HASH = "deadbeef00112233deadbeef00112233deadbeef00112233deadbeef00112233";

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #450: Deployment Rollback Verification Checks
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #450: Deployment Rollback Verification Checks...");

const {
  verifyReleaseRollback,
  formatRollbackReport,
  verifyProtocolVersionCompatibility,
  verifyPendingOperationsAndInFlightTransfers,
  verifyPartiallyProcessedRedemptions,
  verifyEventCapacityAndIssuanceInvariants,
  verifyWorkerJobPayloadCompatibility,
  verifyExternalReferencesAndFraudControls,
} = await import("../core/recovery/rollback-verifier.ts");

const rollbackTarget = {
  targetVersion: "2.0.0",
  rolledBackFromVersion: "2.1.0",
  rollbackTimestamp: 1_700_000_000_000,
};

const cleanDataset = {
  events: [{
    id: "evt-summit",
    name: "Stellar Summit",
    organizerAddress: KEY_A,
    capacity: 500,
    status: "active",
    protocolVersion: "2.0.0",
    createdAt: 1_699_000_000_000,
  }],
  tickets: [{
    id: "tkt-1",
    eventId: "evt-summit",
    owner: KEY_A,
    tier: "general",
    status: "issued",
    protocolVersion: "2.0.0",
    externalRef: VALID_TX_HASH,
    issuedAt: 1_699_000_010_000,
    updatedAt: 1_699_000_010_000,
  }],
  transfers: [{
    id: "xfer-1",
    ticketId: "tkt-1",
    fromOwner: KEY_A,
    toOwner: KEY_B,
    status: "accepted",
    protocolVersion: "2.0.0",
    initiatedAt: 1_699_000_020_000,
    expiresAt: 1_699_003_620_000,
    settledAt: 1_699_000_030_000,
  }],
  redemptions: [{
    id: "rdm-1",
    ticketId: "tkt-1",
    eventId: "evt-summit",
    redeemedBy: KEY_A,
    nonce: "nonce-safe-abc",
    protocolVersion: "2.0.0",
    redeemedAt: 1_699_000_050_000,
    isConfirmed: true,
  }],
  workerJobs: [{
    id: "job-1",
    jobType: "ticket_notification",
    status: "succeeded",
    payloadVersion: "2.0.0",
    payload: { ticketId: "tkt-1" },
    createdAt: 1_699_000_010_000,
    updatedAt: 1_699_000_015_000,
  }],
  fraudRecords: [{
    id: "fraud-1",
    account: KEY_C,
    ruleId: "freq_transfer",
    protocolVersion: "2.0.0",
    flaggedAt: 1_699_000_040_000,
    isManualReviewPending: false,
  }],
};

// 1. Normal path: clean dataset passes all checks
const cleanReport = verifyReleaseRollback(cleanDataset, rollbackTarget);
assert.equal(cleanReport.isClean, true, "#450 clean dataset must pass all checks");
assert.equal(cleanReport.passed, true, "#450 must report passed");
assert.equal(cleanReport.requiresManualRepair, false, "#450 no manual repair on clean dataset");
assert.equal(cleanReport.readOnly, true, "#450 must run read-only by default");
assert.equal(cleanReport.totalChecks, 6, "#450 must run 6 checks");
assert.equal(cleanReport.failedChecks, 0, "#450 must have 0 failed checks on clean dataset");

// 2. Normal path: formatted report contains expected sections
const formatted = formatRollbackReport(cleanReport);
assert.ok(formatted.includes("CLEAN ROLLBACK [PASS]"), "#450 formatted report must contain pass status");
assert.ok(formatted.includes("READ-ONLY"), "#450 formatted report must note read-only mode");

// 3. Failure path: rolled-back ticket version detected
const rolledBackDataset = {
  ...cleanDataset,
  tickets: [{
    ...cleanDataset.tickets[0],
    protocolVersion: "2.1.0", // rolled-back version
  }],
};
const rolledBackReport = verifyReleaseRollback(rolledBackDataset, rollbackTarget);
assert.equal(rolledBackReport.isClean, false, "#450 must detect rolled-back ticket version");
assert.equal(rolledBackReport.requiresManualRepair, true, "#450 must require manual repair");
assert.ok(
  rolledBackReport.manualRepairRecords.some(r => r.domain === "ticket"),
  "#450 manual repair must flag ticket domain"
);

// 4. Failure path: active worker job with rolled-back payload
const activeJobDataset = {
  ...cleanDataset,
  workerJobs: [{
    id: "job-active",
    jobType: "sync_v21",
    status: "queued",
    payloadVersion: "2.1.0",
    payload: {},
    createdAt: 1_699_000_000_000,
    updatedAt: 1_699_000_010_000,
  }],
};
const { check: workerCheck } = verifyWorkerJobPayloadCompatibility(activeJobDataset, rollbackTarget);
assert.equal(workerCheck.passed, false, "#450 must detect active job with rolled-back payload");

// 5. Edge case: cancelled tickets do not count toward capacity
const capacityDataset = {
  ...cleanDataset,
  events: [{ ...cleanDataset.events[0], capacity: 1 }],
  tickets: [
    { ...cleanDataset.tickets[0], status: "issued" },
    { id: "tkt-cancelled", eventId: "evt-summit", owner: KEY_B, tier: "general",
      status: "cancelled", protocolVersion: "2.0.0", issuedAt: 1_699_000_020_000, updatedAt: 1_699_000_030_000 },
  ],
};
const { check: capCheck } = verifyEventCapacityAndIssuanceInvariants(capacityDataset);
assert.equal(capCheck.passed, true, "#450 cancelled tickets must not count toward capacity");

// 6. Retry path: deterministic output on repeated calls
const r1 = verifyReleaseRollback(cleanDataset, rollbackTarget, { now: () => new Date(1_700_000_000_000) });
const r2 = verifyReleaseRollback(cleanDataset, rollbackTarget, { now: () => new Date(1_700_000_000_000) });
assert.equal(r1.isClean, r2.isClean, "#450 must produce deterministic output on repeated calls");
assert.equal(r1.passedChecks, r2.passedChecks, "#450 passed checks must be deterministic");

console.log("    [PASS] Issue #450: Deployment Rollback Verification Checks verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #451: Permission-Diff Preview Before Policy Changes
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #451: Permission-Diff Preview Before Policy Changes...");

const { PermissionDiffEngine } = await import("../core/policy/permissionDiff.ts");

const BASE_PERMS = {
  viewer: ["view:tools", "view:dashboard"],
  maintainer: ["view:tools", "view:dashboard", "admin:health", "admin:recovery", "admin:metrics", "admin:replay"],
  service: ["admin:health", "admin:metrics"],
};
const maintainerCtx = { role: "maintainer", userId: "admin-007" };
const viewerCtx = { role: "viewer", userId: "viewer-001" };

// 1. Normal path: benign additive change
const addResult = PermissionDiffEngine.generateDiffReport(
  BASE_PERMS,
  { ...BASE_PERMS, service: ["admin:health", "admin:metrics", "view:tools"] },
  { caller: maintainerCtx }
);
assert.equal(addResult.ok, true, "#451 benign additive diff must succeed");
assert.equal(addResult.value.overallRiskLevel, "low", "#451 benign change must be low risk");
assert.equal(addResult.value.recommendedAction, "proceed", "#451 must recommend proceed");
assert.equal(addResult.value.executionPlan.allowApply, true, "#451 must allow apply");

// 2. Normal path: rollback snapshot preserves pre-change state
const applyResult = PermissionDiffEngine.applyRolePolicyChange(
  BASE_PERMS,
  { ...BASE_PERMS, service: ["admin:health"] },
  { caller: maintainerCtx }
);
assert.equal(applyResult.ok, true, "#451 apply must succeed for safe change");
assert.deepEqual(
  applyResult.value.rollbackSnapshot.service,
  ["admin:health", "admin:metrics"],
  "#451 rollback snapshot must capture original service permissions"
);

// 3. Failure path: critical escalation blocked
const escalationResult = PermissionDiffEngine.generateDiffReport(
  BASE_PERMS,
  { ...BASE_PERMS, viewer: [...BASE_PERMS.viewer, "admin:recovery"] },
  { caller: maintainerCtx }
);
assert.equal(escalationResult.ok, true, "#451 diff generation must not error on critical escalation");
assert.equal(escalationResult.value.overallRiskLevel, "critical", "#451 critical escalation must be rated critical");
assert.equal(escalationResult.value.recommendedAction, "block", "#451 critical change must be blocked");
assert.equal(escalationResult.value.executionPlan.allowApply, false, "#451 must not allow apply for critical change");

// 4. Failure path: apply blocked returns critical_escalation_blocked
const blockedApply = PermissionDiffEngine.applyRolePolicyChange(
  BASE_PERMS,
  { ...BASE_PERMS, viewer: [...BASE_PERMS.viewer, "admin:recovery"] },
  { caller: maintainerCtx }
);
assert.equal(blockedApply.ok, false, "#451 apply must be blocked for critical escalation");
assert.equal(blockedApply.code, "critical_escalation_blocked", "#451 must return critical_escalation_blocked");

// 5. Failure path: lockout risk
const lockoutResult = PermissionDiffEngine.generateDiffReport(
  BASE_PERMS,
  { ...BASE_PERMS, maintainer: [] },
  { caller: maintainerCtx }
);
assert.equal(lockoutResult.ok, true);
assert.ok(
  lockoutResult.value.warnings.some(w => w.includes("LOCKOUT RISK")),
  "#451 must warn about lockout risk"
);

// 6. Authorization path: viewer denied diff generation
const viewerDiff = PermissionDiffEngine.generateDiffReport(BASE_PERMS, BASE_PERMS, { caller: viewerCtx });
assert.equal(viewerDiff.ok, false, "#451 viewer must be denied diff generation");
assert.equal(viewerDiff.code, "unauthorized", "#451 must return unauthorized");

// 7. Retry path: retryDiffReport recovers from transient failures
let retryAttempts = 0;
const retryResult = PermissionDiffEngine.retryDiffReport(() => {
  retryAttempts++;
  if (retryAttempts < 3) return { ok: false, code: "invalid_role_definition" };
  return PermissionDiffEngine.generateDiffReport(BASE_PERMS, BASE_PERMS, { caller: maintainerCtx });
}, 3);
assert.equal(retryResult.ok, true, "#451 retry must eventually succeed");
assert.equal(retryAttempts, 3, "#451 must have made exactly 3 attempts");

console.log("    [PASS] Issue #451: Permission-Diff Preview verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #452: Stable Problem-Details Error Taxonomy
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #452: Stable Problem-Details Error Taxonomy...");

const {
  PROBLEM_CODES,
  problemDetailsFromCode,
  getProblemDefinition,
  isProblemRetryable,
  horizonToProblemDetails,
  rpcToProblemDetails,
} = await import("../core/errors/problem-details.ts");
const { classifyHorizonError } = await import("../core/horizon/errors.ts");
const { classifyRpcError, classifyRpcTransportError } = await import("../core/rpc/errors.ts");
const { RPC_STANDARD_CODES } = await import("../core/rpc/client.ts");

// 1. Normal path: every code produces a valid wire envelope
const allCodes = Object.keys(PROBLEM_CODES);
for (const code of allCodes) {
  const pd = problemDetailsFromCode(code);
  assert.equal(typeof pd.type, "string", `#452 ${code}: type must be string`);
  assert.ok(pd.type.startsWith("https://utix.dev/problems/"), `#452 ${code}: type must be absolute URI`);
  assert.equal(typeof pd.code, "string", `#452 ${code}: code must be string`);
  assert.ok(/^[a-z][a-z0-9_]*$/.test(pd.code), `#452 ${code}: code must be lowercase_snake`);
  assert.equal(typeof pd.retryable, "boolean", `#452 ${code}: retryable must be boolean`);
  assert.ok(Number.isFinite(pd.status), `#452 ${code}: status must be finite`);
  assert.ok(pd.status >= 400 && pd.status <= 599, `#452 ${code}: status must be 4xx-5xx`);
}
assert.ok(allCodes.length >= 39, `#452 registry must contain at least 39 codes (found ${allCodes.length})`);

// 2. Normal path: type URI is stable and contains correct slug
const accountNotFoundDef = getProblemDefinition("account_not_found");
assert.equal(accountNotFoundDef.type, "https://utix.dev/problems/account-not-found", "#452 type URI must be stable");
assert.equal(accountNotFoundDef.code, "account_not_found", "#452 code must match key");

// 3. Normal path: retryable codes are correctly classified
assert.equal(isProblemRetryable("horizon_rate_limited"), true, "#452 rate_limited must be retryable");
assert.equal(isProblemRetryable("horizon_timeout"), true, "#452 timeout must be retryable");
assert.equal(isProblemRetryable("account_not_found"), false, "#452 account_not_found must not be retryable");
assert.equal(isProblemRetryable("validation_error"), false, "#452 validation_error must not be retryable");

// 4. Failure path: horizon bridge never echoes raw error text
const rawMsg = "INTERNAL_SECRET_ERR_XYZ_9988";
const hClassified = classifyHorizonError({ status: 500, detail: rawMsg, extras: {} }, "server_error");
const hPd = horizonToProblemDetails(hClassified);
assert.ok(!hPd.detail.includes("INTERNAL_SECRET_ERR_XYZ_9988"), "#452 must not echo raw Horizon error text");
assert.ok(!hPd.title.includes("INTERNAL_SECRET_ERR_XYZ_9988"), "#452 must not echo raw Horizon error in title");

// 5. Normal path: correlationId round-trips
const corrId = "test-corr-450-452";
const corrPd = problemDetailsFromCode("internal_error", { correlationId: corrId });
assert.equal(corrPd.correlationId, corrId, "#452 correlationId must round-trip");

// 6. Normal path: extensions are propagated
const extPd = problemDetailsFromCode("account_not_found", { extensions: { network: "testnet" } });
assert.deepEqual(extPd.extensions, { network: "testnet" }, "#452 extensions must be propagated");

// 7. Failure path: RPC bridge produces valid envelopes for all transport errors
for (const transportType of ["timeout", "network_unavailable"]) {
  const rpcClassified = classifyRpcTransportError(transportType);
  const rpcPd = rpcToProblemDetails(rpcClassified);
  assert.equal(typeof rpcPd.code, "string", `#452 rpc ${transportType}: code must be string`);
  assert.ok(rpcPd.type.startsWith("https://utix.dev/problems/"), `#452 rpc ${transportType}: type must be URI`);
}

// 8. Stability contract: code count must not decrease
assert.ok(
  allCodes.length === 39,
  `#452 stability contract: must have exactly 39 codes (found ${allCodes.length})`
);

console.log("    [PASS] Issue #452: Stable Problem-Details Error Taxonomy verified\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #453: Fuzz Tests for Malformed and Boundary Inputs
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #453: Fuzz Tests for Malformed and Boundary Inputs...");

const { parseAmount, amountToStroops, stroopsToAmount, INT64_MAX, INT64_MIN } =
  await import("../core/format/amount.ts");
const { hasPermission, hasAnyPermission, ROLE_PERMISSIONS } =
  await import("../core/auth/types.ts");
const { parseJsonRpcResponse } = await import("../core/rpc/client.ts");

// 1. Boundary amounts: exact boundary values
const AMOUNT_BOUNDARY_CASES = [
  ["922337203685.4775807", true, "big_int"],    // INT64_MAX
  ["922337203685.4775808", true, "out_of_range"],
  ["-922337203685.4775808", true, "big_int"],   // INT64_MIN
  ["-922337203685.4775809", true, "out_of_range"],
  ["0.0000001", false, "big_int"],
  ["0.00000001", false, "too_many_decimals"],
  ["", false, "empty"],
];

for (const [raw, allowNeg, expectedKind] of AMOUNT_BOUNDARY_CASES) {
  let result;
  assert.doesNotThrow(
    () => { result = parseAmount(raw, { allowNegative: allowNeg }); },
    `#453 parseAmount must not throw for input: ${JSON.stringify(raw)}`
  );
  if (expectedKind === "big_int") {
    assert.equal(result.ok, true, `#453 parseAmount("${raw}") must succeed`);
  } else {
    assert.equal(result.ok, false, `#453 parseAmount("${raw}") must fail with ${expectedKind}`);
    assert.equal(result.code, expectedKind, `#453 parseAmount("${raw}") must return code ${expectedKind}`);
  }
}

// 2. Round-trip: stroops ↔ amount for boundary values
for (const stroops of [INT64_MAX, INT64_MIN, 0n, 1n, -1n, 10_000_000n]) {
  const amount = stroopsToAmount(stroops);
  const parsed = parseAmount(amount, { allowNegative: true });
  assert.equal(parsed.ok, true, `#453 round-trip must succeed for stroops=${stroops}`);
  assert.equal(parsed.value, stroops, `#453 round-trip must be exact for stroops=${stroops}`);
}

// 3. JSON-RPC: non-integer error codes rejected
for (const code of [1.5, NaN, Infinity, "-32000", null]) {
  const parsed = parseJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code, message: "x" } }, 1);
  assert.ok("error" in parsed, `#453 non-integer code ${code} must produce error envelope`);
  assert.ok(Number.isInteger(parsed.error.code), `#453 normalized code must be integer`);
}

// 4. Authorization fuzz: unknown roles are always denied
const unknownRoles = ["admin", "VIEWER", "", "toString", "__proto__", null, undefined];
const anyPerm = Object.values(ROLE_PERMISSIONS).flat()[0];
for (const role of unknownRoles) {
  assert.doesNotThrow(
    () => hasPermission(role, anyPerm),
    `#453 hasPermission must not throw for unknown role: ${JSON.stringify(role)}`
  );
  assert.equal(hasPermission(role, anyPerm), false, `#453 unknown role must be denied`);
}

// 5. PermissionDiffEngine: boundary proposed inputs never throw
const BOUNDARY_PROPOSED = [
  null, undefined, {}, { viewer: null }, { viewer: "view:tools" },
];
for (const proposed of BOUNDARY_PROPOSED) {
  assert.doesNotThrow(
    () => PermissionDiffEngine.generateDiffReport(BASE_PERMS, proposed, { caller: maintainerCtx }),
    `#453 generateDiffReport must not throw for boundary proposed: ${JSON.stringify(proposed)}`
  );
}

// 6. Rollback verifier: boundary address inputs never throw
const BOUNDARY_OWNERS = [
  "", "NOT_A_KEY", "X".repeat(56), KEY_A, // last one is valid
];
for (const owner of BOUNDARY_OWNERS) {
  const dataset = {
    events: [],
    tickets: [{
      id: "tkt-b",
      eventId: "evt-b",
      owner,
      tier: "general",
      status: "issued",
      protocolVersion: "2.0.0",
      issuedAt: Date.now(),
      updatedAt: Date.now(),
    }],
    transfers: [],
    redemptions: [],
    workerJobs: [],
    fraudRecords: [],
  };
  assert.doesNotThrow(
    () => verifyReleaseRollback(dataset, rollbackTarget),
    `#453 verifyReleaseRollback must not throw for owner: ${owner.slice(0, 10)}...`
  );
}

console.log("    [PASS] Issue #453: Fuzz Tests for Malformed and Boundary Inputs verified\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#450, #451, #452, #453) VERIFIED [PASS]    ");
console.log("============================================================");
