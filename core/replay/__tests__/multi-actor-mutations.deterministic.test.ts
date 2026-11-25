import { beforeEach, describe, expect, it } from "vitest";
import { getAuditTrail } from "@/core/audit/audit";
import {
  createMemoryProjectionStore,
  promoteProjection,
  replayProjection,
  rollbackProjection,
  type EventSource,
  type ProjectionStore,
  type ReplayDeps,
  type ReplayEvent
} from "../index";
import {
  createMultiActorProjection,
  expectedMultiActorState,
  multiActorUpcasters,
  type MultiActorMutationState
} from "../multi-actor-mutations";
import {
  createDeterministicClock,
  createReplayEvent,
  ScriptedEventLog
} from "./deterministicHarness";

const maintainer = { role: "maintainer" as const, userId: "ops-lead" };
const viewer = { role: "viewer" as const, userId: "viewer-guest" };
const service = { role: "service" as const, userId: "service-worker" };

const ORGANIZER = "G_ORGANIZER_ALPHA";
const BUYER_1 = "G_BUYER_BOB";
const BUYER_2 = "G_BUYER_CHARLIE";
const SELLER_1 = "G_SELLER_ALICE";
const TREASURY = "G_TREASURY_MAIN";

function makeBaseMultiActorLog(): readonly ReplayEvent[] {
  return [
    // 1-4: Account creations
    createReplayEvent(1, "account.created", 1, { address: ORGANIZER, initialBalanceStroops: 10_000_000, role: "organizer" }),
    createReplayEvent(2, "account.created", 1, { address: TREASURY, initialBalanceStroops: 0, role: "treasury" }),
    createReplayEvent(3, "account.created", 1, { address: SELLER_1, initialBalanceStroops: 20_000_000, role: "seller" }),
    createReplayEvent(4, "account.created", 1, { address: BUYER_1, initialBalanceStroops: 50_000_000, role: "buyer" }),
    createReplayEvent(5, "account.created", 1, { address: BUYER_2, initialBalanceStroops: 30_000_000, role: "buyer" }),

    // 6: Ticket minting: Organizer sells primary ticket to Seller_1 for 5 XLM (50,000,000 stroops)
    createReplayEvent(6, "ticket.minted", 1, {
      ticketId: "t-101",
      eventId: "e-summer-fest",
      organizer: ORGANIZER,
      buyer: SELLER_1,
      priceStroops: 5_000_000
    }),

    // 7: Secondary multi-actor transfer (v1 legacy format, will be upcast to v2)
    // Seller_1 sells to Buyer_1 for 6 XLM with 1 XLM fee
    createReplayEvent(7, "ticket.transferred", 1, {
      ticketId: "t-101",
      seller: SELLER_1,
      buyer: BUYER_1,
      price: "0.6", // 6,000,000 stroops
      fee: "0.1",   // 1,000,000 stroops fee split 500k organizer, 500k treasury
      organizer: ORGANIZER,
      treasury: TREASURY,
      nonce: 1
    }),

    // 8: Another multi-actor transfer (v2 format with exact stroops)
    // Buyer_1 transfers to Buyer_2 for 7,000,000 stroops (500k org fee, 500k treasury fee, 6,000,000 seller proceeds)
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

    // 9: Ticket redemption by final holder Buyer_2
    createReplayEvent(9, "ticket.redeemed", 1, {
      ticketId: "t-101",
      holder: BUYER_2,
      verifier: "service-gate-1",
      timestamp: 1_700_000_000
    })
  ];
}

function createDeps(
  store: ProjectionStore,
  source: EventSource,
  clock: ReturnType<typeof createDeterministicClock>,
  auth: ReplayDeps["auth"] = maintainer
): ReplayDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    source,
    store,
    auth,
    upcasters: multiActorUpcasters,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps
  };
}

