import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/core/auth/middleware";
import {
  createMemoryQuotaStorage,
  createQuotaStore,
  DEFAULT_RESOURCE_BUDGET_PROFILE,
  evaluateResourceBudget,
  grantEmergencyBudgetOverride,
  runWorstCaseLoadTest,
  type WorstCaseScenario
} from "@/core/quota";

const MAINTAINER: AuthContext = { role: "maintainer", userId: "ops-admin" };
const VIEWER: AuthContext = { role: "viewer", userId: "viewer-1" };
const SERVICE: AuthContext = { role: "service", userId: "svc-1" };

describe("Worst-Case Load Tests and Resource Budgets (#436)", () => {
  describe("Normal path", () => {
    it("handles concurrent requests within budget limits cleanly", async () => {
      const scenario: WorstCaseScenario = {
        name: "concurrency_within_budget",
        operation: "ticket.issue",
        resource: "storage",
        actorIds: ["actor-1", "actor-2", "actor-3"],
        requestsPerActor: 5,
        costPerRequest: 10
      };

      const result = await runWorstCaseLoadTest(scenario);

      expect(result.totalRequests).toBe(15);
      expect(result.succeededCount).toBe(15);
      expect(result.rejectedCount).toBe(0);
      expect(result.resourceExhausted).toBe(false);
      expect(result.totalCostConsumed).toBe(150);
      expect(result.violations).toHaveLength(0);
      expect(result.peakConcurrency).toBeGreaterThan(0);
    });

    it("evaluates budget profile correctly under nominal concurrency", () => {
      const evaluation = evaluateResourceBudget(DEFAULT_RESOURCE_BUDGET_PROFILE, {
        resource: "compute",
        cost: 25,
        currentInFlight: 10
      });

      expect(evaluation.ok).toBe(true);
      if (!evaluation.ok) return;
      expect(evaluation.value.allowed).toBe(true);
      expect(evaluation.value.shed).toBe(false);
    });
  });

  describe("Failure path", () => {
    it("sheds load when quota is exhausted by high-volume burst", async () => {
      // ticket.issue has per-principal limit of 500
      const scenario: WorstCaseScenario = {
        name: "burst_exceeding_principal_limit",
        operation: "ticket.issue",
        resource: "storage",
        actorIds: ["actor-heavy"],
        requestsPerActor: 60,
        costPerRequest: 10 // 60 * 10 = 600 > 500
      };

      const result = await runWorstCaseLoadTest(scenario);

      expect(result.totalRequests).toBe(60);
      expect(result.succeededCount).toBe(50); // 50 * 10 = 500
      expect(result.rejectedCount).toBe(10);
      expect(result.resourceExhausted).toBe(true);
      expect(result.totalCostConsumed).toBe(500);
      expect(result.violations).toHaveLength(0);
    });

    it("rejects invalid or negative cost values", () => {
      const zeroCost = evaluateResourceBudget(DEFAULT_RESOURCE_BUDGET_PROFILE, {
        resource: "compute",
        cost: 0,
        currentInFlight: 1
      });
      expect(zeroCost).toEqual({ ok: false, code: "quota_invalid_cost" });

      const negativeCost = evaluateResourceBudget(DEFAULT_RESOURCE_BUDGET_PROFILE, {
        resource: "storage",
        cost: -5,
        currentInFlight: 1
      });
      expect(negativeCost).toEqual({ ok: false, code: "quota_invalid_cost" });

      const excessiveCost = evaluateResourceBudget(DEFAULT_RESOURCE_BUDGET_PROFILE, {
        resource: "external_api",
        cost: 500, // max is 20
        currentInFlight: 1
      });
      expect(excessiveCost).toEqual({ ok: false, code: "quota_invalid_cost" });
    });

    it("reports unknown operation error gracefully", async () => {
      const scenario: WorstCaseScenario = {
        name: "unknown_op",
        operation: "invalid.operation.name",
        resource: "compute",
        actorIds: ["actor-1"],
        requestsPerActor: 1,
        costPerRequest: 1
      };

      const result = await runWorstCaseLoadTest(scenario);
      expect(result.violations.some((v) => v.includes("Unknown operation"))).toBe(true);
    });
  });

  describe("Retry and Isolation path", () => {
    it("isolates abusive principals so non-abusive principals are not starved", async () => {
      const scenario: WorstCaseScenario = {
        name: "noisy_neighbor_isolation",
        operation: "ticket.issue",
        resource: "storage",
        actorIds: ["abusive-actor", "innocent-actor"],
        requestsPerActor: 60,
        costPerRequest: 10
      };

      const result = await runWorstCaseLoadTest(scenario);

      // Both actors requested 600 cost against 500 limit
      expect(result.actorBreakdown["abusive-actor"].succeeded).toBe(50);
      expect(result.actorBreakdown["abusive-actor"].rejected).toBe(10);
      expect(result.actorBreakdown["innocent-actor"].succeeded).toBe(50);
      expect(result.actorBreakdown["innocent-actor"].rejected).toBe(10);
    });

    it("allows retrying after window progression", async () => {
      let currentTime = 1_700_000_000_000;
      const now = () => currentTime;
      const storage = createMemoryQuotaStorage();
      const store = createQuotaStore({ storage, now });

      // Spend full quota
      const first = await store.consume({
        operation: "ticket.transfer",
        principal: "actor-retry",
        cost: 20
      });
      expect(first.ok).toBe(true);

      // Immediate retry is rejected
      const immediate = await store.consume({
        operation: "ticket.transfer",
        principal: "actor-retry",
        cost: 1
      });
      expect(immediate.ok).toBe(false);

      // Advance clock by 1 hour (windowMs)
      currentTime += 60 * 60 * 1_000 + 1;

      // Retry now succeeds
      const retried = await store.consume({
        operation: "ticket.transfer",
        principal: "actor-retry",
        cost: 5
      });
      expect(retried.ok).toBe(true);
    });
  });

  describe("Authorization path", () => {
    it("allows maintainers with admin:quota to grant emergency budget overrides", async () => {
      const storage = createMemoryQuotaStorage();
      const store = createQuotaStore({ storage, now: () => 1_700_000_000_000 });

      const overrideResult = await grantEmergencyBudgetOverride(store, MAINTAINER, {
        operation: "ticket.issue",
        subject: "actor-vip",
        overrideLimit: 2_000,
        reason: "VIP festival launch surge capacity",
        ttlMs: 30 * 60 * 1_000
      });

      expect(overrideResult.ok).toBe(true);
      if (!overrideResult.ok) return;
      expect(overrideResult.value.granted).toBe(true);
      expect(overrideResult.value.newLimit).toBe(2_000);
    });

    it("rejects unauthorized actors attempting to grant budget overrides", async () => {
      const storage = createMemoryQuotaStorage();
      const store = createQuotaStore({ storage, now: () => 1_700_000_000_000 });

      const viewerAttempt = await grantEmergencyBudgetOverride(store, VIEWER, {
        operation: "ticket.issue",
        subject: "actor-vip",
        overrideLimit: 2_000,
        reason: "Unauthorized attempt",
        ttlMs: 30 * 60 * 1_000
      });
      expect(viewerAttempt).toEqual({ ok: false, code: "quota_override_denied" });

      const serviceAttempt = await grantEmergencyBudgetOverride(store, SERVICE, {
        operation: "ticket.issue",
        subject: "actor-vip",
        overrideLimit: 2_000,
        reason: "Service attempt",
        ttlMs: 30 * 60 * 1_000
      });
      expect(serviceAttempt).toEqual({ ok: false, code: "quota_override_denied" });
    });
  });
});
