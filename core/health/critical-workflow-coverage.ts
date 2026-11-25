/**
 * Critical workflow coverage for synthetic monitoring (#454).
 *
 * `journeys.ts` runs the journeys and `workflow-monitor.ts` keeps alert state
 * across runs. Neither answers a different operational question: "are all of
 * the paths a user depends on actually exercised by our synthetic checks?"
 * A healthy rollup can hide the fact that the retry path or the authorization
 * denial of a critical journey has never been probed.
 *
 * This module is a small, pure coverage layer over the existing journey
 * catalogue. Every journey must have evidence for four scenarios:
 *
 * - `normal`        — the happy path returns a healthy result;
 * - `failure`       — a transport/contract failure is reported as unhealthy;
 * - `retry`         — a transient failure followed by a successful retry;
 * - `authorization` — an unprivileged actor is denied before any request.
 *
 * `evaluateWorkflowCoverage` derives a deterministic report from evidence;
 * `runWorkflowCoverage` executes injected checks with bounded retries and
 * isolates a throwing check so one broken probe cannot hide the rest of the
 * picture. Authorization is checked once, before any check runs, using the
 * same `admin:health` permission as the rest of the synthetic monitor.
 *
 * Nothing here changes an existing contract: reports are additive, the
 * journey ids come from `JOURNEYS`, and a caller that does not run coverage is
 * unaffected.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";
import { JOURNEY_IDS, JOURNEYS, type JourneyId } from "./journeys";

export const WORKFLOW_SCENARIOS = ["normal", "failure", "retry", "authorization"] as const;
export type WorkflowScenario = (typeof WORKFLOW_SCENARIOS)[number];

export const WORKFLOW_COVERAGE_VERSION = 1;

export type WorkflowCoverageErrorCode = "synthetic_unauthorized";

export interface WorkflowScenarioEvidence {
  readonly journey: JourneyId;
  readonly scenario: WorkflowScenario;
  readonly passed: boolean;
  readonly code?: string;
  readonly observedAt?: string;
  readonly correlationId?: string;
}

export interface ScenarioCoverage {
  readonly scenario: WorkflowScenario;
  readonly passed: boolean;
  readonly evidence?: WorkflowScenarioEvidence;
}

export interface JourneyCoverage {
  readonly journey: JourneyId;
  readonly tool: string;
  readonly critical: boolean;
  readonly covered: boolean;
  readonly scenarios: readonly ScenarioCoverage[];
}

export interface WorkflowCoverageReport {
  readonly version: typeof WORKFLOW_COVERAGE_VERSION;
  readonly generatedAt: string;
  readonly journeys: readonly JourneyCoverage[];
  /** `journey:scenario` keys with no passing evidence. */
  readonly missing: readonly string[];
  readonly coveragePercent: number;
  /** Every journey, critical or not, has passing evidence. */
  readonly ready: boolean;
  /** Every critical journey has passing evidence. */
  readonly criticalReady: boolean;
}

export interface WorkflowCoverageOptions {
  /** Defaults to the whole journey catalogue. */
  readonly journeys?: readonly JourneyId[];
  readonly now?: () => number;
}

function evidenceKey(journey: JourneyId, scenario: WorkflowScenario): string {
  return `${journey}:${scenario}`;
}

/**
 * Derive coverage from observed evidence. The last evidence item for a
 * journey/scenario pair wins, so a late passing retry supersedes an earlier
 * failed attempt without discarding the audit trail held by the caller.
 */
export function evaluateWorkflowCoverage(
  evidence: readonly WorkflowScenarioEvidence[],
  options: WorkflowCoverageOptions = {}
): WorkflowCoverageReport {
  const journeys: readonly JourneyId[] = options.journeys ?? JOURNEY_IDS;
  const now = options.now ?? (() => Date.now());
  const journeysCoverage: JourneyCoverage[] = [];
  const missing: string[] = [];
  let coveredScenarios = 0;
  let totalScenarios = 0;

  for (const journey of journeys) {
    const definition = JOURNEYS[journey];
    const scenarios: ScenarioCoverage[] = [];
    let journeyCovered = true;

    for (const scenario of WORKFLOW_SCENARIOS) {
      const matches = evidence.filter((item) => item.journey === journey && item.scenario === scenario);
      const latest = matches.at(-1);
      const passed = latest?.passed === true;
      totalScenarios += 1;
      if (passed) coveredScenarios += 1;
      else {
        journeyCovered = false;
        missing.push(evidenceKey(journey, scenario));
      }
      scenarios.push({
        scenario,
        passed,
        ...(latest ? { evidence: latest } : {})
      });
    }

    journeysCoverage.push({
      journey,
      tool: definition.tool,
      critical: definition.critical,
      covered: journeyCovered,
      scenarios
    });
  }

  return {
    version: WORKFLOW_COVERAGE_VERSION,
    generatedAt: new Date(now()).toISOString(),
    journeys: journeysCoverage,
    missing,
    coveragePercent: totalScenarios === 0 ? 100 : Math.round((coveredScenarios / totalScenarios) * 100),
    ready: missing.length === 0,
    criticalReady: journeysCoverage.every((item) => !item.critical || item.covered)
  };
}

/** Authorization gate shared by the coverage runner and its callers. */
export function authorizeCoverageRun(auth: AuthContext): Result<true, WorkflowCoverageErrorCode> {
  return hasPermission(auth.role, "admin:health") ? ok(true) : err("synthetic_unauthorized");
}

export interface WorkflowCheckOutcome {
  readonly passed: boolean;
  readonly code?: string;
  readonly correlationId?: string;
}

export interface WorkflowCoverageCheck {
  readonly journey: JourneyId;
  readonly scenario: WorkflowScenario;
  readonly run: () => WorkflowCheckOutcome | Promise<WorkflowCheckOutcome>;
}

export interface RunWorkflowCoverageOptions {
  readonly auth: AuthContext;
  readonly checks: readonly WorkflowCoverageCheck[];
  /** Bounded attempts per check; clamped to 1–5. Defaults to 2. */
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

/**
 * Execute injected checks and turn them into coverage evidence. Checks are
 * sequential, so a coverage run never bursts a rate limit, and a check that
 * throws is reported as a failed scenario rather than aborting the run.
 */
export async function runWorkflowCoverage(
  options: RunWorkflowCoverageOptions
): Promise<Result<WorkflowCoverageReport, WorkflowCoverageErrorCode>> {
  const authorized = authorizeCoverageRun(options.auth);
  if (!authorized.ok) return authorized;

  const maxAttempts = Math.max(1, Math.min(5, Math.floor(options.maxAttempts ?? 2)));
  const now = options.now ?? (() => Date.now());
  const evidence: WorkflowScenarioEvidence[] = [];

  for (const check of options.checks) {
    let outcome: WorkflowCheckOutcome = { passed: false, code: "check_not_run" };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        outcome = await check.run();
      } catch {
        outcome = { passed: false, code: "check_crashed" };
      }
      if (outcome.passed) break;
    }

    evidence.push({
      journey: check.journey,
      scenario: check.scenario,
      passed: outcome.passed,
      ...(outcome.code ? { code: outcome.code } : {}),
      observedAt: new Date(now()).toISOString(),
      ...(outcome.correlationId ? { correlationId: outcome.correlationId } : {})
    });
  }

  return ok(evaluateWorkflowCoverage(evidence, { now }));
}
