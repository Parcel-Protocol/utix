/**
 * Maintainer policy simulation tool (#189).
 *
 * Wraps the read-only `PolicySimulator` (#234) with what a maintainer-facing
 * entry point needs: a permission gate, validation of the policy and of the
 * selected records, and an explanation of the outcome, with the affected
 * records grouped, ranked and capped to a few examples.
 *
 * Nothing is written. The policy and the records are only read, so running a
 * simulation against production data cannot change it.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission, type Permission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";
import { PolicySimulator } from "./simulation.ts";
import type {
  PolicyDefinition,
  PolicyImpactSeverity,
  PolicySimulationReport,
  SimulationTargetRecord
} from "./types.ts";

export const POLICY_SIMULATION_PERMISSION: Permission = "admin:config";

export const DEFAULT_MAX_EXAMPLES = 5;

/** Share of evaluated records above which an impact counts as broad. */
export const BROAD_IMPACT_RATIO = 0.3;

const SCOPES = ["accounts", "transactions", "soroban", "quota", "network", "global"];
const RECORD_TYPES = ["account", "transaction", "job", "quota", "contract"];
const NON_NEGATIVE_PARAMETERS = ["maxBaseFeeStroops", "minMasterWeight", "maxAccountSubentries"];
const SEVERITY_RANK: Record<PolicyImpactSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type PolicySimulationErrorCode = "permission_denied" | "invalid_policy" | "invalid_records";

export type PolicyOutcome = "no_impact" | "limited_impact" | "broad_impact";

export interface RecordImpactDiff {
  readonly field: string;
  readonly before: unknown;
  readonly expectedImpact: string;
  readonly severity: PolicyImpactSeverity;
}

export interface PreviewFilter {
  readonly entityType?: SimulationTargetRecord["type"];
  readonly minSeverity?: PolicyImpactSeverity;
  readonly search?: string;
}

export interface AffectedRecordExample {
  readonly id: string;
  readonly entityType: SimulationTargetRecord["type"];
  /** The worst severity among this record's side effects. */
  readonly severity: PolicyImpactSeverity;
  readonly reasons: readonly string[];
  readonly diffs?: readonly RecordImpactDiff[];
  readonly riskScore?: number;
}

export type AffectedRecordPreview = AffectedRecordExample;

export interface PreviewSummary {
  readonly totalMatchingFilter: number;
  readonly bySeverity: Record<PolicyImpactSeverity, number>;
  readonly byEntityType: Record<string, number>;
}

export interface MaintainerSimulationRequest {
  readonly policy: PolicyDefinition;
  readonly records: readonly SimulationTargetRecord[];
  /** Simulate against only these records. Defaults to all of `records`. */
  readonly recordIds?: readonly string[];
  readonly maxExamples?: number;
  readonly now?: Date | number;
  readonly filter?: PreviewFilter;
  readonly includeDiffs?: boolean;
}

export interface MaintainerSimulationResult {
  readonly report: PolicySimulationReport;
  readonly outcome: PolicyOutcome;
  readonly summary: string;
  /** The most severe affected records, at most `maxExamples`. */
  readonly examples: readonly AffectedRecordExample[];
  readonly omittedExamples: number;
  readonly affectedRecordIds: readonly string[];
  /** Requested `recordIds` that matched no record. */
  readonly unmatchedRecordIds: readonly string[];
  readonly previewSummary?: PreviewSummary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function policyIssues(policy: unknown): string[] {
  if (!isObject(policy)) return ["policy must be an object"];
  const issues: string[] = [];
  if (!isNonEmptyString(policy.id)) issues.push("policy.id must be a non-empty string");
  if (!isNonEmptyString(policy.name)) issues.push("policy.name must be a non-empty string");
  if (!SCOPES.includes(policy.scope as string)) issues.push(`policy.scope must be one of ${SCOPES.join(", ")}`);
  if (!Number.isInteger(policy.version) || (policy.version as number) < 1) {
    issues.push("policy.version must be a positive integer");
  }
  if (!Array.isArray(policy.rules)) {
    issues.push("policy.rules must be an array");
  } else {
    const seen = new Set<unknown>();
    for (const rule of policy.rules) {
      const id = isObject(rule) ? rule.id : undefined;
      if (!isNonEmptyString(id)) issues.push("every rule needs a non-empty id");
      else if (seen.has(id)) issues.push(`duplicate rule id "${id}"`);
      seen.add(id);
    }
  }
  if (policy.parameters !== undefined) {
    if (!isObject(policy.parameters)) {
      issues.push("policy.parameters must be an object");
    } else {
      for (const name of NON_NEGATIVE_PARAMETERS) {
        const value = policy.parameters[name];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          issues.push(`parameters.${name} must be a non-negative number`);
        }
      }
      const ops = policy.parameters.disallowedOperations;
      if (ops !== undefined && (!Array.isArray(ops) || !ops.every(isNonEmptyString))) {
        issues.push("parameters.disallowedOperations must be an array of non-empty strings");
      }
    }
  }
  return issues;
}

