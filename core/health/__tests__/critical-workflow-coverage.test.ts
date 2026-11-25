import { describe, expect, it } from "vitest";
import {
  authorizeCoverageRun,
  evaluateWorkflowCoverage,
  runWorkflowCoverage,
  WORKFLOW_SCENARIOS,
  type WorkflowScenario,
  type WorkflowScenarioEvidence
} from "../critical-workflow-coverage";
import { JOURNEY_IDS, type JourneyId } from "../journeys";

const ADMIN = { role: "service" } as const;
const VIEWER = { role: "viewer" } as const;
const NOW_MS = Date.parse("2026-11-22T12:00:00.000Z");
const now = () => NOW_MS;

function evidence(
  journey: JourneyId,
  scenario: WorkflowScenario,
  passed = true,
  code?: string
): WorkflowScenarioEvidence {
  return {
    journey,
    scenario,
    passed,
    ...(code ? { code } : {}),
    observedAt: new Date(NOW_MS).toISOString()
  };
}

function completeEvidence(passed = true): WorkflowScenarioEvidence[] {
  return JOURNEY_IDS.flatMap((journey) =>
    WORKFLOW_SCENARIOS.map((scenario) => evidence(journey, scenario, passed))
  );
}

describe("Critical workflow coverage (#454)", () => {
  it("normal path: a fully evidenced catalogue is ready", () => {
    const report = evaluateWorkflowCoverage(completeEvidence(), { now });

    expect(report.ready).toBe(true);
    expect(report.criticalReady).toBe(true);
    expect(report.coveragePercent).toBe(100);
    expect(report.missing).toEqual([]);
    expect(report.generatedAt).toBe(new Date(NOW_MS).toISOString());
    expect(report.journeys).toHaveLength(JOURNEY_IDS.length);
    expect(
      report.journeys.every((item) => item.covered && item.scenarios.every((scenario) => scenario.passed))
    ).toBe(true);
  });

  it("failure path: missing critical evidence blocks readiness", () => {
    const partial = completeEvidence().filter(
      (item) => !(item.journey === "transaction-lookup" && item.scenario === "retry")
    );
    const report = evaluateWorkflowCoverage(partial, { now });

    expect(report.ready).toBe(false);
    expect(report.criticalReady).toBe(false);
    expect(report.missing).toContain("transaction-lookup:retry");
    expect(report.coveragePercent).toBeLessThan(100);
  });

  it("failure path: a non-critical gap degrades but does not block critical readiness", () => {
    const partial = completeEvidence().filter(
      (item) => !(item.journey === "fee-stats" && item.scenario === "failure")
    );
    const report = evaluateWorkflowCoverage(partial, { now });

    expect(report.ready).toBe(false);
    expect(report.criticalReady).toBe(true);
    expect(report.missing).toContain("fee-stats:failure");
  });

  it("retry path: the latest evidence for a scenario wins", () => {
    const pairs = completeEvidence().filter(
      (item) => !(item.journey === "account-balances" && item.scenario === "authorization")
    );
    pairs.push(evidence("account-balances", "authorization", false, "unauthorized"));
    pairs.push(evidence("account-balances", "authorization", true, "retried_ok"));

    const report = evaluateWorkflowCoverage(pairs, { now });
    const scenario = report.journeys
      .find((item) => item.journey === "account-balances")
      ?.scenarios.find((item) => item.scenario === "authorization");

    expect(report.ready).toBe(true);
    expect(scenario?.passed).toBe(true);
    expect(scenario?.evidence?.code).toBe("retried_ok");
  });

  it("authorization path: an unprivileged actor cannot start a run", async () => {
    const denied = authorizeCoverageRun(VIEWER);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("synthetic_unauthorized");

    let calls = 0;
    const result = await runWorkflowCoverage({
      auth: VIEWER,
      now,
      checks: [
        {
          journey: "fee-stats",
          scenario: "normal",
          run: () => {
            calls += 1;
            return { passed: true };
          }
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
    expect(authorizeCoverageRun(ADMIN).ok).toBe(true);
  });

  it("retry path: bounded attempts recover a transient failure and isolate a crash", async () => {
    let attempts = 0;
    const result = await runWorkflowCoverage({
      auth: ADMIN,
      now,
      maxAttempts: 3,
      journeys: ["fee-stats"],
      checks: [
        {
          journey: "fee-stats",
          scenario: "retry",
          run: () => {
            attempts += 1;
            return attempts < 3 ? { passed: false, code: "transient" } : { passed: true };
          }
        },
        {
          journey: "fee-stats",
          scenario: "normal",
          run: () => {
            throw new Error("probe bug");
          }
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(attempts).toBe(3);
    expect(result.value.ready).toBe(false);
    expect(result.value.missing).toContain("fee-stats:normal");

    const retry = result.value.journeys[0]?.scenarios.find((item) => item.scenario === "retry");
    const crashed = result.value.journeys[0]?.scenarios.find((item) => item.scenario === "normal");
    expect(retry?.passed).toBe(true);
    expect(crashed?.evidence?.code).toBe("check_crashed");
  });
});
