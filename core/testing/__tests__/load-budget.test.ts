import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBudget, runLoad, type LoadReport } from "@/core/testing/load-budget";
import { FailureInjectionEngine } from "@/core/testing/failure-injection";
import { OwnershipTransferStore } from "@/core/ownership/ownership";
import { createIsolatedAuditTrail } from "@/core/audit/audit";
import { createIdempotencyStore } from "@/core/idempotency/idempotency";
import {
  configureRollout,
  isFeatureEnabled,
  resetRolloutEngine,
  triggerEmergencyDisable
} from "@/core/feature-flags/flags";

// Budgets are deliberately loose so CI noise never flakes them; they exist to
// catch order-of-magnitude regressions (e.g. an O(n) scan becoming O(n^2)).
const OWNERSHIP_BUDGET = { maxP95Ms: 25, maxErrorRate: 0, maxHeapGrowthBytes: 256 * 1024 * 1024 };
const FLAG_BUDGET = { maxP95Ms: 5, maxErrorRate: 0 };

const NOW = 1_700_000_000_000;
const owner = { kind: "user" as const, id: "account:GALICE1234567890" };
const recipient = { kind: "user" as const, id: "account:GBOB1234567890" };
const stranger = { kind: "user" as const, id: "account:GEVE1234567890" };

