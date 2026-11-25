/**
 * Feature Rollout Guard and Emergency Disablement (#414)
 *
 * Covers normal operation, failure thresholds, consecutive-failure rollback,
 * manual rollback, state consistency checks with remediation, and authorization
 * paths (allowlist / blocklist / network targeting).
 *
 * Edge cases:
 * - Guard short-circuits once tripped: further record calls are no-ops.
 * - Post-rollback flag must evaluate to `false` even without an explicit
 *   `clearEmergencyDisable` call in the test — the guard trips the kill-switch.
 * - stateConsistent is `true` only when every violation has a matching
 *   remediation (lengths match).
 * - `onRollback` is invoked exactly once per rollback event.
 *
 * Recovery / rollback behavior:
 * - After a guard trips, call `resetRolloutEngine()` and re-instantiate a new
 *   `RolloutGuard` to begin a fresh rollout — the old guard instance stays tripped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRolloutGuard, RolloutGuard } from "@/core/feature-flags/rollout-guard";
import { isFeatureEnabled, resetRolloutEngine } from "@/core/feature-flags/flags";

beforeEach(() => {
  resetRolloutEngine();
});

afterEach(() => {
  resetRolloutEngine();
});

// ---------------------------------------------------------------------------
// Normal path
// ---------------------------------------------------------------------------
describe("RolloutGuard – normal operation", () => {
  it("returns true for an enabled flag within percentage", () => {
    const guard = createRolloutGuard({
      flag: "policySimulationPreview",
      riskTier: "low",
      percentage: 100
    });

    expect(guard.isEnabled()).toBe(true);
    expect(guard.isTripped()).toBe(false);
  });

  it("returns false when percentage is 0", () => {
    const guard = createRolloutGuard({
      flag: "policySimulationPreview",
      riskTier: "low",
      percentage: 0
    });

    expect(guard.isEnabled({ subjectId: "user-abc" })).toBe(false);
  });

  it("tracks successes correctly", () => {
    const guard = createRolloutGuard({
      flag: "contributorDiagnostics",
      riskTier: "low",
      percentage: 100
    });

    guard.recordSuccess();
    guard.recordSuccess();
    guard.recordSuccess();

    const metrics = guard.getMetrics();
    expect(metrics.successes).toBe(3);
    expect(metrics.failures).toBe(0);
    expect(metrics.errorRatePercent).toBe(0);
    expect(guard.isTripped()).toBe(false);
  });

  it("exposes guard id and scope", () => {
    const guard = createRolloutGuard({
      flag: "safeOwnershipTransfer",
      riskTier: "medium",
      percentage: 50,
      allowedNetworks: ["testnet"]
    });

    expect(guard.id).toMatch(/^guard-safeOwnershipTransfer-/);
    expect(guard.scope.percentage).toBe(50);
    expect(guard.scope.riskTier).toBe("medium");
    expect(guard.scope.allowedNetworks).toContain("testnet");
  });

  it("last rollback report is null before any rollback", () => {
    const guard = createRolloutGuard({
      flag: "fieldLevelExportAuth",
      riskTier: "low",
      percentage: 100
    });

    expect(guard.getLastRollbackReport()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure / automatic rollback
// ---------------------------------------------------------------------------
describe("RolloutGuard – failure thresholds and automatic rollback", () => {
  it("does not trip before minimum samples are reached", () => {
    const guard = createRolloutGuard({
      flag: "policySimulationPreview",
      riskTier: "low",
      percentage: 100,
      errorThresholdPercent: 20,
      minSamples: 5
    });

    // 2 failures, only 2 total — below minSamples
    guard.recordFailure("transient");
    guard.recordFailure("transient");

    expect(guard.isTripped()).toBe(false);
    expect(guard.recordFailure("transient")).toBeNull(); // still below minSamples
  });

  it("trips automatically when error rate exceeds threshold", () => {
    const guard = createRolloutGuard({
      flag: "policySimulationPreview",
      riskTier: "medium",
      percentage: 100,
      errorThresholdPercent: 30,
      minSamples: 4
    });

    guard.recordSuccess();
    guard.recordFailure("err");
    guard.recordFailure("err");
    // 2 failures / 3 total = 66.7% — above 30% threshold but only 3 samples
    expect(guard.isTripped()).toBe(false);

    const report = guard.recordFailure("err");
    // Now 3 failures / 4 total = 75% — above threshold AND >= minSamples
    expect(report).not.toBeNull();
    expect(report!.rollbackTriggered).toBe(true);
    expect(report!.postRollbackFlagDisabled).toBe(true);
    expect(guard.isTripped()).toBe(true);
    expect(isFeatureEnabled("policySimulationPreview")).toBe(false);
  });

  it("trips when consecutive-failure limit is reached before rate threshold", () => {
    // high-risk tier: maxConsecutiveFailures defaults to 3
    const guard = createRolloutGuard({
      flag: "safeOwnershipTransfer",
      riskTier: "high",
      percentage: 100,
      errorThresholdPercent: 50,
      minSamples: 20 // high minSamples so rate threshold won't fire first
    });

    guard.recordSuccess();
    guard.recordSuccess();
    guard.recordFailure("f1");
    guard.recordFailure("f2");
    const report = guard.recordFailure("f3"); // 3rd consecutive failure

    expect(report).not.toBeNull();
    expect(report!.rollbackTriggered).toBe(true);
    expect(guard.isTripped()).toBe(true);
  });

  it("critical tier uses maxConsecutiveFailures of 3", () => {
    const guard = createRolloutGuard({
      flag: "detailedFriendbotClassification",
      riskTier: "critical",
      percentage: 100,
      minSamples: 100 // prevent rate-based trip
    });

    guard.recordFailure("f1");
    guard.recordFailure("f2");
    expect(guard.isTripped()).toBe(false);
    guard.recordFailure("f3");
    expect(guard.isTripped()).toBe(true);
  });

  it("low-risk tier uses maxConsecutiveFailures of 5", () => {
    const guard = createRolloutGuard({
      flag: "contributorDiagnostics",
      riskTier: "low",
      percentage: 100,
      minSamples: 100
    });

    for (let i = 0; i < 4; i++) {
      guard.recordFailure(`f${i}`);
      expect(guard.isTripped()).toBe(false);
    }
    guard.recordFailure("f5");
    expect(guard.isTripped()).toBe(true);
  });

  it("further record calls are no-ops after trip", () => {
    const guard = createRolloutGuard({
      flag: "fieldLevelExportAuth",
      riskTier: "critical",
      percentage: 100,
      minSamples: 100
    });

    guard.recordFailure("f1");
    guard.recordFailure("f2");
    const firstReport = guard.recordFailure("f3");

    // Additional calls should not change metrics or return new reports
    const secondReport = guard.recordFailure("f4");
    expect(secondReport).toEqual(firstReport);

    guard.recordSuccess();
    expect(guard.getMetrics().successes).toBe(0); // success ignored once tripped
  });

  it("isEnabled returns false once guard is tripped", () => {
    const guard = createRolloutGuard({
      flag: "safeOwnershipTransfer",
      riskTier: "critical",
      percentage: 100,
      minSamples: 100
    });

    guard.recordFailure("f1");
    guard.recordFailure("f2");
    guard.recordFailure("f3");

    expect(guard.isEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manual rollback
// ---------------------------------------------------------------------------
describe("RolloutGuard – manual rollback", () => {
  it("supports manual rollback by a named actor", () => {
    const guard = createRolloutGuard({
      flag: "policySimulationPreview",
      riskTier: "medium",
      percentage: 100
    });

    const report = guard.manualRollback("Security incident response", "security-team");

    expect(report.rollbackTriggered).toBe(true);
    expect(report.triggeredBy).toBe("security-team");
    expect(report.triggerReason).toBe("Security incident response");
    expect(report.postRollbackFlagDisabled).toBe(true);
    expect(guard.isTripped()).toBe(true);
  });

  it("invokes onRollback callback on each manual rollback call", () => {
    const onRollback = vi.fn();
    const guard = createRolloutGuard(
      { flag: "contributorDiagnostics", riskTier: "low", percentage: 100 },
      { onRollback }
    );

    guard.manualRollback("test rollback");
    // manualRollback is intentionally idempotent at the kill-switch level
    // but the callback fires on each explicit call to surface duplicate invocations.
    guard.manualRollback("second explicit call by operator");

    expect(onRollback).toHaveBeenCalledTimes(2);
    expect(guard.isTripped()).toBe(true);
  });

  it("stores the rollback report as last report", () => {
    const guard = createRolloutGuard({
      flag: "detailedFriendbotClassification",
      riskTier: "low",
      percentage: 100
    });

    guard.manualRollback("planned maintenance");
    const report = guard.getLastRollbackReport();

    expect(report).not.toBeNull();
    expect(report!.flag).toBe("detailedFriendbotClassification");
    expect(report!.triggeredAt).toBeTruthy();
    expect(report!.correlationId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// State consistency checks
// ---------------------------------------------------------------------------
describe("RolloutGuard – state consistency and remediation", () => {
  it("reports stateConsistent true when no violations exist", () => {
    const state = { balance: 100, locked: false };
    const guard = createRolloutGuard(
      { flag: "fieldLevelExportAuth", riskTier: "high", percentage: 100, minSamples: 100 },
      {
        stateProvider: () => state,
        consistencyChecks: [
          {
            name: "balance-positive",
            description: "Balance must be non-negative",
            check: (s) => ({ valid: (s as typeof state).balance >= 0 })
          }
        ]
      }
    );

    guard.recordFailure("f1");
    guard.recordFailure("f2");
    const report = guard.recordFailure("f3");

    expect(report!.stateConsistent).toBe(true);
    expect(report!.violations).toHaveLength(0);
    expect(report!.remediationsApplied).toHaveLength(0);
  });

  it("reports violations and applies remediation", () => {
    const state = { balance: -50, locked: true };
    const guard = createRolloutGuard(
      { flag: "safeOwnershipTransfer", riskTier: "critical", percentage: 100, minSamples: 100 },
      {
        stateProvider: () => state,
        consistencyChecks: [
          {
            name: "balance-non-negative",
            description: "Balance must be >= 0",
            check: (s) => ({
              valid: (s as typeof state).balance >= 0,
              violation: `Balance is ${(s as typeof state).balance}`
            }),
            remediate: (s) => {
              (s as typeof state).balance = 0;
              return { remediated: true, details: "Balance reset to 0" };
            }
          }
        ]
      }
    );

    guard.recordFailure("f1");
    guard.recordFailure("f2");
    const report = guard.recordFailure("f3");

    expect(report!.violations).toHaveLength(1);
    expect(report!.violations[0]).toContain("balance-non-negative");
    expect(report!.remediationsApplied).toHaveLength(1);
    expect(report!.stateConsistent).toBe(true); // violations.length === remediations.length
    expect(state.balance).toBe(0); // remediation mutated state
  });

  it("stateConsistent is false when violation has no remediation", () => {
    const state = { corrupted: true };
    const guard = createRolloutGuard(
      { flag: "policySimulationPreview", riskTier: "critical", percentage: 100, minSamples: 100 },
      {
        stateProvider: () => state,
        consistencyChecks: [
          {
            name: "not-corrupted",
            description: "Must not be corrupted",
            check: (s) => ({ valid: !(s as typeof state).corrupted, violation: "data corrupted" })
            // no remediate function
          }
        ]
      }
    );

    guard.recordFailure("f1");
    guard.recordFailure("f2");
    const report = guard.recordFailure("f3");

    expect(report!.violations).toHaveLength(1);
    expect(report!.remediationsApplied).toHaveLength(0);
    expect(report!.stateConsistent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authorization paths — allowlist / blocklist / network
// ---------------------------------------------------------------------------
describe("RolloutGuard – authorization paths", () => {
  it("allows allowlisted subjects even at 0% rollout", () => {
    const guard = createRolloutGuard({
      flag: "policySimulationPreview",
      riskTier: "low",
      percentage: 0,
      allowlist: ["INTERNAL_QA"]
    });

    expect(guard.isEnabled({ subjectId: "INTERNAL_QA" })).toBe(true);
    expect(guard.isEnabled({ subjectId: "regular-user" })).toBe(false);
  });

  it("blocks blocklisted subjects even at 100% rollout", () => {
    const guard = createRolloutGuard({
      flag: "contributorDiagnostics",
      riskTier: "low",
      percentage: 100,
      blocklist: ["BANNED_ACTOR"]
    });

    expect(guard.isEnabled({ subjectId: "BANNED_ACTOR" })).toBe(false);
    expect(guard.isEnabled({ subjectId: "normal-user" })).toBe(true);
  });

  it("enforces network targeting", () => {
    const guard = createRolloutGuard({
      flag: "safeOwnershipTransfer",
      riskTier: "medium",
      percentage: 100,
      allowedNetworks: ["testnet"]
    });

    expect(guard.isEnabled({ network: "testnet" })).toBe(true);
    expect(guard.isEnabled({ network: "mainnet" })).toBe(false);
  });

  it("custom now function is used in rollback timestamp", () => {
    const fixedDate = new Date("2025-01-15T12:00:00.000Z");
    const guard = createRolloutGuard(
      { flag: "fieldLevelExportAuth", riskTier: "low", percentage: 100 },
      { now: () => fixedDate }
    );

    const report = guard.manualRollback("scheduled drill");
    expect(report.triggeredAt).toBe(fixedDate.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Recovery: re-instantiate after trip
// ---------------------------------------------------------------------------
describe("RolloutGuard – recovery after rollback", () => {
  it("old guard stays tripped; new guard on fresh engine is operational", () => {
    const guard = createRolloutGuard({
      flag: "detailedFriendbotClassification",
      riskTier: "critical",
      percentage: 100,
      minSamples: 100
    });

    guard.recordFailure("f1");
    guard.recordFailure("f2");
    guard.recordFailure("f3");
    expect(guard.isTripped()).toBe(true);

    // Simulate recovery: reset engine, re-instantiate guard
    resetRolloutEngine();
    const recoveredGuard = createRolloutGuard({
      flag: "detailedFriendbotClassification",
      riskTier: "critical",
      percentage: 100,
      minSamples: 100
    });

    expect(recoveredGuard.isTripped()).toBe(false);
    expect(recoveredGuard.isEnabled()).toBe(true);
    expect(guard.isTripped()).toBe(true); // old guard unchanged
  });
});