describe("deterministic replay tests for multi-actor mutations (#423)", () => {
  let store: ProjectionStore;

  beforeEach(() => {
    getAuditTrail().reset();
    store = createMemoryProjectionStore();
  });

  describe("normal path: interleaved multi-actor mutations and promotion", () => {
    it("replays multi-actor events across batch boundaries, upcasts v1 events, and atomically promotes", async () => {
      const clock = createDeterministicClock(1_000);
      const applied: string[] = [];
      const log = new ScriptedEventLog(makeBaseMultiActorLog());
      const projection = createMultiActorProjection(1, applied);

      const result = await replayProjection(projection, createDeps(store, log, clock), {
        batchSize: 3,
        promote: true,
        runId: "run-multi-actor-normal"
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toMatchObject({
        status: "promoted",
        fromSequence: 0,
        toSequence: 9,
        batches: 4,
        eventsRead: 9,
        eventsApplied: 9,
        eventsUpcast: 1, // event #7 upcast from v1 to v2
        retries: 0
      });

      const slot = store.getSlot<MultiActorMutationState>("multi-actor-settlement", 1);
      expect(slot).toBeDefined();
      expect(slot?.status).toBe("ready");

      const active = store.getActive("multi-actor-settlement");
      expect(active?.version).toBe(1);

      // Verify exact multi-actor state against serial fold
      const expected = expectedMultiActorState(makeBaseMultiActorLog());
      expect(slot?.state).toEqual(expected);

      // Specific balance assertions:
      // Organizer: 10M initial + 5M primary + 500k v1 fee + 500k v2 fee = 16M
      expect(slot?.state.accounts[ORGANIZER].balanceStroops).toBe(16_000_000);
      // Treasury: 0 initial + 500k v1 fee + 500k v2 fee = 1M
      expect(slot?.state.accounts[TREASURY].balanceStroops).toBe(1_000_000);
      // Ticket status is redeemed and owned by Buyer 2
      expect(slot?.state.tickets["t-101"].status).toBe("redeemed");
      expect(slot?.state.tickets["t-101"].ownerAddress).toBe(BUYER_2);
      expect(slot?.state.tickets["t-101"].transferCount).toBe(2);
    });

    it("supports point-in-time multi-actor replay using untilSequence", async () => {
      const clock = createDeterministicClock(0);
      const log = new ScriptedEventLog(makeBaseMultiActorLog());
      const projection = createMultiActorProjection(1);

      // Stop before redemption (at sequence 8)
      const result = await replayProjection(projection, createDeps(store, log, clock), {
        batchSize: 4,
        untilSequence: 8,
        promote: true
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.toSequence).toBe(8);

      const slot = store.getSlot<MultiActorMutationState>("multi-actor-settlement", 1);
      // At sequence 8, ticket status should be transferred, not yet redeemed
      expect(slot?.state.tickets["t-101"].status).toBe("transferred");
      expect(slot?.state.redemptionsCompleted).toBe(0);
      expect(slot?.state.transfersCompleted).toBe(2);
    });
  });

  describe("failure paths: poison events, skip policy, validation failures, and sequence errors", () => {
    it("halts cleanly on poison multi-actor event with default halt policy", async () => {
      const clock = createDeterministicClock(0);
      const base = makeBaseMultiActorLog();
      // Insert poison event: buyer attempts transfer with insufficient balance (requires 100M but has 50M)
      const poisonLog = [
        ...base.slice(0, 7),
        createReplayEvent(8, "ticket.transferred", 2, {
          ticketId: "t-101",
          seller: BUYER_1,
          buyer: BUYER_2,
          organizer: ORGANIZER,
          treasury: TREASURY,
          priceStroops: 999_000_000,
          organizerFeeStroops: 1_000_000,
          protocolFeeStroops: 1_000_000,
          sellerProceedsStroops: 997_000_000,
          nonce: 2
        }),
        ...base.slice(8)
      ];

      const result = await replayProjection(createMultiActorProjection(1), createDeps(store, new ScriptedEventLog(poisonLog), clock), {
        batchSize: 4,
        promote: true
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("poison_event");
      expect(result.detail.sequence).toBe(8);
      expect(store.getActive("multi-actor-settlement")).toBeUndefined();
    });

    it("skips isolated poison multi-actor events when poisonPolicy is skip and maxSkipped is allowed", async () => {
      const clock = createDeterministicClock(0);
      const base = makeBaseMultiActorLog();
      // Broken event with invalid fee split
      const corruptedLog = [
        ...base.slice(0, 7),
        createReplayEvent(8, "ticket.transferred", 2, {
          ticketId: "t-101",
          seller: BUYER_1,
          buyer: BUYER_2,
          organizer: ORGANIZER,
          treasury: TREASURY,
          priceStroops: 10_000_000,
          organizerFeeStroops: 100, // Inconsistent split! 100 + 100 + 100 != 10M
          protocolFeeStroops: 100,
          sellerProceedsStroops: 100,
          nonce: 2
        })
      ];

      const result = await replayProjection(createMultiActorProjection(1), createDeps(store, new ScriptedEventLog(corruptedLog), clock), {
        batchSize: 4,
        poisonPolicy: "skip",
        maxSkipped: 1,
        promote: true
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.skipped.length).toBe(1);
      expect(result.value.skipped[0].sequence).toBe(8);
      expect(result.value.skipped[0].reason).toContain("fee split mismatch");
    });

    it("fails with too_many_skipped when skipped poison mutations exceed maxSkipped", async () => {
      const clock = createDeterministicClock(0);
      const brokenLog = [
        createReplayEvent(1, "account.created", 1, { address: "G_A", initialBalanceStroops: -50 }),
        createReplayEvent(2, "account.created", 1, { address: "G_B", initialBalanceStroops: -100 })
      ];

      const result = await replayProjection(createMultiActorProjection(1), createDeps(store, new ScriptedEventLog(brokenLog), clock), {
        batchSize: 1,
        poisonPolicy: "skip",
        maxSkipped: 1
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("too_many_skipped");
    });

    it("rejects promotion when multi-actor invariant validation fails", async () => {
      const clock = createDeterministicClock(0);
      // Malformed projection where validation fails due to negative total fees
      const invalidProjection = {
        ...createMultiActorProjection(1),
        validate: () => ["multi-actor invariant violation: conservation of value broken"]
      };

      const result = await replayProjection(invalidProjection, createDeps(store, new ScriptedEventLog(makeBaseMultiActorLog()), clock), {
        batchSize: 5,
        promote: true
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("validation_failed");
      expect(store.getActive("multi-actor-settlement")).toBeUndefined();
    });
  });

  describe("retry paths: transient source failures with deterministic backoff", () => {
    it("retries transient source read failures and recovers deterministically", async () => {
      const clock = createDeterministicClock(0);
      // Fail read index 0 twice, then succeed
      const log = new ScriptedEventLog(makeBaseMultiActorLog(), {
        failures: { 0: 1, 1: 1 }
      });

      const deps = createDeps(store, log, clock);
      const result = await replayProjection(createMultiActorProjection(1), deps, {
        batchSize: 5,
        maxRetries: 3,
        retryDelayMs: 100,
        promote: true
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.retries).toBe(2);
      expect(deps.sleeps).toEqual([100, 200]); // exponential backoff 100ms, 200ms
      expect(result.value.status).toBe("promoted");
    });

    it("fails with source_unavailable when retries are exhausted", async () => {
      const clock = createDeterministicClock(0);
      // 5 consecutive failures with maxRetries: 2
      const log = new ScriptedEventLog(makeBaseMultiActorLog(), {
        failures: { 0: 5 }
      });

      const result = await replayProjection(createMultiActorProjection(1), createDeps(store, log, clock), {
        batchSize: 5,
        maxRetries: 2
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("source_unavailable");
      expect(result.detail.retries).toBe(3);
    });
  });

  describe("authorization paths: privilege checks and audit logs", () => {
    it("authorizes maintainer and records successful audit record", async () => {
      const clock = createDeterministicClock(0);
      const log = new ScriptedEventLog(makeBaseMultiActorLog());

      const result = await replayProjection(createMultiActorProjection(1), createDeps(store, log, clock, maintainer), {
        batchSize: 10,
        promote: true
      });

      expect(result.ok).toBe(true);
      const audits = getAuditTrail().all().filter((e) => e.action === "projection.replayed");
      expect(audits.length).toBeGreaterThan(0);
      const latest = audits[audits.length - 1];
      expect(latest.actor.kind).toBe("maintainer");
      expect(latest.outcome).toBe("allowed");
    });

    it("refuses unauthorized viewer and records denied audit record", async () => {
      const clock = createDeterministicClock(0);
      const log = new ScriptedEventLog(makeBaseMultiActorLog());

      const result = await replayProjection(createMultiActorProjection(1), createDeps(store, log, clock, viewer), {
        batchSize: 10,
        promote: true
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("replay_unauthorized");

      const audits = getAuditTrail().all().filter((e) => e.action === "projection.replayed");
      expect(audits.length).toBe(1);
      expect(audits[0].outcome).toBe("denied");
      expect(audits[0].errorCode).toBe("replay_unauthorized");
    });
  });

  describe("rollback and recovery: pointer swaps, catch-up, and lock concurrency", () => {
    it("rolls back multi-actor projection version and allows live catch-up via resume", async () => {
      const clock = createDeterministicClock(0);
      const base = makeBaseMultiActorLog();

      // Build v1
      await replayProjection(createMultiActorProjection(1), createDeps(store, new ScriptedEventLog(base.slice(0, 6)), clock), {
        promote: true
      });
      expect(store.getActive("multi-actor-settlement")?.version).toBe(1);

      // Build v2 with events through sequence 9
      await replayProjection(createMultiActorProjection(2), createDeps(store, new ScriptedEventLog(base), clock), {
        promote: true
      });
      expect(store.getActive("multi-actor-settlement")).toEqual({ version: 2, previousVersion: 1 });

      // Roll back to v1
      const rollbackRes = rollbackProjection("multi-actor-settlement", createDeps(store, new ScriptedEventLog([]), clock));
      expect(rollbackRes.ok).toBe(true);
      expect(store.getActive("multi-actor-settlement")?.version).toBe(1);

      // Catch-up on resumed live slot with appended multi-actor transfer
      const appendedLog = new ScriptedEventLog(base, {
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

      const resumed = await replayProjection(createMultiActorProjection(1), createDeps(store, appendedLog, clock), {
        mode: "resume"
      });

      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.value.status).toBe("ready");
      expect(resumed.value.toSequence).toBe(10);
      const v1Slot = store.getSlot<MultiActorMutationState>("multi-actor-settlement", 1);
      expect(v1Slot?.state.tickets["t-102"]).toBeDefined();
    });

    it("prevents concurrent replay collision with lock acquisition", async () => {
      const clock = createDeterministicClock(0);
      // Pre-acquire lock by worker-alpha
      store.acquireLock("multi-actor-settlement", "worker-alpha", 0, 60_000);

      // Worker-beta attempts to replay the same projection
      const result = await replayProjection(
        createMultiActorProjection(3),
        createDeps(store, new ScriptedEventLog(makeBaseMultiActorLog()), clock),
        { runId: "worker-beta" }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("replay_in_progress");
    });
  });
});
