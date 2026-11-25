#!/usr/bin/env node
/**
 * Automated Verification Suite for Issue #423
 *
 * Issue #423: Add deterministic replay tests for multi-actor mutations
 *
 * Verifies all 5 required paths:
 * 1. Normal path: multi-actor mutations replay, upcasting, batch folding, and atomic promotion
 * 2. Failure paths: poison events, skip policy, validation failures, and sequence ordering
 * 3. Retry path: transient source read errors, deterministic backoff, and recovery
 * 4. Authorization path: maintainer permission validation, unauthorized rejection, and audit trails
 * 5. Rollback and recovery: pointer swapping, catch-up via resume, and lock concurrency
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issue-423.mjs
 */

import assert from "node:assert/strict";

console.log("============================================================");
console.log("      AUTOMATED VERIFICATION: ISSUE #423                    ");
console.log("   DETERMINISTIC REPLAY TESTS FOR MULTI-ACTOR MUTATIONS     ");
console.log("============================================================\n");

const { getAuditTrail } = await import("../core/audit/audit.ts");
const {
  createMemoryProjectionStore,
  promoteProjection,
  replayProjection,
  rollbackProjection
} = await import("../core/replay/index.ts");
const {
  createMultiActorProjection,
  expectedMultiActorState,
  multiActorUpcasters
} = await import("../core/replay/multi-actor-mutations.ts");
const {
  createDeterministicClock,
  createReplayEvent,
  ScriptedEventLog
} = await import("../core/replay/__tests__/deterministicHarness.ts");

const MAINTAINER = { role: "maintainer", userId: "ops-lead" };
const VIEWER = { role: "viewer", userId: "guest-viewer" };

const ORGANIZER = "G_ORGANIZER_ALPHA";
const BUYER_1 = "G_BUYER_BOB";
const BUYER_2 = "G_BUYER_CHARLIE";
const SELLER_1 = "G_SELLER_ALICE";
const TREASURY = "G_TREASURY_MAIN";

function makeBaseLog() {
  return [
    createReplayEvent(1, "account.created", 1, { address: ORGANIZER, initialBalanceStroops: 10_000_000, role: "organizer" }),
    createReplayEvent(2, "account.created", 1, { address: TREASURY, initialBalanceStroops: 0, role: "treasury" }),
    createReplayEvent(3, "account.created", 1, { address: SELLER_1, initialBalanceStroops: 20_000_000, role: "seller" }),
    createReplayEvent(4, "account.created", 1, { address: BUYER_1, initialBalanceStroops: 50_000_000, role: "buyer" }),
    createReplayEvent(5, "account.created", 1, { address: BUYER_2, initialBalanceStroops: 30_000_000, role: "buyer" }),

    // Primary mint
    createReplayEvent(6, "ticket.minted", 1, {
      ticketId: "t-101",
      eventId: "e-summer-fest",
      organizer: ORGANIZER,
      buyer: SELLER_1,
      priceStroops: 5_000_000
    }),

    // Secondary transfer 1 (v1 schema: decimal string, fee split)
    createReplayEvent(7, "ticket.transferred", 1, {
      ticketId: "t-101",
      seller: SELLER_1,
      buyer: BUYER_1,
      price: "0.6",
      fee: "0.1",
      organizer: ORGANIZER,
      treasury: TREASURY,
      nonce: 1
    }),

    // Secondary transfer 2 (v2 schema: exact stroops across 4 actors)
    createReplayEvent(8, "ticket.transferred", 2, {
      ticketId: "t-101",
      seller: BUYER_1,
      buyer: BUYER_2,
      organizer: ORGANIZER,
      treasury: TREASURY,
      priceStroops: 7_000_000,
      organizerFeeStroops: 500_000,
      protocolFeeStroops: 500_000,
      sellerProceedsStroops: 6_000_000,
      nonce: 2
    }),

    // Redemption
    createReplayEvent(9, "ticket.redeemed", 1, {
      ticketId: "t-101",
      holder: BUYER_2,
      verifier: "service-gate-1",
      timestamp: 1_700_000_000
    })
  ];
}