function recordIssues(records: unknown): string[] {
  if (!Array.isArray(records)) return ["records must be an array"];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const id = isObject(record) ? record.id : undefined;
    if (!isNonEmptyString(id)) {
      issues.push("every record needs a non-empty id");
      continue;
    }
    if (seen.has(id)) issues.push(`duplicate record id "${id}"`);
    seen.add(id);
    if (!RECORD_TYPES.includes((record as Record<string, unknown>).type as string)) {
      issues.push(`record "${id}" has an unknown type`);
    }
    if (!isObject((record as Record<string, unknown>).attributes)) {
      issues.push(`record "${id}" needs an attributes object`);
    }
  }
  return issues;
}

function requestIssues(request: MaintainerSimulationRequest): string[] {
  const issues: string[] = [];
  if (request.recordIds !== undefined) {
    if (!Array.isArray(request.recordIds) || !request.recordIds.every(isNonEmptyString)) {
      issues.push("recordIds must be an array of non-empty strings");
    } else if (new Set(request.recordIds).size !== request.recordIds.length) {
      issues.push("recordIds must not contain duplicates");
    }
  }
  if (request.maxExamples !== undefined &&
      (!Number.isInteger(request.maxExamples) || request.maxExamples < 0)) {
    issues.push("maxExamples must be a non-negative integer");
  }
  const now = request.now instanceof Date ? request.now.getTime() : request.now;
  if (now !== undefined && (!Number.isFinite(now) || !Number.isSafeInteger(now))) {
    issues.push("now must be a valid Date or integer timestamp");
  }
  if (request.filter !== undefined) {
    if (!isObject(request.filter)) {
      issues.push("filter must be an object");
    } else {
      if (request.filter.entityType !== undefined && !RECORD_TYPES.includes(request.filter.entityType)) {
        issues.push(`filter.entityType must be one of ${RECORD_TYPES.join(", ")}`);
      }
      if (request.filter.minSeverity !== undefined && !(request.filter.minSeverity in SEVERITY_RANK)) {
        issues.push("filter.minSeverity must be one of low, medium, high, critical");
      }
    }
  }
  return issues;
}

