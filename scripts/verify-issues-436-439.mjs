#!/usr/bin/env node
/**
 * Automated Verification Suite for Issues #436, #437, #438, #439
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #436: Create worst-case load tests and resource budgets
 * - Issue #437: Implement cancellation and cleanup for long operations
 * - Issue #438: Add durable checkpoints around external side effects
 * - Issue #439: Build versioned event replay for derived projections
 *
 * Each issue verifies the normal, failure, retry, and authorization paths.
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-436-439.mjs
 */

import assert from "node:assert/strict";

console.log("================================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #436, #437, #438, #439        ");
console.log("================================================================\n");

const MAINTAINER = { role: "maintainer", userId: "ops-admin" };
const VIEWER = { role: "viewer", userId: "viewer-1" };
const SERVICE = { role: "service", userId: "svc-1" };
const OWNER = { role: "viewer", userId: "owner-42" };

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #436: Worst-case load tests and resource budgets
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #436: Worst-case load tests and resource budgets...");

const {
  DEFAULT_RESOURCE_BUDGET_PROFILE,
  evaluateResourceBudget,
  grantEmergencyBudgetOverride,
  runWorstCaseLoadTest
} = await import("../core/quota/worst-case-load.ts");
const { createMemoryQuotaStorage, createQuotaStore } = await import("../core/quota/quota.ts");

// 1. Normal path: nominal concurrent load within budget limits
{
  const normalResult = await runWorstCaseLoadTest({
    name: "nominal_load",
    operation: "ticket.issue",
    resource: "storage",
    actorIds: ["actor-1", "actor-2"],
    requestsPerActor: 5,
    costPerRequest: 10
  });

  assert.equal(normalResult.totalRequests, 10, "#436: total requests must match");
  assert.equal(normalResult.succeededCount, 10, "#436: nominal requests must succeed");
  assert.equal(normalResult.rejectedCount, 0, "#436: zero rejections under nominal load");
  assert.equal(normalResult.totalCostConsumed, 100, "#436: cost consumed must be accurate");
  assert.equal(normalResult.resourceExhausted, false, "#436: budget not exhausted");
}

// 2. Failure path: burst exceeding quota triggers load shedding; invalid cost rejected
{
  const overloadResult = await runWorstCaseLoadTest({
    name: "quota_exhaustion_burst",
    operation: "ticket.issue",
    resource: "storage",
    actorIds: ["heavy-actor"],
    requestsPerActor: 60,
    costPerRequest: 10 // 60 * 10 = 600 > 500 limit
  });

  assert.equal(overloadResult.succeededCount, 50, "#436: exactly 50 requests succeed up to limit");
  assert.equal(overloadResult.rejectedCount, 10, "#436: 10 requests shed upon quota exhaustion");
  assert.equal(overloadResult.resourceExhausted, true, "#436: resource exhaustion correctly flagged");

  // Invalid cost validation
  const badCost = evaluateResourceBudget(DEFAULT_RESOURCE_BUDGET_PROFILE, {
    resource: "compute",
    cost: -10,
    currentInFlight: 0
  });
  assert.equal(badCost.ok, false);
  assert.equal(badCost.code, "quota_invalid_cost", "#436: negative cost must be rejected");
}

// 3. Retry and isolation path: abusive principal does not starve non-abusive principal
{
  let currentTime = 1_700_000_000_000;
  const storage = createMemoryQuotaStorage();
  const store = createQuotaStore({ storage, now: () => currentTime });

  const first = await store.consume({ operation: "ticket.transfer", principal: "retry-user", cost: 20 });
  assert.equal(first.ok, true, "#436: initial spend must succeed");

  const immediate = await store.consume({ operation: "ticket.transfer", principal: "retry-user", cost: 1 });
  assert.equal(immediate.ok, false, "#436: immediate spend must be rejected");

  // Advance time past 1-hour window
  currentTime += 60 * 60 * 1_000 + 10;
  const retried = await store.consume({ operation: "ticket.transfer", principal: "retry-user", cost: 5 });
  assert.equal(retried.ok, true, "#436: retry after window reset must succeed");
}