function makeDeps(store, log, clock, auth = MAINTAINER) {
  const sleeps = [];
  return {
    source: log,
    store,
    auth,
    upcasters: multiActorUpcasters,
    now: clock.now,
    sleep: async (ms) => { sleeps.push(ms); },
    sleeps
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NORMAL PATH
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> 1. Testing Normal Path: Multi-Actor Mutations Replay & Promotion...");
{
  getAuditTrail().reset();
  const store = createMemoryProjectionStore();
  const clock = createDeterministicClock(1_000);
  const log = new ScriptedEventLog(makeBaseLog());
  const applied = [];
  const projection = createMultiActorProjection(1, applied);

  const result = await replayProjection(projection, makeDeps(store, log, clock), {
    batchSize: 3,
    promote: true,
    runId: "run-multi-actor-verify"
  });

  assert.equal(result.ok, true, "Replay must succeed on valid multi-actor log");
  assert.equal(result.value.status, "promoted");
  assert.equal(result.value.eventsRead, 9);
  assert.equal(result.value.eventsApplied, 9);
  assert.equal(result.value.eventsUpcast, 1, "v1 transfer event must be upcast to v2");

  const slot = store.getSlot("multi-actor-settlement", 1);
  assert.ok(slot, "Slot multi-actor-settlement@v1 must exist");
  assert.equal(slot.status, "ready");

  const active = store.getActive("multi-actor-settlement");
  assert.equal(active?.version, 1, "Active pointer must be set to version 1");

  // Balance and conservation checks
  assert.equal(slot.state.accounts[ORGANIZER].balanceStroops, 16_000_000);
  assert.equal(slot.state.accounts[TREASURY].balanceStroops, 1_000_000);
  assert.equal(slot.state.tickets["t-101"].status, "redeemed");
  assert.equal(slot.state.tickets["t-101"].ownerAddress, BUYER_2);
  assert.equal(slot.state.transfersCompleted, 2);
  assert.equal(slot.state.redemptionsCompleted, 1);

  // Match serial fold
  const expected = expectedMultiActorState(makeBaseLog());
  assert.deepEqual(slot.state, expected, "Replayed state must exactly match serial fold");

  // Point-in-time check (untilSequence)
  const pitStore = createMemoryProjectionStore();
  const pitResult = await replayProjection(createMultiActorProjection(1), makeDeps(pitStore, new ScriptedEventLog(makeBaseLog()), clock), {
    batchSize: 4,
    untilSequence: 8,
    promote: true
  });
  assert.equal(pitResult.ok, true);
  assert.equal(pitResult.value.toSequence, 8);
  const pitSlot = pitStore.getSlot("multi-actor-settlement", 1);
  assert.equal(pitSlot.state.tickets["t-101"].status, "transferred", "At seq 8 ticket should not be redeemed yet");
}
console.log("✓ Normal path verified.\n");

// ─────────────────────────────────────────────────────────────────────────────
// 2. FAILURE PATHS
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> 2. Testing Failure Paths: Poison Events, Skip Policy, Validation...");
{
  const store = createMemoryProjectionStore();
  const clock = createDeterministicClock(0);
  const base = makeBaseLog();

  // 2a. Poison event halt
  const poisonLog = [
    ...base.slice(0, 7),
    createReplayEvent(8, "ticket.transferred", 2, {
      ticketId: "t-101",
      seller: BUYER_1,
      buyer: BUYER_2,
      organizer: ORGANIZER,
      treasury: TREASURY,
      priceStroops: 999_000_000, // Insolvent buyer
      organizerFeeStroops: 1_000_000,
      protocolFeeStroops: 1_000_000,
      sellerProceedsStroops: 997_000_000,
      nonce: 2
    })
  ];

  const poisonRes = await replayProjection(createMultiActorProjection(1), makeDeps(store, new ScriptedEventLog(poisonLog), clock), {
    batchSize: 4,
    promote: true
  });
  assert.equal(poisonRes.ok, false);
  assert.equal(poisonRes.code, "poison_event");
  assert.equal(poisonRes.detail.sequence, 8);
  assert.equal(store.getActive("multi-actor-settlement"), undefined, "Failed replay must not promote");

  // 2b. Skip policy
  const skipLog = [
    ...base.slice(0, 7),
    createReplayEvent(8, "ticket.transferred", 2, {
      ticketId: "t-101",
      seller: BUYER_1,
      buyer: BUYER_2,
      organizer: ORGANIZER,
      treasury: TREASURY,
      priceStroops: 10_000_000,
      organizerFeeStroops: 100, // Invalid split sum
      protocolFeeStroops: 100,
      sellerProceedsStroops: 100,
      nonce: 2
    })
  ];
  const skipRes = await replayProjection(createMultiActorProjection(1), makeDeps(store, new ScriptedEventLog(skipLog), clock), {
    batchSize: 4,
    poisonPolicy: "skip",
    maxSkipped: 1,
    promote: true
  });
  assert.equal(skipRes.ok, true, "Single poison event should be skipped under skip policy");
  assert.equal(skipRes.value.skipped.length, 1);
  assert.equal(skipRes.value.skipped[0].sequence, 8);

  // 2c. Validation failure
  const valStore = createMemoryProjectionStore();
  const invalidProjection = {
    ...createMultiActorProjection(1),
    validate: () => ["Conservation invariant breach: negative balance detected"]
  };
  const valRes = await replayProjection(invalidProjection, makeDeps(valStore, new ScriptedEventLog(base), clock), {
    batchSize: 5,
    promote: true
  });
  assert.equal(valRes.ok, false);
  assert.equal(valRes.code, "validation_failed");
}
console.log("✓ Failure paths verified.\n");

// ─────────────────────────────────────────────────────────────────────────────
// 3. RETRY PATH
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> 3. Testing Retry Path: Transient Failures & Exponential Backoff...");
{
  const store = createMemoryProjectionStore();
  const clock = createDeterministicClock(0);
  const log = new ScriptedEventLog(makeBaseLog(), {
    failures: { 0: 1, 1: 1 } // Reads 0 and 1 fail, succeeds on 3rd attempt (read 2)
  });
  const deps = makeDeps(store, log, clock);

  const retryRes = await replayProjection(createMultiActorProjection(1), deps, {
    batchSize: 5,
    maxRetries: 3,
    retryDelayMs: 150,
    promote: true
  });

  assert.equal(retryRes.ok, true, "Replay should recover after transient source failures");
  assert.equal(retryRes.value.retries, 2);
  assert.deepEqual(deps.sleeps, [150, 300], "Exponential backoff delays must match formula");
  assert.equal(retryRes.value.status, "promoted");
}
console.log("✓ Retry path verified.\n");

// ─────────────────────────────────────────────────────────────────────────────
// 4. AUTHORIZATION PATH
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> 4. Testing Authorization Path: Privileged Checks & Auditing...");
{
  getAuditTrail().reset();
  const store = createMemoryProjectionStore();
  const clock = createDeterministicClock(0);

  // 4a. Unauthorized caller rejected
  const unauthRes = await replayProjection(
    createMultiActorProjection(1),
    makeDeps(store, new ScriptedEventLog(makeBaseLog()), clock, VIEWER),
    { promote: true }
  );
  assert.equal(unauthRes.ok, false);
  assert.equal(unauthRes.code, "replay_unauthorized");

  const deniedAudits = getAuditTrail().all().filter((e) => e.action === "projection.replayed");
  assert.equal(deniedAudits.length, 1);
  assert.equal(deniedAudits[0].outcome, "denied");
  assert.equal(deniedAudits[0].errorCode, "replay_unauthorized");

  // 4b. Authorized maintainer permitted
  const authRes = await replayProjection(
    createMultiActorProjection(1),
    makeDeps(store, new ScriptedEventLog(makeBaseLog()), clock, MAINTAINER),
    { promote: true }
  );
  assert.equal(authRes.ok, true);
  const allowedAudits = getAuditTrail().all().filter((e) => e.outcome === "allowed");
  assert.ok(allowedAudits.length > 0);
}
console.log("✓ Authorization path verified.\n");

// ─────────────────────────────────────────────────────────────────────────────
// 5. ROLLBACK AND RECOVERY
// ─────────────────────────────────────────────────────────────────────────────
console.log("--> 5. Testing Rollback & Recovery: Pointer Swaps, Catch-Up, Lock Concurrency...");
{
  const store = createMemoryProjectionStore();
  const clock = createDeterministicClock(0);
  const base = makeBaseLog();

  // Build v1
  await replayProjection(createMultiActorProjection(1), makeDeps(store, new ScriptedEventLog(base.slice(0, 6)), clock), {
    promote: true
  });
  assert.equal(store.getActive("multi-actor-settlement")?.version, 1);

  // Build v2
  await replayProjection(createMultiActorProjection(2), makeDeps(store, new ScriptedEventLog(base), clock), {
    promote: true
  });
  assert.deepEqual(store.getActive("multi-actor-settlement"), { version: 2, previousVersion: 1 });

  // Roll back to v1
  const rollbackRes = rollbackProjection("multi-actor-settlement", makeDeps(store, new ScriptedEventLog([]), clock));
  assert.equal(rollbackRes.ok, true);
  assert.equal(store.getActive("multi-actor-settlement")?.version, 1, "Rollback must restore version 1 as active");

  // Catch-up on resumed live slot with appended multi-actor ticket
  const catchupLog = new ScriptedEventLog(base, {
    appendPlan: {
      0: [
        createReplayEvent(10, "ticket.minted", 1, {
          ticketId: "t-102",
          eventId: "e-summer-fest",
          organizer: ORGANIZER,
          buyer: BUYER_1,
          priceStroops: 2_000_000
        })
      ]
    }
  });

  const resumed = await replayProjection(createMultiActorProjection(1), makeDeps(store, catchupLog, clock), {
    mode: "resume"
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.value.status, "ready");
  assert.equal(resumed.value.toSequence, 10);
  const v1Slot = store.getSlot("multi-actor-settlement", 1);
  assert.ok(v1Slot.state.tickets["t-102"], "Appended ticket must be folded on resume");

  // Lock concurrency
  store.acquireLock("multi-actor-settlement", "worker-1", 0, 60_000);
  const lockCollision = await replayProjection(
    createMultiActorProjection(3),
    makeDeps(store, new ScriptedEventLog(base), clock),
    { runId: "worker-2" }
  );
  assert.equal(lockCollision.ok, false);
  assert.equal(lockCollision.code, "replay_in_progress", "Held lock must prevent concurrent collision");
}
console.log("✓ Rollback and recovery verified.\n");

console.log("============================================================");
console.log("   ISSUE #423 VERIFIED CLEANLY ACROSS ALL 5 PATHS!          ");
console.log("============================================================\n");