describe("worst-case load and resource budgets (#392)", () => {
  let store: OwnershipTransferStore;

  beforeEach(() => {
    // Every audited write also lands in the app-wide audit trail and ledger
    // (both in localStorage); start each test from empty so budgets measure
    // this test's load, not the accumulated history of earlier tests.
    localStorage.clear();
    store = new OwnershipTransferStore(createIdempotencyStore());
    resetRolloutEngine();
  });
  afterEach(() => resetRolloutEngine());

  describe("normal path", () => {
    it("ownership propose+accept for 300 distinct resources stays within budget", async () => {
      const report = await runLoad(
        (i) => {
          const init = store.initiate({
            resourceId: `load-${i}`,
            currentOwner: owner.id,
            proposedOwner: recipient.id,
            actor: owner,
            idempotencyKey: `load-propose-${i}`,
            now: NOW
          });
          if (!init.ok) return init;
          return store.accept({ transferId: init.value.id, actor: recipient, now: NOW + 1 });
        },
        { iterations: 300, concurrency: 16 }
      );
      expect(report.errors).toBe(0);
      expect(checkBudget(report, OWNERSHIP_BUDGET).ok).toBe(true);
    });

    // Each expiry is audited and committed to the hash-chained ledger. Before
    // #392 both re-serialized their whole history per write (~2.5s here, even
    // with the audit fix alone); now ~0.4s, the rest being jsdom localStorage
    // copying the blob. 1.5s absorbs CI contention and still fails a regression.
    it("worst-case sweep of 500 simultaneously-expired proposals meets its 1.5s budget", async () => {
      for (let i = 0; i < 500; i++) {
        store.initiate({
          resourceId: `sweep-${i}`,
          currentOwner: owner.id,
          proposedOwner: recipient.id,
          actor: owner,
          expiresInMs: 60_000,
          now: NOW
        });
      }
      const report = await runLoad(() => store.sweepExpired(NOW + 120_000), { iterations: 1, concurrency: 1 });
      expect(store.sweepExpired(NOW + 120_000)).toBe(0); // all expired in the one sweep
      expect(checkBudget(report, { maxP95Ms: 1_500, maxErrorRate: 0 }).ok).toBe(true);
    });

    it("audit append cost stays flat as the trail grows (regression guard)", async () => {
      // Before #392 every write re-parsed and re-redacted the whole trail, so a
      // write at 2,000 events cost ~50x one at 200. Relative, so CI contention
      // slows both samples alike.
      const trail = createIsolatedAuditTrail();
      const write = (i: number) =>
        trail.record({
          action: "admin.config_changed",
          actor: { kind: "system", id: "load" },
          target: { kind: "flag", id: `f-${i}` }
        });
      const sample = () => runLoad(write, { iterations: 200, concurrency: 1 });

      await sample(); // JIT warm-up; trail now 200
      const small = await sample();
      for (let i = 0; i < 1_600; i++) write(i);
      const large = await sample();

      expect(trail.all()).toHaveLength(2_200);
      expect(large.p50Ms).toBeLessThan(small.p50Ms * 3 + 0.25);
    });

    it("flag evaluation with every guardrail configured stays within budget", async () => {
      configureRollout("safeOwnershipTransfer", {
        percentage: 50,
        allowedNetworks: ["testnet"],
        allowlist: Array.from({ length: 500 }, (_, i) => `G-ALLOW-${i}`),
        blocklist: Array.from({ length: 500 }, (_, i) => `G-BLOCK-${i}`)
      });
      const report = await runLoad(
        (i) => isFeatureEnabled("safeOwnershipTransfer", { subjectId: `G-SUBJECT-${i}`, network: "testnet" }),
        { iterations: 20_000, concurrency: 1 }
      );
      expect(checkBudget(report, FLAG_BUDGET).ok).toBe(true);
    });
  });

  describe("failure path", () => {
    it("reports every violated limit when injected faults blow the error budget", async () => {
      const engine = new FailureInjectionEngine();
      engine.registerRule({
        id: "load-storage-burst",
        workflow: "load",
        targetStep: "write",
        faultType: "storage_fault",
        condition: { maxTriggers: 50 },
        enabled: true
      });
      const report = await runLoad(
        () => engine.wrapAsync("load", "write", async () => "ok"),
        { iterations: 200, concurrency: 8 }
      );
      expect(report.errors).toBe(50);

      const verdict = checkBudget(report, { maxP95Ms: 1_000, maxErrorRate: 0.01, maxRetries: 0 });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.detail).toEqual([expect.stringMatching(/^error rate 0\.250 > 0\.01$/)]);
    });

    it("rejects invalid load profiles", async () => {
      await expect(runLoad(() => 1, { iterations: 0, concurrency: 1 })).rejects.toThrow(RangeError);
    });

    it("flags a latency budget breach", () => {
      const slow: LoadReport = {
        iterations: 1, errors: 0, errorRate: 0, retries: 0, p50Ms: 90, p95Ms: 90, maxMs: 90, heapGrowthBytes: 0
      };
      const verdict = checkBudget(slow, { maxP95Ms: 10, maxErrorRate: 0 });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.detail?.[0]).toMatch(/^p95/);
    });
  });

  describe("retry path", () => {
    it("recovers transient faults through retries and accounts for them in the budget", async () => {
      const engine = new FailureInjectionEngine();
      engine.registerRule({
        id: "load-timeout-burst",
        workflow: "load",
        targetStep: "rpc",
        faultType: "network_timeout",
        // The first 4 evaluations fail. With 8 workers each first attempt is a
        // distinct call, so 4 calls fail once and their retry succeeds.
        condition: { maxTriggers: 4 },
        enabled: true
      });
      const report = await runLoad(
        () => engine.wrapAsync("load", "rpc", async () => "ok"),
        { iterations: 300, concurrency: 8 },
        { maxAttempts: 3, isRetryable: (e) => (e as { code?: string }).code === "ETIMEDOUT" }
      );
      expect(report.errors).toBe(0);
      expect(report.retries).toBe(4);
      expect(checkBudget(report, { maxP95Ms: 1_000, maxErrorRate: 0, maxRetries: 4 }).ok).toBe(true);
      expect(checkBudget(report, { maxP95Ms: 1_000, maxErrorRate: 0, maxRetries: 1 }).ok).toBe(false);
    });

    it("never retries non-retryable faults", async () => {
      const report = await runLoad(
        () => { throw Object.assign(new Error("parse"), { code: "PARSE_ERROR" }); },
        { iterations: 10, concurrency: 2 },
        { maxAttempts: 5, isRetryable: (e) => (e as { code?: string }).code === "ETIMEDOUT" }
      );
      expect(report.retries).toBe(0);
      expect(report.errors).toBe(10);
    });

    it("replays 1,000 idempotent retries of one proposal without duplicate state", async () => {
      const report = await runLoad(
        () =>
          store.initiate({
            resourceId: "hot-resource",
            currentOwner: owner.id,
            proposedOwner: recipient.id,
            actor: owner,
            idempotencyKey: "hot-key-0001",
            now: NOW
          }),
        { iterations: 1_000, concurrency: 16 }
      );
      expect(report.errors).toBe(0);
      expect(store.getTransferAuditHistory(store.getActiveTransferForResource("resource", "hot-resource", NOW)!.id))
        .toHaveLength(1);
    });
  });

  describe("authorization path", () => {
    it("a storm of unauthorized proposals is rejected cheaply and mutates nothing", async () => {
      const report = await runLoad(
        (i) =>
          store.initiate({
            resourceId: `victim-${i}`,
            currentOwner: owner.id,
            proposedOwner: stranger.id,
            actor: stranger,
            now: NOW
          }),
        { iterations: 5_000, concurrency: 16 }
      );
      expect(report.errorRate).toBe(1);
      expect(report.p95Ms).toBeLessThan(OWNERSHIP_BUDGET.maxP95Ms);
      expect(store.getActiveTransferForResource("resource", "victim-0", NOW)).toBeNull();
    });

    it("an emergency-disabled flag short-circuits evaluation under load", async () => {
      triggerEmergencyDisable("safeOwnershipTransfer", { reason: "load test" });
      let enabled = 0;
      const report = await runLoad(
        (i) => {
          if (isFeatureEnabled("safeOwnershipTransfer", { subjectId: `G-${i}` })) enabled++;
        },
        { iterations: 10_000, concurrency: 1 }
      );
      expect(enabled).toBe(0);
      expect(checkBudget(report, FLAG_BUDGET).ok).toBe(true);
    });
  });
});