// 4. Authorization path: maintainer can grant emergency override, unprivileged is denied
{
  const storage = createMemoryQuotaStorage();
  const store = createQuotaStore({ storage, now: () => 1_700_000_000_000 });

  const maintainerGrant = await grantEmergencyBudgetOverride(store, MAINTAINER, {
    operation: "ticket.issue",
    subject: "actor-vip",
    overrideLimit: 2_500,
    reason: "Festival surge",
    ttlMs: 3600_000
  });
  assert.equal(maintainerGrant.ok, true, "#436: maintainer must be allowed to grant override");

  const viewerGrant = await grantEmergencyBudgetOverride(store, VIEWER, {
    operation: "ticket.issue",
    subject: "actor-vip",
    overrideLimit: 2_500,
    reason: "Viewer bypass",
    ttlMs: 3600_000
  });
  assert.equal(viewerGrant.ok, false);
  assert.equal(viewerGrant.code, "quota_override_denied", "#436: viewer must be denied override");
}
console.log("✓ Issue #436 verified successfully.\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #437: Cancellation and cleanup for long operations
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #437: Cancellation and cleanup for long operations...");

const { createOperationCancellationManager } = await import("../core/operations/cancellation.ts");

// 1. Normal path: cooperative cancellation executes cleanup hooks in strict LIFO order
{
  const manager = createOperationCancellationManager();
  const executionOrder = [];

  manager.registerOperation("op-cancel-run");
  manager.registerCleanup("op-cancel-run", "cleanup-first", () => { executionOrder.push("cleanup-first"); });
  manager.registerCleanup("op-cancel-run", "cleanup-second", () => { executionOrder.push("cleanup-second"); });
  manager.registerCleanup("op-cancel-run", "cleanup-third", () => { executionOrder.push("cleanup-third"); });

  const cancelResult = await manager.cancelOperation("op-cancel-run", "User abort");
  assert.equal(cancelResult.ok, true, "#437: cancellation must succeed");
  assert.equal(cancelResult.value.status, "cancelled", "#437: status must be cancelled");
  assert.deepEqual(executionOrder, ["cleanup-third", "cleanup-second", "cleanup-first"], "#437: cleanups must execute in LIFO order");
}

// 2. Failure path: isolated cleanup failures and unknown operation handling
{
  const manager = createOperationCancellationManager();
  const executionLog = [];

  manager.registerOperation("op-cancel-fail");
  manager.registerCleanup("op-cancel-fail", "step-ok", () => { executionLog.push("step-ok"); });
  manager.registerCleanup("op-cancel-fail", "step-bad", () => {
    executionLog.push("step-bad");
    throw new Error("RPC socket timeout");
  });

  const failResult = await manager.cancelOperation("op-cancel-fail", "Abort");
  assert.equal(failResult.ok, false, "#437: cancellation must report failure when hook throws");
  assert.equal(failResult.code, "cleanup_failed", "#437: error code must be cleanup_failed");
  assert.deepEqual(executionLog, ["step-bad", "step-ok"], "#437: all hooks execute despite failure");

  const unknownResult = await manager.cancelOperation("ghost-op", "Abort");
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.code, "unknown_operation", "#437: unknown op returns unknown_operation");
}

// 3. Retry path: idempotent repeat cancellation and retrying failed cleanups
{
  const manager = createOperationCancellationManager();
  let stepOkCount = 0;
  let stepFlakyCount = 0;
  let shouldFlakyPass = false;

  manager.registerOperation("op-retry-clean");
  manager.registerCleanup("op-retry-clean", "step-ok", () => { stepOkCount++; });
  manager.registerCleanup("op-retry-clean", "step-flaky", () => {
    stepFlakyCount++;
    if (!shouldFlakyPass) throw new Error("Temporary network error");
  });

  const firstCancel = await manager.cancelOperation("op-retry-clean", "Cancel 1");
  assert.equal(firstCancel.ok, false);
  assert.equal(stepOkCount, 1);
  assert.equal(stepFlakyCount, 1);

  // Retry cleanup after fixing transient condition
  shouldFlakyPass = true;
  const retryCleanup = await manager.retryOperationCleanup("op-retry-clean");
  assert.equal(retryCleanup.ok, true, "#437: retryOperationCleanup must succeed");
  assert.equal(retryCleanup.value.status, "cancelled", "#437: transitions to cancelled");
  assert.equal(stepOkCount, 1, "#437: already succeeded hook was not re-run");
  assert.equal(stepFlakyCount, 2, "#437: failed hook was re-executed");

  // Idempotent repeat cancellation
  const repeat = await manager.cancelOperation("op-retry-clean", "Repeat");
  assert.equal(repeat.ok, true);
  assert.equal(repeat.value.idempotentReplay, true, "#437: repeat cancel returns idempotentReplay true");
}

