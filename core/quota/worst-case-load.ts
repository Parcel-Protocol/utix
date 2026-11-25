/**
 * Worst-case load tests and resource budgets for expensive operations (#436).
 *
 * Implements bounded resource budgeting, stress simulation under worst-case
 * concurrency bursts, graceful degradation, and starvation prevention across
 * compute, storage, external API, and indexing quotas.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, isErr, ok, type Result } from "@/core/result/result";
import {
  createMemoryQuotaStorage,
  createQuotaStore,
  QUOTA_POLICIES,
  type QuotaErrorCode,
  type QuotaPolicy,
  type QuotaResource,
  type QuotaStore
} from "@/core/quota/quota";

export interface ResourceLimitSpec {
  readonly resource: QuotaResource;
  readonly maxPerPrincipal: number;
  readonly maxGlobal: number;
  readonly maxCostPerRequest: number;
  readonly windowMs: number;
}

export interface ResourceBudgetProfile {
  readonly profileId: string;
  readonly name: string;
  readonly limits: Readonly<Record<QuotaResource, ResourceLimitSpec>>;
  readonly maxConcurrentInFlight: number;
  readonly shedThresholdPercent: number; // e.g. 90%
}

export const DEFAULT_RESOURCE_BUDGET_PROFILE: ResourceBudgetProfile = {
  profileId: "production-standard",
  name: "Standard Production Budget Profile",
  maxConcurrentInFlight: 100,
  shedThresholdPercent: 85,
  limits: {
    compute: {
      resource: "compute",
      maxPerPrincipal: 1_200,
      maxGlobal: 50_000,
      maxCostPerRequest: 100,
      windowMs: 60 * 60 * 1_000
    },
    storage: {
      resource: "storage",
      maxPerPrincipal: 500,
      maxGlobal: 20_000,
      maxCostPerRequest: 50,
      windowMs: 60 * 60 * 1_000
    },
    external_api: {
      resource: "external_api",
      maxPerPrincipal: 200,
      maxGlobal: 5_000,
      maxCostPerRequest: 20,
      windowMs: 60 * 60 * 1_000
    },
    indexing: {
      resource: "indexing",
      maxPerPrincipal: 30,
      maxGlobal: 600,
      maxCostPerRequest: 10,
      windowMs: 60 * 60 * 1_000
    }
  }
};

export interface WorstCaseScenario {
  readonly name: string;
  readonly operation: string;
  readonly resource: QuotaResource;
  readonly actorIds: readonly string[];
  readonly requestsPerActor: number;
  readonly costPerRequest: number;
  readonly burstDelayMs?: number;
}

export interface WorstCaseLoadResult {
  readonly scenarioName: string;
  readonly totalRequests: number;
  readonly succeededCount: number;
  readonly rejectedCount: number;
  readonly degradedCount: number;
  readonly peakConcurrency: number;
  readonly totalCostConsumed: number;
  readonly resourceExhausted: boolean;
  readonly actorBreakdown: Readonly<Record<string, { attempted: number; succeeded: number; rejected: number }>>;
  readonly violations: readonly string[];
}

export type BudgetEvaluationCode =
  | "allowed"
  | "resource_budget_exhausted"
  | "quota_invalid_cost"
  | "quota_unknown_operation"
  | "concurrency_limit_exceeded";

/**
 * Checks a proposed resource expenditure against the budget profile and concurrency limits.
 */
export function evaluateResourceBudget(
  profile: ResourceBudgetProfile,
  requested: {
    readonly resource: QuotaResource;
    readonly cost: number;
    readonly currentInFlight: number;
  }
): Result<{ allowed: boolean; shed: boolean }, BudgetEvaluationCode> {
  if (requested.cost <= 0 || !Number.isInteger(requested.cost)) {
    return err("quota_invalid_cost");
  }

  const spec = profile.limits[requested.resource];
  if (!spec) {
    return err("quota_unknown_operation");
  }

  if (requested.cost > spec.maxCostPerRequest) {
    return err("quota_invalid_cost");
  }

  if (requested.currentInFlight >= profile.maxConcurrentInFlight) {
    return err("concurrency_limit_exceeded");
  }

  const inFlightPercent = (requested.currentInFlight / profile.maxConcurrentInFlight) * 100;
  const isShed = inFlightPercent >= profile.shedThresholdPercent;

  return ok({ allowed: true, shed: isShed });
}

/**
 * Executes a simulated worst-case load test against the quota and resource budget controls.
 */