function buildExamples(
  report: PolicySimulationReport,
  recordsMap: Map<string, SimulationTargetRecord>,
  options?: { filter?: PreviewFilter; includeDiffs?: boolean }
): { examples: AffectedRecordExample[]; previewSummary: PreviewSummary } {
  const byRecord = new Map<string, { example: AffectedRecordExample; diffs: RecordImpactDiff[] }>();

  for (const effect of report.sideEffects) {
    const existing = byRecord.get(effect.targetId);
    const reasons = [...(existing?.example.reasons ?? [])];
    if (!reasons.includes(effect.description)) reasons.push(effect.description);

    const record = recordsMap.get(effect.targetId);
    const diffs = existing ? [...existing.diffs] : [];

    if (options?.includeDiffs) {
      let beforeValue: unknown = undefined;
      let fieldName = "attributes";
      if (record?.attributes) {
        if ("feeStroops" in record.attributes && effect.description.toLowerCase().includes("fee")) {
          fieldName = "feeStroops";
          beforeValue = record.attributes.feeStroops;
        } else if ("operations" in record.attributes && effect.description.toLowerCase().includes("operation")) {
          fieldName = "operations";
          beforeValue = record.attributes.operations;
        } else {
          beforeValue = record.attributes;
        }
      }
      diffs.push({
        field: fieldName,
        before: beforeValue,
        expectedImpact: effect.description,
        severity: effect.severity
      });
    }

    const worstSeverity =
      existing && SEVERITY_RANK[existing.example.severity] >= SEVERITY_RANK[effect.severity]
        ? existing.example.severity
        : effect.severity;

    const riskScore = SEVERITY_RANK[worstSeverity] * 10 + reasons.length;

    byRecord.set(effect.targetId, {
      example: {
        id: effect.targetId,
        entityType: effect.entityType,
        severity: worstSeverity,
        reasons,
        diffs: options?.includeDiffs ? diffs : undefined,
        riskScore
      },
      diffs
    });
  }

  const allRecords = [...byRecord.values()].map((v) => v.example);

  const bySeverity: Record<PolicyImpactSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const byEntityType: Record<string, number> = {};

  for (const ex of allRecords) {
    bySeverity[ex.severity] = (bySeverity[ex.severity] ?? 0) + 1;
    byEntityType[ex.entityType] = (byEntityType[ex.entityType] ?? 0) + 1;
  }

  let filtered = allRecords;
  if (options?.filter) {
    const { entityType, minSeverity, search } = options.filter;
    filtered = filtered.filter((ex) => {
      if (entityType && ex.entityType !== entityType) return false;
      if (minSeverity && SEVERITY_RANK[ex.severity] < SEVERITY_RANK[minSeverity]) return false;
      if (search) {
        const needle = search.toLowerCase();
        const matchesId = ex.id.toLowerCase().includes(needle);
        const matchesReason = ex.reasons.some((r) => r.toLowerCase().includes(needle));
        if (!matchesId && !matchesReason) return false;
      }
      return true;
    });
  }

  filtered.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.riskScore ?? 0) - (a.riskScore ?? 0) ||
      a.id.localeCompare(b.id)
  );

  return {
    examples: filtered,
    previewSummary: {
      totalMatchingFilter: filtered.length,
      bySeverity,
      byEntityType
    }
  };
}

export function runPolicySimulation(
  auth: AuthContext,
  request: MaintainerSimulationRequest
): Result<MaintainerSimulationResult, PolicySimulationErrorCode, readonly string[]> {
  if (!hasPermission(auth.role, POLICY_SIMULATION_PERMISSION)) return err("permission_denied");

  const policyProblems = policyIssues(request.policy);
  if (policyProblems.length > 0) return err("invalid_policy", policyProblems);
  const recordProblems = recordIssues(request.records);
  if (recordProblems.length > 0) return err("invalid_records", recordProblems);
  const selectionProblems = requestIssues(request);
  if (selectionProblems.length > 0) return err("invalid_records", selectionProblems);

  const wanted = request.recordIds ? new Set(request.recordIds) : undefined;
  const selected = wanted ? request.records.filter((record) => wanted.has(record.id)) : request.records;
  const unmatchedRecordIds = wanted
    ? [...wanted].filter((id) => !request.records.some((record) => record.id === id))
    : [];

  const report = PolicySimulator.simulate(request.policy, selected, { now: request.now });
  const ratio = report.totalEvaluated > 0 ? report.totalAffected / report.totalEvaluated : 0;
  const outcome: PolicyOutcome =
    report.totalAffected === 0 ? "no_impact" : ratio > BROAD_IMPACT_RATIO ? "broad_impact" : "limited_impact";

  const recordsMap = new Map<string, SimulationTargetRecord>();
  for (const record of selected) recordsMap.set(record.id, record);

  const { examples: all, previewSummary } = buildExamples(report, recordsMap, {
    filter: request.filter,
    includeDiffs: request.includeDiffs ?? true
  });
  const maxExamples = Math.max(0, request.maxExamples ?? DEFAULT_MAX_EXAMPLES);
  const examples = all.slice(0, maxExamples);

  return ok({
    report,
    outcome,
    summary:
      `Policy "${request.policy.name}" v${request.policy.version} affects ${report.totalAffected} of ` +
      `${report.totalEvaluated} evaluated record(s) (${outcome.replace("_", " ")}); ` +
      `risk ${report.overallRiskLevel}, recommended action: ${report.executionPlan.recommendedAction}.`,
    examples,
    omittedExamples: all.length - examples.length,
    affectedRecordIds: all.map((example) => example.id),
    unmatchedRecordIds,
    previewSummary
  });
}

export function previewPolicyWithRecordDiffs(
  auth: AuthContext,
  request: MaintainerSimulationRequest
): Result<MaintainerSimulationResult, PolicySimulationErrorCode, readonly string[]> {
  return runPolicySimulation(auth, { ...request, includeDiffs: true });
}