// 4. Authorization path: maintainers and owners allowed, unprivileged denied
{
  const manager = createOperationCancellationManager();
  manager.registerOperation("op-auth-test", "owner-42");

  const ownerCancel = await manager.cancelOperationAuthorized(OWNER, { id: "op-auth-test", ownerId: "owner-42" }, "Owner cancel");
  assert.equal(ownerCancel.ok, true, "#437: owner must be allowed to cancel");

  manager.registerOperation("op-auth-maint", "other-user");
  const maintCancel = await manager.cancelOperationAuthorized(MAINTAINER, { id: "op-auth-maint", ownerId: "other-user" }, "Maint cancel");
  assert.equal(maintCancel.ok, true, "#437: maintainer must be allowed to cancel");

  manager.registerOperation("op-auth-denied", "other-user");
  const viewerCancel = await manager.cancelOperationAuthorized(VIEWER, { id: "op-auth-denied", ownerId: "other-user" }, "Viewer cancel");
  assert.equal(viewerCancel.ok, false);
  assert.equal(viewerCancel.code, "permission_denied", "#437: non-owner viewer must be denied");
}
console.log("✓ Issue #437 verified successfully.\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #438: Durable checkpoints around external side effects
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #438: Durable checkpoints around external side effects...");

const {
  createMemoryDurableCheckpointStore,
  executeWithDurableCheckpoint,
  resolveInDoubtCheckpointAuthorized
} = await import("../core/operations/durable-checkpoints.ts");

// 1. Normal path: intent -> execution -> committed with external receipt
{
  const store = createMemoryDurableCheckpointStore();
  let actionCalled = 0;

  const result = await executeWithDurableCheckpoint({
    store,
    operationId: "op-settle-438",
    stepId: "disburse_tokens",
    idempotencyKey: "idem-438-normal",
    payload: { amount: 500, to: "GAA...STELLAR" },
    action: async () => {
      actionCalled++;
      return {
        output: { ledgerSequence: 12345 },
        externalReceipt: { transactionHash: "tx-hash-438", externalId: "receipt-001" }
      };
    }
  });

  assert.equal(result.ok, true, "#438: execution must succeed");
  assert.equal(result.value.replayed, false, "#438: not replayed");
  assert.equal(result.value.checkpoint.phase, "committed", "#438: phase is committed");
  assert.equal(result.value.checkpoint.sideEffectCommitted, true, "#438: sideEffectCommitted true");
  assert.equal(result.value.checkpoint.externalReceipt.transactionHash, "tx-hash-438");
  assert.equal(actionCalled, 1);
}

// 2. Failure path: definitive failure vs. ambiguous timeout in-doubt
{
  const store = createMemoryDurableCheckpointStore();

  // Definitive failure
  const defResult = await executeWithDurableCheckpoint({
    store,
    operationId: "op-settle-def",
    stepId: "step-1",
    idempotencyKey: "idem-def-fail",
    payload: {},
    action: async () => { throw new Error("400 Bad Request: Account not funded"); },
    isDefinitiveFailure: (e) => String(e).includes("400 Bad Request")
  });
  assert.equal(defResult.ok, false);
  assert.equal(defResult.code, "external_effect_failed", "#438: definitive error returns external_effect_failed");
  const defCp = store.byKey("idem-def-fail");
  assert.equal(defCp.phase, "failed");
  assert.equal(defCp.sideEffectCommitted, false, "#438: side effect not committed on definitive fail");

  // Ambiguous timeout (in-doubt)
  const timeoutResult = await executeWithDurableCheckpoint({
    store,
    operationId: "op-settle-timeout",
    stepId: "step-1",
    idempotencyKey: "idem-timeout",
    payload: {},
    action: async () => { throw new Error("Connection reset / Gateway 504"); },
    isDefinitiveFailure: () => false
  });
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.code, "external_effect_in_doubt", "#438: timeout returns external_effect_in_doubt");
  const timeoutCp = store.byKey("idem-timeout");
  assert.equal(timeoutCp.phase, "in_doubt");
  assert.equal(timeoutCp.sideEffectCommitted, true, "#438: in-doubt checkpoint marks sideEffectCommitted true");

  // Re-execution while in-doubt is immediately refused
  const retryBlocked = await executeWithDurableCheckpoint({
    store,
    operationId: "op-settle-timeout",
    stepId: "step-1",
    idempotencyKey: "idem-timeout",
    payload: {},
    action: async () => ({ output: "should not run" })
  });
  assert.equal(retryBlocked.ok, false);
  assert.equal(retryBlocked.code, "external_effect_in_doubt", "#438: blind retry blocked while in-doubt");
}