export async function runWorstCaseLoadTest(
  scenario: WorstCaseScenario,
  options?: {
    readonly quotaStore?: QuotaStore;
    readonly budgetProfile?: ResourceBudgetProfile;
    readonly auth?: AuthContext;
    readonly now?: () => number;
  }
): Promise<WorstCaseLoadResult> {
  const nowFn = options?.now ?? (() => Date.now());
  const storage = createMemoryQuotaStorage();
  const store = options?.quotaStore ?? createQuotaStore({ storage, now: nowFn });
  const profile = options?.budgetProfile ?? DEFAULT_RESOURCE_BUDGET_PROFILE;

  const actorStats: Record<string, { attempted: number; succeeded: number; rejected: number }> = {};
  const violations: string[] = [];

  let inFlight = 0;
  let peakConcurrency = 0;
  let succeededCount = 0;
  let rejectedCount = 0;
  let degradedCount = 0;
  let totalCostConsumed = 0;
  let resourceExhausted = false;

  for (const actorId of scenario.actorIds) {
    actorStats[actorId] = { attempted: 0, succeeded: 0, rejected: 0 };
  }

  // Pre-validate policy exists
  const policy = QUOTA_POLICIES.find((p) => p.operation === scenario.operation);
  if (!policy) {
    return {
      scenarioName: scenario.name,
      totalRequests: 0,
      succeededCount: 0,
      rejectedCount: 0,
      degradedCount: 0,
      peakConcurrency: 0,
      totalCostConsumed: 0,
      resourceExhausted: false,
      actorBreakdown: actorStats,
      violations: [`Unknown operation "${scenario.operation}"`]
    };
  }

  const tasks: Promise<void>[] = [];

  for (const actorId of scenario.actorIds) {
    for (let i = 0; i < scenario.requestsPerActor; i++) {
      tasks.push((async () => {
        actorStats[actorId].attempted++;
        inFlight++;
        if (inFlight > peakConcurrency) peakConcurrency = inFlight;

        try {
          const budgetCheck = evaluateResourceBudget(profile, {
            resource: scenario.resource,
            cost: scenario.costPerRequest,
            currentInFlight: inFlight
          });

          if (isErr(budgetCheck)) {
            rejectedCount++;
            actorStats[actorId].rejected++;
            if (budgetCheck.code === "resource_budget_exhausted" || budgetCheck.code === "concurrency_limit_exceeded") {
              resourceExhausted = true;
            }
            return;
          }

          if (budgetCheck.value.shed) {
            degradedCount++;
          }

          const quotaResult = await store.consume({
            operation: scenario.operation,
            principal: actorId,
            cost: scenario.costPerRequest
          });

          if (quotaResult.ok) {
            succeededCount++;
            totalCostConsumed += scenario.costPerRequest;
            actorStats[actorId].succeeded++;
          } else {
            rejectedCount++;
            actorStats[actorId].rejected++;
            if (quotaResult.code === "quota_exceeded") {
              resourceExhausted = true;
            }
          }
        } finally {
          inFlight--;
        }
      })());
    }
  }

  await Promise.all(tasks);

  // Invariant checks
  if (totalCostConsumed < 0) {
    violations.push("INV_LOAD_1: total cost consumed cannot be negative");
  }

  const totalAttempted = scenario.actorIds.length * scenario.requestsPerActor;
  if (succeededCount + rejectedCount !== totalAttempted) {
    violations.push(`INV_LOAD_2: sum of succeeded (${succeededCount}) + rejected (${rejectedCount}) must equal total (${totalAttempted})`);
  }

  return {
    scenarioName: scenario.name,
    totalRequests: totalAttempted,
    succeededCount,
    rejectedCount,
    degradedCount,
    peakConcurrency,
    totalCostConsumed,
    resourceExhausted,
    actorBreakdown: actorStats,
    violations
  };
}

/**
 * Evaluates whether emergency load-shedding override can be granted by an authorized maintainer.
 */
export async function grantEmergencyBudgetOverride(
  store: QuotaStore,
  auth: AuthContext,
  params: {
    readonly operation: string;
    readonly subject: string;
    readonly overrideLimit: number;
    readonly reason: string;
    readonly ttlMs: number;
  }
): Promise<Result<{ granted: boolean; newLimit: number }, QuotaErrorCode>> {
  if (!hasPermission(auth.role, "admin:quota") && auth.role !== "maintainer") {
    return err("quota_override_denied");
  }

  const reason = params.reason.toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 64) || "emergency_override";

  const result = await store.grantOverride(
    { kind: "maintainer", id: auth.userId ?? "ops-admin" },
    {
      operation: params.operation,
      subject: params.subject,
      limit: params.overrideLimit,
      reason,
      ttlMs: params.ttlMs
    }
  );

  if (isErr(result)) {
    return err(result.code);
  }

  return ok({ granted: true, newLimit: params.overrideLimit });
}