// 3. Retry path: idempotent replay returns committed output without re-running action
{
  const store = createMemoryDurableCheckpointStore();
  let actionInvocations = 0;

  const first = await executeWithDurableCheckpoint({
    store,
    operationId: "op-replay",
    stepId: "step-1",
    idempotencyKey: "idem-replay-key",
    payload: { x: 1 },
    action: async () => {
      actionInvocations++;
      return { output: { receipt: 777 } };
    }
  });
  assert.equal(first.ok, true);
  assert.equal(actionInvocations, 1);

  const second = await executeWithDurableCheckpoint({
    store,
    operationId: "op-replay",
    stepId: "step-1",
    idempotencyKey: "idem-replay-key",
    payload: { x: 1 },
    action: async () => {
      actionInvocations++;
      return { output: { receipt: 777 } };
    }
  });
  assert.equal(second.ok, true);
  assert.equal(second.value.replayed, true, "#438: second execution reports replayed true");
  assert.equal(second.value.output.receipt, 777);
  assert.equal(actionInvocations, 1, "#438: action must NOT be re-executed");
}

// 4. Authorization path: maintainer resolves in-doubt, viewer is denied
{
  const store = createMemoryDurableCheckpointStore();

  await executeWithDurableCheckpoint({
    store,
    operationId: "op-in-doubt-auth",
    stepId: "step-1",
    idempotencyKey: "idem-auth-indoubt",
    payload: {},
    action: async () => { throw new Error("Timeout"); },
    isDefinitiveFailure: () => false
  });

  const cp = store.byKey("idem-auth-indoubt");

  const viewerResolve = resolveInDoubtCheckpointAuthorized(VIEWER, store, cp.id, {
    outcome: "applied",
    reason: "Viewer attempt"
  });
  assert.equal(viewerResolve.ok, false);
  assert.equal(viewerResolve.code, "permission_denied", "#438: viewer must be denied resolution");

  const maintResolve = resolveInDoubtCheckpointAuthorized(MAINTAINER, store, cp.id, {
    outcome: "applied",
    externalReceipt: { transactionHash: "manual-confirmed-tx" },
    reason: "Confirmed via Stellar Horizon explorer"
  });
  assert.equal(maintResolve.ok, true, "#438: maintainer must be allowed resolution");
  assert.equal(maintResolve.value.phase, "committed", "#438: phase resolved to committed");
  assert.equal(maintResolve.value.externalReceipt.transactionHash, "manual-confirmed-tx");
}
console.log("✓ Issue #438 verified successfully.\n");

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE #439: Versioned event replay for derived projections
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> Testing Issue #439: Versioned event replay for derived projections...");

const {
  buildDerivedProjectionAuthorized,
  createMemoryProjectionStore,
  createUpcasterRegistry,
  rollbackDerivedProjectionAuthorized
} = await import("../core/replay");

function makeEvent(sequence, type, version, payload) {
  return {
    id: `evt-${sequence}`,
    sequence,
    type,
    version,
    payload,
    occurredAt: "2026-11-20T00:00:00.000Z"
  };
}

function makeSource(events) {
  return {
    read: async (after, limit) => events.filter((e) => e.sequence > after).slice(0, limit)
  };
}

const sampleEvents = [
  makeEvent(1, "account.created", 1, { id: "GA1", balance: 100 }),
  makeEvent(2, "account.created", 1, { id: "GB2", balance: 50 }),
  makeEvent(3, "payment.sent", 1, { from: "GA1", to: "GB2", amount: "30.0" }), // v1 decimal string
  makeEvent(4, "payment.sent", 2, { from: "GA1", to: "GB2", stroops: 10 })     // v2 integer stroops
];

const replayUpcasters = createUpcasterRegistry([
  {
    type: "payment.sent",
    fromVersion: 1,
    upcast: (payload) => ({
      from: payload.from,
      to: payload.to,
      stroops: Math.round(Number(payload.amount))
    })
  }
]);

const accountSummarySpec = {
  name: "account_balances_derived",
  version: 1,
  eventVersions: { "account.created": 1, "payment.sent": 2 },
  initial: () => ({ balances: {} }),
  apply: (state, e) => {
    const balances = { ...state.balances };
    if (e.type === "account.created") {
      balances[e.payload.id] = e.payload.balance;
    } else if (e.type === "payment.sent") {
      balances[e.payload.from] -= e.payload.stroops;
      balances[e.payload.to] += e.payload.stroops;
    }
    return { balances };
  },
  validate: (state) => {
    const violations = [];
    for (const [id, bal] of Object.entries(state.balances)) {
      if (bal < 0) violations.push(`Negative balance on ${id}: ${bal}`);
    }
    return violations;
  }
};

// 1. Normal path: events replayed with upcasters, validated and promoted atomically
{
  const store = createMemoryProjectionStore();
  const source = makeSource(sampleEvents);

  const result = await buildDerivedProjectionAuthorized(
    MAINTAINER,
    accountSummarySpec,
    { source, store, upcasters: replayUpcasters },
    { promote: true }
  );

  assert.equal(result.ok, true, "#439: build must succeed");
  assert.equal(result.value.status, "promoted", "#439: projection promoted");
  assert.equal(result.value.activeVersion, 1, "#439: active version is 1");
  assert.equal(result.value.eventsProcessed, 4, "#439: all 4 events processed");
  assert.equal(result.value.state.balances["GA1"], 60, "#439: GA1 balance 100 - 30 - 10 = 60");
  assert.equal(result.value.state.balances["GB2"], 90, "#439: GB2 balance 50 + 30 + 10 = 90");
}

// 2. Failure path: invariant failure rejects promotion, leaving slot unpromoted
{
  const store = createMemoryProjectionStore();
  // Overdraft GA1: 100 - 150 = -50
  const invalidEvents = [
    makeEvent(1, "account.created", 1, { id: "GA1", balance: 100 }),
    makeEvent(2, "payment.sent", 2, { from: "GA1", to: "GB2", stroops: 150 })
  ];
  const source = makeSource(invalidEvents);

  const failResult = await buildDerivedProjectionAuthorized(
    MAINTAINER,
    accountSummarySpec,
    { source, store, upcasters: replayUpcasters },
    { promote: true }
  );

  assert.equal(failResult.ok, false, "#439: invalid state must fail validation");
  assert.equal(failResult.code, "validation_failed", "#439: error code must be validation_failed");

  const active = await store.getActive("account_balances_derived");
  assert.equal(active, undefined, "#439: active slot must NOT be promoted on validation failure");
}

// 3. Retry and Point-in-time path: untilSequence and resuming from checkpoint
{
  const store = createMemoryProjectionStore();
  const source = makeSource(sampleEvents);

  // Point in time up to sequence 2
  const pitResult = await buildDerivedProjectionAuthorized(
    MAINTAINER,
    accountSummarySpec,
    { source, store, upcasters: replayUpcasters },
    { untilSequence: 2, promote: false }
  );
  assert.equal(pitResult.ok, true);
  assert.equal(pitResult.value.eventsProcessed, 2);
  assert.equal(pitResult.value.state.balances["GA1"], 100);

  // Resume from sequence 2 to head
  const resumeResult = await buildDerivedProjectionAuthorized(
    MAINTAINER,
    accountSummarySpec,
    { source, store, upcasters: replayUpcasters },
    { mode: "resume", promote: true }
  );
  assert.equal(resumeResult.ok, true);
  assert.equal(resumeResult.value.eventsProcessed, 2, "#439: resume only processed remaining 2 events");
  assert.equal(resumeResult.value.lastSequence, 4);
}

// 4. Authorization and Rollback path: maintainers can rollback, viewers denied
{
  const store = createMemoryProjectionStore();
  const source = makeSource(sampleEvents);

  // Build v1
  await buildDerivedProjectionAuthorized(
    MAINTAINER,
    accountSummarySpec,
    { source, store, upcasters: replayUpcasters },
    { promote: true }
  );

  // Build v2
  const v2Spec = { ...accountSummarySpec, version: 2 };
  const v2Result = await buildDerivedProjectionAuthorized(
    MAINTAINER,
    v2Spec,
    { source, store, upcasters: replayUpcasters },
    { promote: true }
  );
  assert.equal(v2Result.ok, true);
  assert.equal(v2Result.value.activeVersion, 2);

  // Rollback to v1
  const rbResult = await rollbackDerivedProjectionAuthorized(MAINTAINER, "account_balances_derived", { source, store });
  assert.equal(rbResult.ok, true, "#439: rollback must succeed");
  assert.equal(rbResult.value.activeVersion, 1, "#439: active version rolled back to 1");
  assert.equal(rbResult.value.previousVersion, 2);

  // Viewer denied
  const viewerDenied = await buildDerivedProjectionAuthorized(
    VIEWER,
    accountSummarySpec,
    { source, store, upcasters: replayUpcasters },
    { promote: true }
  );
  assert.equal(viewerDenied.ok, false);
  assert.equal(viewerDenied.code, "permission_denied", "#439: viewer must be denied");
}
console.log("✓ Issue #439 verified successfully.\n");

console.log("================================================================");
console.log("   ALL 4 ISSUE VERIFICATIONS (#436, #437, #438, #439) PASSED    ");
console.log("================================================================\n");
